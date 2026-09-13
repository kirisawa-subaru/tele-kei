import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";

import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  sanitizeFilename,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import {
  collectArtifactReport,
  ensureOutDir,
  formatArtifactSummary,
  MAX_TELEGRAM_FILE_SIZE,
} from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  MAX_REWIND_TURNS,
  REWIND_TERMINAL_TIMEOUT_MS,
  RewindTerminalTimeoutError,
  type CodexPromptInput,
  type CodexSkill,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
} from "./codex-session.js";
import { checkAuthStatus } from "./codex-auth.js";
import type {
  AppServerStatusSnapshot,
  RateLimitWindowUsage,
} from "./app-server-status.js";
import { queryThread, queryThreads, type CodexThreadRecord } from "./codex-state.js";
import type { TeleCodexConfig, ToolVerbosity } from "./config.js";
import {
  contextKeyFromCtx,
  contextKeyFromMessage,
  isTopicContextKey,
  parseContextKey,
  type TelegramContextKey,
} from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import type {
  InjectResponse,
  InjectSubmit,
  SendInteractionRequest,
  SendInteractionResponse,
  SendInteractionSubmit,
  SendFileRequest,
  SendFileResponse,
  SendFileSubmit,
} from "./inject-server.js";
import { renderLatexFormulaImage } from "./latex-renderer.js";
import {
  planLatexMessageGroups,
  type LatexMessageGroup,
} from "./latex.js";
import type { CodexSessionApi, SessionRegistryApi } from "./session-api.js";
import type { ConversationPromptProvenance } from "./conversation-backend.js";
import { downloadTelegramFile } from "./telegram-file.js";
import { TurnMessageLedger } from "./turn-message-ledger.js";
import {
  TelegramDeliveryStore,
  type TextDelivery,
} from "./delivery-store.js";
import {
  TELEMOOD_CALLBACK_TTL_MS,
  type TelemoodAction,
  type TelemoodActionReceipt,
  type TelemoodInteractionReceipt,
} from "./telemood.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_COPY_TEXT_LIMIT = 256;
const EDIT_DEBOUNCE_MS = 1500;
const TRUSTED_TELEGRAM_REACTIONS = new Set(["👀", "👍", "❤", "🔥", "👏"]);
export const STREAMING_CHUNK_SIZE = 100;
export const TELEGRAM_RETRY_MAX_DELAY_SECONDS = Number.POSITIVE_INFINITY;
export const TELEGRAM_RETRY_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const INJECT_DRAIN_RETRY_MS = 1_000;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const THREAD_LIST_UNAVAILABLE_TEXT = "会话列表暂不可用，请稍后重试。";
export const SKILL_PENDING_TTL_MS = 15 * 60 * 1_000;
const SKILL_DESCRIPTION_LABEL_LIMIT = 48;

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
export type BotRuntimeOptions = {
  botKey?: string;
  deliveryStore?: TelegramDeliveryStore;
};
type KeyboardItem = { label: string; callbackData: string };
type KeyboardFooter = { label: string; callbackData: (page: number) => string };

type PendingSkillPicker = {
  generation: string;
  skills: CodexSkill[];
  buttons: KeyboardItem[];
  expiresAt: number;
};

type PendingSkillInvocation = {
  generation: string;
  skill: CodexSkill;
  expiresAt: number;
  claimed: boolean;
};

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

type QueuedTextPrompt = {
  ctx: Context;
  chatId: TelegramChatId;
  session: CodexSessionApi;
  text: string;
  rolloverAfter?: boolean;
  afterRolloverText?: string;
};

function paginateKeyboard(
  items: KeyboardItem[],
  page: number,
  prefix: string,
  footer?: KeyboardFooter,
): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  if (footer) {
    keyboard.row().text(footer.label, footer.callbackData(currentPage));
  }

  return keyboard;
}

function formatSkillButtonLabel(skill: CodexSkill): string {
  const description = (skill.shortDescription || skill.description).replace(/\s+/g, " ").trim();
  return description
    ? `${skill.name} — ${truncateSkillDescription(description)}`
    : skill.name;
}

function truncateSkillDescription(description: string): string {
  if (Array.from(description).length <= SKILL_DESCRIPTION_LABEL_LIMIT) {
    return description;
  }
  return `${Array.from(description).slice(0, SKILL_DESCRIPTION_LABEL_LIMIT - 1).join("")}…`;
}

function buildSkillKeyboard(picker: PendingSkillPicker, page: number): InlineKeyboard {
  return paginateKeyboard(picker.buttons, page, `skill:${picker.generation}`);
}

const SESSION_DETAILS_FOOTER: KeyboardFooter = {
  label: "显示",
  callbackData: (page) => `sess_show_${page}`,
};

export function buildSessionKeyboard(items: KeyboardItem[], page: number): InlineKeyboard {
  return paginateKeyboard(items, page, "sess", SESSION_DETAILS_FOOTER);
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run(task: () => Promise<void>): Promise<void> {
    const result = this.tail.catch(() => undefined).then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export async function createNewThreadInMainWorkspace(
  session: Pick<CodexSessionApi, "newThread">,
  mainWorkspace: string,
): Promise<CodexSessionInfo> {
  return session.newThread(mainWorkspace);
}

export function getSessionPage(sessions: CodexThreadRecord[], page: number): CodexThreadRecord[] {
  const totalPages = Math.max(1, Math.ceil(sessions.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  return sessions.slice(start, start + KEYBOARD_PAGE_SIZE);
}

export function renderSessionDetailsPage(
  sessions: Array<{ session: CodexThreadRecord; lastInput: string }>,
  page: number,
): string {
  const offset = Math.max(0, page) * KEYBOARD_PAGE_SIZE;
  return sessions
    .map(({ session, lastInput }, index) => {
      const name = session.name || session.title || session.firstUserMessage || "（未命名）";
      return [
        `${offset + index + 1}. ${session.updatedAt.toISOString()}`,
        `文件夹：${session.cwd}`,
        `名称：${name}`,
        `最后输入：${lastInput || "（无）"}`,
      ].join("\n");
    })
    .join("\n\n");
}

export type TeleCodexBot = Bot<Context> & {
  enqueueInjectedText: InjectSubmit;
  sendLocalFile: SendFileSubmit;
  sendInteraction: SendInteractionSubmit;
};

export function createBot(
  config: TeleCodexConfig,
  registry: SessionRegistryApi,
  runtimeOptions: BotRuntimeOptions = {},
): TeleCodexBot {
  const botKey = runtimeOptions.botKey ?? "main";
  const deliveryStore = runtimeOptions.deliveryStore;
  const telegramClient = {
    ...(config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {}),
    ...(config.telegramProxyUrl
      ? { baseFetchConfig: { agent: new HttpsProxyAgent(config.telegramProxyUrl) } }
      : {}),
  };
  const bot = new Bot<Context>(
    config.telegramBotToken,
    Object.keys(telegramClient).length > 0 ? { client: telegramClient } : undefined,
  );
  bot.api.config.use(autoRetry({
    maxRetryAttempts: TELEGRAM_RETRY_MAX_ATTEMPTS,
    maxDelaySeconds: TELEGRAM_RETRY_MAX_DELAY_SECONDS,
  }));

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transferring: boolean; rewinding: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionDetails = new Map<TelegramContextKey, CodexThreadRecord[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingSkillRequests = new Map<TelegramContextKey, string>();
  const pendingSkillPickers = new Map<TelegramContextKey, PendingSkillPicker>();
  const pendingSkillInvocations = new Map<TelegramContextKey, PendingSkillInvocation>();
  const queuedTextPrompts = new Map<TelegramContextKey, QueuedTextPrompt[]>();
  const drainingTextPrompts = new Set<TelegramContextKey>();
  const historyEpochs = new Map<TelegramContextKey, number>();
  const turnMessages = new TurnMessageLedger();
  const deliveredRichTurns = new Set<string>();
  const richReactionTargets = new Set<string>();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingSessionPicks.delete(key);
    pendingSessionDetails.delete(key);
    pendingSessionButtons.delete(key);
    pendingModelButtons.delete(key);
    pendingSkillRequests.delete(key);
    pendingSkillPickers.delete(key);
    pendingSkillInvocations.delete(key);
    queuedTextPrompts.delete(key);
    drainingTextPrompts.delete(key);
    historyEpochs.delete(key);
    turnMessages.removeContext(key);
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transferring: boolean; rewinding: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transferring: false, rewinding: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(
      state?.processing ||
      state?.switching ||
      state?.transferring ||
      state?.rewinding ||
      session?.isProcessing(),
    );
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionApi } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionApi): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearPendingSkillState = (contextKey: TelegramContextKey): void => {
    pendingSkillRequests.delete(contextKey);
    pendingSkillPickers.delete(contextKey);
    pendingSkillInvocations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
    footer?: KeyboardFooter,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix, footer);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      const targetKey = reactionTargetKey(chatId, messageId);
      if (emoji === "👍" && richReactionTargets.delete(targetKey)) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      if (richReactionTargets.delete(reactionTargetKey(chatId, messageId))) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const deleteTelegramMessageBestEffort = (
    chatId: TelegramChatId,
    messageId: number,
  ): void => {
    void bot.api.deleteMessage(chatId, messageId).catch(() => {});
  };

  const recordTurnMessage = (
    contextKey: TelegramContextKey,
    turnId: string,
    chatId: TelegramChatId,
    kind: "user" | "bot",
    messageId: number,
  ): void => {
    if (turnMessages.record(contextKey, turnId, chatId, kind, messageId)) {
      deleteTelegramMessageBestEffort(chatId, messageId);
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionApi,
    persistSession = true,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      if (persistSession) updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionApi,
    userInput: CodexPromptInput,
    options: {
      executionKey?: TelegramContextKey;
      persistSession?: boolean;
      abortable?: boolean;
      sourceMessageIds?: number[];
      onTurnAccepted?: (turnId: string) => void;
    } = {},
  ): Promise<boolean> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const executionKey = options.executionKey ?? contextKey;
    const persistSession = options.persistSession ?? true;
    const historyEpoch = historyEpochs.get(contextKey) ?? 0;
    const sourceMessageIds = options.sourceMessageIds ?? (
      ctx.message?.message_id ? [ctx.message.message_id] : []
    );

    if (isBusy(executionKey) || session.isProcessing()) {
      await sendBusyReply(ctx);
      return false;
    }

    const busyState = getBusyState(executionKey);
    busyState.processing = true;

    const abortKeyboard =
      options.abortable === false || session.supportsAbort?.() === false
        ? undefined
        : new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    const responseEditQueue = new SerialTaskQueue();
    let accumulatedText = "";
    let accumulatedCharacterCount = 0;
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastPublishedCharacterCount = 0;
    let lastEditAt = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let finalizePromise: Promise<void> | undefined;
    let historyWatermarkCandidate: string | undefined;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let acceptedTurnId: string | undefined;
    const pendingBotMessageIds: number[] = [];

    const trackBotMessage = (messageId: number): void => {
      if (acceptedTurnId) {
        recordTurnMessage(contextKey, acceptedTurnId, chatId, "bot", messageId);
      } else {
        pendingBotMessageIds.push(messageId);
      }
    };

    const sendTrackedTextMessage = async (
      text: string,
      textOptions: TextOptions = {},
    ): Promise<{ message_id: number }> => {
      const message = await sendTextMessage(bot.api, chatId, text, textOptions);
      trackBotMessage(message.message_id);
      return message;
    };

    const typingInterval = setInterval(() => {
      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
    }, TYPING_INTERVAL_MS);
    void bot.api
      .sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const renderPreview = (): RenderedChunk => {
      const previewText = buildStreamingPreview(accumulatedText);
      return renderMarkdownChunkWithinLimit(previewText);
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (!hasCompleteStreamingChunk(accumulatedCharacterCount, 0)) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        stopTyping();
        const publishedCharacterCount = accumulatedCharacterCount;
        const preview = renderPreview();
        const message = await sendTrackedTextMessage(preview.text, {
          parseMode: preview.parseMode,
          fallbackText: preview.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = preview.text;
        lastPublishedCharacterCount = publishedCharacterCount;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText) {
        return;
      }
      if (!responseMessageId) {
        await ensureResponseMessage();
        return;
      }
      if (!force && !hasCompleteStreamingChunk(accumulatedCharacterCount, lastPublishedCharacterCount)) {
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) {
        return;
      }

      const publishedCharacterCount = accumulatedCharacterCount;
      const nextText = renderPreview();
      if (nextText.text === lastRenderedText) {
        lastPublishedCharacterCount = publishedCharacterCount;
        return;
      }

      isFlushing = true;
      try {
        await responseEditQueue.run(() =>
          safeEditMessage(bot, chatId, responseMessageId!, nextText.text, {
            parseMode: nextText.parseMode,
            fallbackText: nextText.fallbackText,
            replyMarkup: abortKeyboard,
          }),
        );
        lastRenderedText = nextText.text;
        lastPublishedCharacterCount = publishedCharacterCount;
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (
        flushTimer ||
        finalized ||
        !hasCompleteStreamingChunk(accumulatedCharacterCount, lastPublishedCharacterCount)
      ) {
        return;
      }

      const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await bot.api.editMessageReplyMarkup(chatId, responseMessageId, {
          reply_markup: new InlineKeyboard(),
        });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await responseEditQueue.run(() =>
          safeEditMessage(bot, chatId, responseMessageId!, firstChunk.text, {
            parseMode: firstChunk.parseMode,
            fallbackText: firstChunk.fallbackText,
          }),
        );
        await removeAbortKeyboard();
      } else {
        const message = await sendTrackedTextMessage(firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTrackedTextMessage(chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
    };

    const buildLatexCopyKeyboard = (group: LatexMessageGroup): InlineKeyboard => {
      const keyboard = new InlineKeyboard();
      for (const formula of group.formulas) {
        if (Array.from(formula.copyText).length <= TELEGRAM_COPY_TEXT_LIMIT) {
          keyboard.copyText(`[${formula.number}]`, formula.copyText);
        } else {
          keyboard.text(`[${formula.number}]`, `latex_copy_limit:${formula.number}`);
        }
      }
      return keyboard;
    };

    const sendLatexPhoto = async (
      group: LatexMessageGroup,
      image: Awaited<ReturnType<typeof renderLatexFormulaImage>>,
      caption: RenderedText | null,
    ): Promise<void> => {
      const keyboard = buildLatexCopyKeyboard(group);
      const send = async (renderedCaption: RenderedText | null) => bot.api.sendPhoto(
        chatId,
        new InputFile(image.buffer, image.fileName),
        {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
          ...(renderedCaption?.text
            ? {
                caption: renderedCaption.text,
                ...(renderedCaption.parseMode ? { parse_mode: renderedCaption.parseMode } : {}),
                show_caption_above_media: true,
              }
            : {}),
          reply_markup: keyboard,
        },
      );

      let message;
      try {
        message = await send(caption);
      } catch (error) {
        if (!caption?.parseMode || !isTelegramParseError(error)) throw error;
        message = await send({
          text: caption.fallbackText,
          fallbackText: caption.fallbackText,
          parseMode: undefined,
        });
      }
      trackBotMessage(message.message_id);
    };

    const deliverLatexGroups = async (groups: LatexMessageGroup[]): Promise<void> => {
      for (const group of groups) {
        try {
          const image = await renderLatexFormulaImage(group.formulas);
          const caption = formatMarkdownMessage(group.markdown);
          const captionFits = Array.from(caption.fallbackText).length <= TELEGRAM_CAPTION_LIMIT;
          if (!captionFits && group.markdown) {
            await deliverRenderedChunks(splitMarkdownForTelegram(group.markdown));
          }
          await sendLatexPhoto(group, image, captionFits ? caption : null);
        } catch (error) {
          console.error("Failed to render or send LaTeX formula group:", error);
          await deliverRenderedChunks(splitMarkdownForTelegram(group.sourceMarkdown));
        }
      }
    };

    const discardStreamingPreviewForLatex = async (): Promise<void> => {
      if (!responseMessageId) return;
      const previewId = responseMessageId;
      responseMessageId = undefined;
      try {
        await bot.api.deleteMessage(chatId, previewId);
      } catch (error) {
        console.error("Failed to delete raw LaTeX streaming preview:", error);
        await safeEditMessage(bot, chatId, previewId, "<i>公式排版见下方。</i>", {
          fallbackText: "公式排版见下方。",
        }).catch((editError) => {
          console.error("Failed to replace raw LaTeX streaming preview:", editError);
        });
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalizePromise) return finalizePromise;
      const attempt = (async () => {
        finalized = true;

        stopTyping();
        clearFlushTimer();
        if (responseMessagePromise) {
          try {
            await responseMessagePromise;
          } catch {
            // If the initial send failed, we will fall back to sending the final response below.
          }
        }

        if (
          acceptedTurnId &&
          (deliveredRichTurns.has(richTurnKey(botKey, contextKey, acceptedTurnId)) ||
            deliveryStore?.hasDeliveredRichTurn?.(botKey, contextKey, acceptedTurnId))
        ) {
          await removeAbortKeyboard();
          return;
        }

        const finalText = buildFinalResponseText(accumulatedText);
        const latexGroups = finalText ? planLatexMessageGroups(finalText) : [];
        if (latexGroups.length > 0) {
          await discardStreamingPreviewForLatex();
          await deliverLatexGroups(latexGroups);
          return;
        }
        const chunks = finalText
          ? splitMarkdownForTelegram(finalText)
          : [{ text: "<b>✅ Done</b>", fallbackText: "✅ Done", parseMode: "HTML" as const, sourceText: "✅ Done" }];

        if (deliveryStore && acceptedTurnId) {
          const deliveryId = finalDeliveryId(botKey, contextKey, acceptedTurnId);
          const delivery = deliveryStore.stageText({
            deliveryId,
            botKey,
            contextKey,
            chatId,
            ...(messageThreadId ? { topicId: messageThreadId } : {}),
            ...(session.getInfo().threadId ? { threadId: session.getInfo().threadId! } : {}),
            turnId: acceptedTurnId,
            ...(historyWatermarkCandidate ? { historyItemId: historyWatermarkCandidate } : {}),
            ...(responseMessageId ? { anchorMessageId: responseMessageId } : {}),
            chunks: chunks.map((chunk) => ({
              text: chunk.text,
              fallbackText: chunk.fallbackText,
              parseMode: chunk.parseMode,
            })),
          });
          const messageIds = await deliverStoredText(bot, deliveryStore, delivery, trackBotMessage);
          responseMessageId ??= messageIds[0];
          await removeAbortKeyboard();
        } else {
          await deliverRenderedChunks(chunks);
        }
      })();
      finalizePromise = attempt;
      void attempt.catch(() => {
        if (finalizePromise === attempt) finalizePromise = undefined;
      });
      return finalizePromise;
    };

    const callbacks: CodexSessionCallbacks = {
      onTurnAccepted: (turnId) => {
        acceptedTurnId = turnId;
        for (const messageId of sourceMessageIds) {
          recordTurnMessage(contextKey, turnId, chatId, "user", messageId);
        }
        for (const messageId of pendingBotMessageIds.splice(0)) {
          recordTurnMessage(contextKey, turnId, chatId, "bot", messageId);
        }
        options.onTurnAccepted?.(turnId);
      },
      onTextDelta: (delta: string) => {
        accumulatedText += delta;
        accumulatedCharacterCount += countStreamingCharacters(delta);
        // Core/worker mode favors a durable final projection. A preview that is
        // sent before its Telegram message id is journaled can be orphaned by a
        // worker crash, so streaming remains a legacy/local-registry feature.
        if (deliveryStore) return;
        if (!hasCompleteStreamingChunk(accumulatedCharacterCount, lastPublishedCharacterCount)) {
          return;
        }
        if (!responseMessageId) {
          void ensureResponseMessage()
            .then(() => {
              scheduleFlush();
            })
            .catch((error) => {
              console.error("Failed to send initial Telegram response message", error);
            });
          return;
        }

        scheduleFlush();
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTrackedTextMessage(messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTrackedTextMessage(state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTrackedTextMessage(rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onHistoryWatermark: (itemId) => {
        historyWatermarkCandidate = itemId;
      },
      onAgentEnd: () => {
        void finalizeResponse().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    try {
      if (!(await ensureActiveThread(ctx, contextKey, session, persistSession))) {
        return false;
      }

      await session.prompt(withTelegramProvenance(ctx, userInput, botKey), callbacks);
      if (persistSession) updateSessionMetadata(contextKey, session);
      await finalizeResponse();
      if (
        persistSession &&
        historyWatermarkCandidate &&
        (historyEpochs.get(contextKey) ?? 0) === historyEpoch
      ) {
        await registry.markPastDelivered(contextKey, historyWatermarkCandidate);
      }
      return true;
    } catch (error) {
      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          if (deliveryStore && acceptedTurnId) {
            const delivery = deliveryStore.stageText({
              deliveryId: finalDeliveryId(botKey, contextKey, acceptedTurnId),
              botKey,
              contextKey,
              chatId,
              ...(messageThreadId ? { topicId: messageThreadId } : {}),
              ...(session.getInfo().threadId ? { threadId: session.getInfo().threadId! } : {}),
              turnId: acceptedTurnId,
              ...(historyWatermarkCandidate ? { historyItemId: historyWatermarkCandidate } : {}),
              ...(responseMessageId ? { anchorMessageId: responseMessageId } : {}),
              chunks: chunks.map((chunk) => ({
                text: chunk.text,
                fallbackText: chunk.fallbackText,
                parseMode: chunk.parseMode,
              })),
            });
            await deliverStoredText(bot, deliveryStore, delivery, trackBotMessage);
          } else {
            await deliverRenderedChunks(chunks);
          }
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
      return false;
    } finally {
      stopTyping();
      clearFlushTimer();
      busyState.processing = false;
      if (queuedTextPrompts.get(contextKey)?.length) {
        void drainTextPrompts(contextKey);
      }
    }
  };

  const runSkillPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionApi,
    skill: CodexSkill,
    text?: string,
  ): Promise<void> => {
    const input: CodexPromptInput = {
      skill: { name: skill.name, path: skill.path },
      ...(text ? { text } : {}),
    };

    if (session.canSteer()) {
      const steered = await session.steer(withTelegramProvenance(ctx, input, botKey));
      if (!steered) throw new Error("The active turn ended before the skill was accepted");
      updateSessionMetadata(contextKey, session);
      return;
    }

    await handleUserPrompt(ctx, contextKey, ctx.chat!.id, session, input);
  };

  const drainTextPrompts = async (contextKey: TelegramContextKey): Promise<void> => {
    if (drainingTextPrompts.has(contextKey)) {
      return;
    }
    if (isBusy(contextKey)) {
      const retry = setTimeout(() => void drainTextPrompts(contextKey), INJECT_DRAIN_RETRY_MS);
      retry.unref?.();
      return;
    }
    drainingTextPrompts.add(contextKey);

    try {
      while (true) {
        const queue = queuedTextPrompts.get(contextKey);
        if (!queue?.length) {
          queuedTextPrompts.delete(contextKey);
          return;
        }
        if (getBusyState(contextKey).rewinding) {
          return;
        }

        // Messages accumulated while Codex was answering belong to one human
        // speaking turn. Joining them avoids a mechanical answer per bubble.
        const rolloverIndex = queue.findIndex((entry) => entry.rolloverAfter === true);
        const batchSize = rolloverIndex === -1 ? queue.length : rolloverIndex + 1;
        const batch = queue.splice(0, batchSize);
        const latest = batch[batch.length - 1];
        const combinedText = batch.map((entry) => entry.text).join("\n\n");
        const sourceMessageIds = batch
          .map((entry) => entry.ctx.message?.message_id)
          .filter((messageId): messageId is number => Boolean(messageId));
        try {
          const completed = await handleUserPrompt(
            latest.ctx,
            contextKey,
            latest.chatId,
            latest.session,
            combinedText,
            {
              sourceMessageIds,
            },
          );
          if (!completed) {
            await Promise.all(batch.map((entry) => clearReaction(entry.ctx)));
            continue;
          }
          await Promise.all(batch.map((entry) => setReaction(entry.ctx, "👍")));

          if (batch.some((entry) => entry.rolloverAfter)) {
            const busyState = getBusyState(contextKey);
            let createdNewThread = false;
            busyState.switching = true;
            try {
              await createNewThreadInMainWorkspace(latest.session, config.workspace);
              updateSessionMetadata(contextKey, latest.session);
              createdNewThread = true;
              console.log(`Daily rollover created a new thread for ${botKey}/${contextKey}`);
            } catch (error) {
              const message = `每日换日失败：${friendlyErrorText(error)}`;
              console.error(message);
              await safeReply(latest.ctx, escapeHTML(message), { fallbackText: message });
            } finally {
              busyState.switching = false;
            }
            if (createdNewThread && latest.afterRolloverText) {
              const wroteFirstTurn = await handleUserPrompt(
                latest.ctx,
                contextKey,
                latest.chatId,
                latest.session,
                latest.afterRolloverText,
              );
              if (wroteFirstTurn) {
                console.log(`Daily rollover wrote the first turn for ${botKey}/${contextKey}`);
              } else {
                console.error(`Daily rollover first turn failed for ${botKey}/${contextKey}`);
              }
            }
          }
        } catch {
          await Promise.all(batch.map((entry) => clearReaction(entry.ctx)));
        }
      }
    } finally {
      drainingTextPrompts.delete(contextKey);
      if (queuedTextPrompts.get(contextKey)?.length && !getBusyState(contextKey).rewinding) {
        void drainTextPrompts(contextKey);
      }
    }
  };

  const injectedContext = (chatId: number, topicId?: number): Context =>
    ({
      api: bot.api,
      chat: { id: chatId, type: "private" },
      ...(topicId !== undefined ? { message: { message_thread_id: topicId } } : {}),
    }) as unknown as Context;

  const enqueueInjectedText: InjectSubmit = async ({
    chatId,
    text,
    topicId,
    rollover,
    afterRolloverText,
  }): Promise<InjectResponse> => {
    if (!config.telegramAllowedUserIdSet.has(chatId)) {
      return { ok: false, error: `chat ${chatId} is not in this bot's allowlist` };
    }
    const rawText = text.trim();
    if (!rawText) return { ok: false, error: "Inject text is empty" };
    const userText = rawText.startsWith("/") ? ` ${rawText}` : rawText;
    const rawAfterRolloverText = afterRolloverText?.trim();
    if (afterRolloverText !== undefined && !rawAfterRolloverText) {
      return { ok: false, error: "Inject after-rollover text is empty" };
    }
    if (rawAfterRolloverText && !rollover) {
      return { ok: false, error: "Inject after-rollover text requires rollover" };
    }
    const userAfterRolloverText = rawAfterRolloverText?.startsWith("/")
      ? ` ${rawAfterRolloverText}`
      : rawAfterRolloverText;
    const contextKey = contextKeyFromMessage(chatId, topicId);

    let session: CodexSessionApi;
    try {
      session = await registry.getOrCreate(contextKey);
    } catch (error) {
      return { ok: false, error: `Failed to resolve the session: ${friendlyErrorText(error)}` };
    }

    const queue = queuedTextPrompts.get(contextKey) ?? [];
    queue.push({
      ctx: injectedContext(chatId, topicId),
      chatId,
      session,
      text: userText,
      ...(rollover ? { rolloverAfter: true } : {}),
      ...(userAfterRolloverText ? { afterRolloverText: userAfterRolloverText } : {}),
    });
    queuedTextPrompts.set(contextKey, queue);
    void drainTextPrompts(contextKey);
    console.log(
      `inject queued bot=${botKey} context=${contextKey} bytes=${Buffer.byteLength(userText, "utf8")}` +
        (rollover ? " rollover=true" : "") +
        (userAfterRolloverText
          ? ` after_rollover_bytes=${Buffer.byteLength(userAfterRolloverText, "utf8")}`
          : ""),
    );
    return { ok: true, queued: true, contextKey, rollover: Boolean(rollover) };
  };

  const sendLocalFile: SendFileSubmit = async (
    request: SendFileRequest,
  ): Promise<SendFileResponse> => {
    if (!config.telegramAllowedUserIdSet.has(request.chatId)) {
      return { ok: false, error: `chat ${request.chatId} is not in this bot's allowlist` };
    }

    const contextKey = contextKeyFromMessage(request.chatId, request.topicId);
    let session: CodexSessionApi;
    try {
      session = registry.get(contextKey) ?? await registry.getOrCreate(contextKey, {
        deferThreadStart: true,
      });
    } catch (error) {
      return { ok: false, error: `Failed to resolve the session: ${friendlyErrorText(error)}` };
    }
    if (session.getInfo().threadId !== request.threadId) {
      return { ok: false, error: "This Codex thread does not own the Telegram context" };
    }
    if (!path.isAbsolute(request.filePath)) {
      return { ok: false, error: "File path must be absolute" };
    }
    if (request.caption && request.caption.length > TELEGRAM_CAPTION_LIMIT) {
      return { ok: false, error: `Caption exceeds ${TELEGRAM_CAPTION_LIMIT} characters` };
    }

    try {
      const canonicalPath = await realpath(request.filePath);
      const fileStat = await stat(canonicalPath);
      if (!fileStat.isFile()) return { ok: false, error: "Path is not a regular file" };
      if (fileStat.size > MAX_TELEGRAM_FILE_SIZE) {
        return { ok: false, error: "File exceeds Telegram's 50 MB upload limit" };
      }

      const fileName = sanitizeFilename(path.basename(canonicalPath));
      const telegramOptions = {
        ...(request.topicId ? { message_thread_id: request.topicId } : {}),
        ...(request.caption ? { caption: request.caption } : {}),
      };
      const mode = request.mode ?? "document";
      await bot.api
        .sendChatAction(
          request.chatId,
          mode === "photo" ? "upload_photo" : "upload_document",
          request.topicId ? { message_thread_id: request.topicId } : {},
        )
        .catch(() => {});
      const message = mode === "photo"
        ? await bot.api.sendPhoto(
            request.chatId,
            new InputFile(canonicalPath, fileName),
            telegramOptions,
          )
        : await bot.api.sendDocument(
            request.chatId,
            new InputFile(canonicalPath, fileName),
            telegramOptions,
          );
      console.log(
        `file sent bot=${botKey} context=${contextKey} thread=${request.threadId}` +
          ` bytes=${fileStat.size} name=${fileName}`,
      );
      return {
        ok: true,
        sent: true,
        chatId: request.chatId,
        messageId: message.message_id,
        fileName,
        ...(request.topicId ? { topicId: request.topicId } : {}),
      };
    } catch (error) {
      return { ok: false, error: `Failed to send file: ${friendlyErrorText(error)}` };
    }
  };

  const sendInteraction: SendInteractionSubmit = async (
    request: SendInteractionRequest,
  ): Promise<SendInteractionResponse> => {
    const authorizedUserId = request.userId ?? (request.chatId > 0 ? request.chatId : undefined);
    if (authorizedUserId && !config.telegramAllowedUserIdSet.has(authorizedUserId)) {
      return { ok: false, error: "The triggering Telegram user is not in this bot's allowlist" };
    }
    const contextKey = contextKeyFromMessage(request.chatId, request.topicId);
    let session: CodexSessionApi;
    try {
      session = registry.get(contextKey) ?? await registry.getOrCreate(contextKey, {
        deferThreadStart: true,
      });
    } catch (error) {
      return { ok: false, error: `Failed to resolve the session: ${friendlyErrorText(error)}` };
    }
    if (session.getInfo().threadId !== request.threadId) {
      return { ok: false, error: "This Codex thread does not own the Telegram context" };
    }

    const receipts: TelemoodActionReceipt[] = [];
    let visibleCompletion = false;
    for (const [actionIndex, action] of request.plan.actions.entries()) {
      const actionRequestId = `${request.requestId}:${actionIndex}`;
      const fail = (
        status: TelemoodActionReceipt["status"],
        detail: string,
      ): SendInteractionResponse => {
        const receipt = stoppedInteractionReceipt(
          request.requestId,
          request.plan.actions.length,
          actionIndex,
          action,
          receipts,
          status,
          detail,
        );
        return { ok: false, error: detail, receipt };
      };

      if (action.type === "sticker") {
        return fail("FAILED", "Sticker actions are unavailable until this bot has a trusted sticker catalog");
      }
      if (action.type === "reaction" && !request.triggerMessageId) {
        return fail("FAILED", "Reaction requires a trusted triggering Telegram message");
      }
      if (
        action.type === "reaction" &&
        !TRUSTED_TELEGRAM_REACTIONS.has(normalizeTelegramReaction(action.emoji))
      ) {
        return fail("FAILED", `Reaction ${action.emoji} is not in this bot's trusted reaction set`);
      }
      if (action.type === "choices" && !request.userId) {
        return fail("FAILED", "Choices require a trusted triggering Telegram user");
      }
      if (action.type === "choices" && !deliveryStore) {
        return fail("FAILED", "Choices require the durable Telegram callback store");
      }

      try {
        if (action.type === "reaction") {
          await bot.api.setMessageReaction(request.chatId, request.triggerMessageId!, [{
            type: "emoji",
            emoji: normalizeTelegramReaction(action.emoji) as never,
          }]);
          if (config.enableTelegramReactions) {
            richReactionTargets.add(reactionTargetKey(request.chatId, request.triggerMessageId!));
          }
          receipts.push(verifiedActionReceipt(actionRequestId, actionIndex, action));
          continue;
        }

        if (action.type === "bubble") {
          const chunks = splitMarkdownForTelegram(action.text);
          let messageIds: number[];
          if (deliveryStore) {
            const delivery = deliveryStore.stageText({
              deliveryId: richActionDeliveryId(
                botKey,
                contextKey,
                request.turnId,
                request.requestId,
                actionIndex,
              ),
              botKey,
              contextKey,
              chatId: request.chatId,
              ...(request.topicId ? { topicId: request.topicId } : {}),
              threadId: request.threadId,
              turnId: request.turnId,
              chunks: chunks.map((chunk) => ({
                text: chunk.text,
                fallbackText: chunk.fallbackText,
                parseMode: chunk.parseMode,
              })),
            });
            messageIds = await deliverStoredText(
              bot,
              deliveryStore,
              delivery,
              (messageId) => recordTurnMessage(
                contextKey,
                request.turnId,
                request.chatId,
                "bot",
                messageId,
              ),
            );
          } else {
            messageIds = [];
            for (const chunk of chunks) {
              const message = await sendTextMessage(bot.api, request.chatId, chunk.text, {
                parseMode: chunk.parseMode,
                fallbackText: chunk.fallbackText,
                messageThreadId: request.topicId,
              });
              messageIds.push(message.message_id);
              recordTurnMessage(contextKey, request.turnId, request.chatId, "bot", message.message_id);
            }
          }
          visibleCompletion = true;
          receipts.push(verifiedActionReceipt(
            actionRequestId,
            actionIndex,
            action,
            messageIds.join(","),
          ));
          continue;
        }

        const renderedPrompt = formatMarkdownMessage(action.prompt);
        if (renderedPrompt.text.length > TELEGRAM_MESSAGE_LIMIT) {
          return fail("FAILED", "Choices prompt exceeds Telegram's message limit");
        }
        if (action.options.some((option) => Array.from(option.label).length > 64)) {
          return fail("FAILED", "Choice labels must be at most 64 characters");
        }
        const expiresAt = Date.now() + TELEMOOD_CALLBACK_TTL_MS;
        const callbacks = action.options.map((option) => ({
          token: randomUUID().replaceAll("-", ""),
          requestId: actionRequestId,
          botKey,
          contextKey,
          userId: request.userId!,
          chatId: request.chatId,
          ...(request.topicId ? { topicId: request.topicId } : {}),
          threadId: request.threadId,
          turnId: request.turnId,
          prompt: action.prompt,
          optionKey: option.key,
          optionLabel: option.label,
          expiresAt,
        }));
        deliveryStore!.stageChoiceCallbacks(callbacks);
        const keyboard = new InlineKeyboard();
        callbacks.forEach((callback, index) => {
          keyboard.text(callback.optionLabel, `tm:${callback.token}`);
          if (index < callbacks.length - 1) keyboard.row();
        });
        let choiceMessage: { message_id: number };
        try {
          choiceMessage = await sendTextMessage(bot.api, request.chatId, renderedPrompt.text, {
            parseMode: renderedPrompt.parseMode,
            fallbackText: renderedPrompt.fallbackText,
            replyMarkup: keyboard,
            messageThreadId: request.topicId,
          });
        } catch (error) {
          deliveryStore!.revokeChoiceCallbacks(callbacks.map((callback) => callback.token));
          throw error;
        }
        try {
          deliveryStore!.activateChoiceCallbacks(
            callbacks.map((callback) => callback.token),
            choiceMessage.message_id,
          );
        } catch (error) {
          deliveryStore!.revokeChoiceCallbacks(callbacks.map((callback) => callback.token));
          return fail(
            "UNCERTAIN",
            `Choice message was delivered but callback activation failed: ${formatError(error)}`,
          );
        }
        recordTurnMessage(
          contextKey,
          request.turnId,
          request.chatId,
          "bot",
          choiceMessage.message_id,
        );
        visibleCompletion = true;
        receipts.push(verifiedActionReceipt(
          actionRequestId,
          actionIndex,
          action,
          String(choiceMessage.message_id),
          expiresAt / 1_000,
        ));
      } catch (error) {
        if (isDefiniteTelegramRejection(error)) {
          return fail("FAILED", `Telegram rejected the interaction: ${formatError(error)}`);
        }
        return fail(
          "UNCERTAIN",
          `Telegram outcome is uncertain; do not retry automatically: ${formatError(error)}`,
        );
      }
    }

    const receipt: TelemoodInteractionReceipt = {
      requestId: request.requestId,
      completed: true,
      visibleCompletion,
      receipts,
      unexecutedCount: 0,
    };
    if (visibleCompletion) {
      deliveredRichTurns.add(richTurnKey(botKey, contextKey, request.turnId));
      try {
        deliveryStore?.markRichTurnDelivered(botKey, contextKey, request.turnId);
      } catch (error) {
        const detail =
          `Visible Telegram output was delivered, but durable completion tracking is UNCERTAIN; ` +
          `do not retry automatically: ${formatError(error)}`;
        const lastIndex = receipts.length - 1;
        receipts[lastIndex] = {
          ...receipts[lastIndex],
          status: "UNCERTAIN",
          verifiedVisibleCompletion: false,
          detail,
        };
        return {
          ok: false,
          error: detail,
          receipt: {
            requestId: request.requestId,
            completed: false,
            visibleCompletion: true,
            receipts,
            stoppedAt: receipts[lastIndex].actionIndex,
            unexecutedCount: 0,
          },
        };
      }
    }
    console.log(
      `interaction sent bot=${botKey} context=${contextKey} thread=${request.threadId}` +
        ` turn=${request.turnId} actions=${receipts.length}`,
    );
    return { ok: true, receipt };
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat?.type === "private") {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.use(async (ctx, next) => {
    if (
      ctx.chat?.type !== "private" &&
      config.telegramGroupTriggerMode !== "all-authorized" &&
      !groupUpdateAddressesBot(ctx)
    ) {
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (text?.startsWith("/")) {
      const contextKey = contextKeyFromCtx(ctx);
      if (contextKey) clearPendingSkillState(contextKey);
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated
      ? undefined
      : "Not authenticated. Sign in with Codex on the computer.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await createNewThreadInMainWorkspace(session, config.workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command("compact", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, "当前 turn 仍在运行，结束后再 /compact。", { parseMode: undefined });
      return;
    }
    if (!session.hasActiveThread()) {
      await safeReply(ctx, "当前没有可 compact 的 thread。", { parseMode: undefined });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      await session.compactThread();
      await safeReply(ctx, "✅ 当前 thread 已完成 compact。", { parseMode: undefined });
    } catch (error) {
      const message = `Compact 未确认完成：${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command("rewind", async (ctx) => {
    const numTurns = parseRewindCount(ctx.match);
    if (numTurns === null) {
      await safeReply(ctx, `用法：/rewind [1-${MAX_REWIND_TURNS}]（默认 1）`, {
        parseMode: undefined,
      });
      return;
    }
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const busyState = getBusyState(contextKey);
    if (busyState.rewinding) {
      await safeReply(ctx, "正在回滚，请稍候。", { parseMode: undefined });
      return;
    }
    if (busyState.switching || busyState.transferring) {
      await safeReply(ctx, "当前正在切换会话或传输文件，未执行回滚。", { parseMode: undefined });
      return;
    }

    busyState.rewinding = true;
    historyEpochs.set(contextKey, (historyEpochs.get(contextKey) ?? 0) + 1);
    let rollbackCompleted = false;
    try {
      const result = await session.rewind(numTurns);
      rollbackCompleted = true;
      await registry.resetPastDelivered(contextKey);
      const targets = turnMessages.markRolledBack(contextKey, result.rolledBackTurnIds);
      for (const target of targets) {
        deleteTelegramMessageBestEffort(target.chatId, target.messageId);
      }

      let position = "（线程已回到开头）";
      try {
        const tail = await registry.readPastTail(contextKey, { maxMessages: 2 });
        if (tail.text) position = tail.text;
      } catch {
        position = "（回滚已完成，但暂时无法读取当前尾部）";
      }
      await safeReply(ctx, `已回滚 ${numTurns} 轮。\n\n当前对话停在：\n${position}`, {
        parseMode: undefined,
      });
    } catch (error) {
      if (rollbackCompleted) {
        console.error("Failed to report completed rewind:", formatError(error));
        return;
      }
      const message = error instanceof RewindTerminalTimeoutError
        ? `当前轮次在 ${Math.ceil(REWIND_TERMINAL_TIMEOUT_MS / 1_000)} 秒内未结束；未执行回滚。`
        : `回滚失败：${friendlyErrorText(error)}`;
      await safeReply(ctx, message, { parseMode: undefined });
    } finally {
      busyState.rewinding = false;
      if (queuedTextPrompts.get(contextKey)?.length) {
        void drainTextPrompts(contextKey);
      }
    }
  });

  bot.command("status", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const [authStatus, protocolStatus] = await Promise.all([
      checkAuthStatus(config.codexApiKey),
      registry.readProtocolStatus(session.isThreadAttached() ? info.threadId : null),
    ]);
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";
    const authLabel = authStatus.authenticated
      ? `authenticated (${authStatus.method})`
      : "not authenticated";

    const plainLines = [
      `${contextLabel}:`,
      `Bot: ${botKey}`,
      `Telegram: ${contextKey}`,
      renderSessionInfoPlain(info),
      ...renderProtocolStatusPlain(protocolStatus),
      `Auth: ${authLabel}`,
    ];
    const htmlLines = [
      `<b>${escapeHTML(contextLabel)}:</b>`,
      `<b>Bot:</b> <code>${escapeHTML(botKey)}</code>`,
      `<b>Telegram:</b> <code>${escapeHTML(contextKey)}</code>`,
      renderSessionInfoHTML(info),
      ...renderProtocolStatusHTML(protocolStatus),
      `<b>Auth:</b> <code>${escapeHTML(authLabel)}</code>`,
    ];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("past", async (ctx) => {
    const maxMessages = parsePastMessageCount(ctx.match);
    if (maxMessages === null) {
      await safeReply(ctx, "用法：/past [1-19]（默认 5）", { parseMode: undefined });
      return;
    }
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    const { contextKey } = contextSession;

    try {
      const history = await registry.readPast(contextKey, { maxMessages });
      const text = history.text || "没有尚未同步到 Telegram 的完整对话。";
      await safeReply(ctx, text, { parseMode: undefined });
      if (history.lastItemId) await registry.markPastDelivered(contextKey, history.lastItemId);
    } catch (error) {
      const message = `读取历史失败：${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    }
  });

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Stop it with the inline stop button first."), {
        fallbackText: "Cannot hand back while a prompt is running. Stop it with the inline stop button first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = await session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Thread released for Codex Desktop or CLI.",
        "",
        "Codex Desktop can now open the same task. Or run:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Thread released for Codex Desktop or CLI.</b>",
        "",
        "Codex Desktop can now open the same task. Or run:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    const threadQuery = queryThread(threadId);
    if (!threadQuery.available) {
      await safeReply(ctx, THREAD_LIST_UNAVAILABLE_TEXT, { parseMode: undefined });
      return;
    }

    if (!threadQuery.value) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown Codex thread: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown Codex thread: ${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached to thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Attached to thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command("switch", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch threads while a prompt is running."), {
        fallbackText: "Cannot switch threads while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/switch(?:@\w+)?\s*/, "").trim();
    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /switch <thread-id>"), {
        fallbackText: "Usage: /switch <thread-id>",
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Switched thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Switched thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command("view", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot browse threads while a prompt is running."), {
        fallbackText: "Cannot browse threads while a prompt is running.",
      });
      return;
    }

    const sessionsQuery = queryThreads(50);
    if (!sessionsQuery.available) {
      await safeReply(ctx, THREAD_LIST_UNAVAILABLE_TEXT, { parseMode: undefined });
      return;
    }

    const sessions = sessionsQuery.value;
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("No recent threads found."), {
        fallbackText: "No recent threads found.",
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );
    pendingSessionDetails.set(contextKey, orderedSessions);

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = buildSessionKeyboard(sessionButtons, 0);

    await safeReply(ctx, `<b>Recent threads</b> (${orderedSessions.length}):\nTap to switch.`, {
      fallbackText: `Recent threads (${orderedSessions.length}):\nTap to switch.`,
      replyMarkup: keyboard,
    });
  });

  bot.command("skill", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, "当前 turn 仍在运行，结束后再选择 skill。", { parseMode: undefined });
      return;
    }

    const generation = randomUUID().slice(0, 8);
    pendingSkillRequests.set(contextKey, generation);
    try {
      const skills = await session.listSkills();
      if (pendingSkillRequests.get(contextKey) !== generation) {
        return;
      }
      pendingSkillRequests.delete(contextKey);
      if (skills.length === 0) {
        await safeReply(ctx, "没有找到已启用的用户自定义 skill。", { parseMode: undefined });
        return;
      }

      const picker: PendingSkillPicker = {
        generation,
        skills,
        buttons: skills.map((skill, index) => ({
          label: formatSkillButtonLabel(skill),
          callbackData: `skill_pick:${generation}:${index}`,
        })),
        expiresAt: Date.now() + SKILL_PENDING_TTL_MS,
      };
      pendingSkillPickers.set(contextKey, picker);

      await safeReply(ctx, `<b>用户 Skills</b> (${skills.length})\n选择一个：`, {
        fallbackText: `用户 Skills (${skills.length})\n选择一个：`,
        replyMarkup: buildSkillKeyboard(picker, 0),
      });
    } catch (error) {
      if (pendingSkillRequests.get(contextKey) !== generation) {
        return;
      }
      pendingSkillRequests.delete(contextKey);
      const message = `读取 skills 失败：${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    }
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: `${model.displayName}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new threads:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new threads:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^tm:([a-f0-9]{32})$/, async (ctx) => {
    const token = ctx.match?.[1];
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const topicId = contextKey ? parseContextKey(contextKey).messageThreadId : undefined;
    if (!deliveryStore || !token || !contextKey || !chatId || !userId || !messageId) {
      await ctx.answerCallbackQuery({ text: "这个选择已经失效" });
      return;
    }

    const pending = deliveryStore.getChoiceCallback(token);
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const currentThreadId = contextSession?.session.getInfo().threadId;
    const belongsToCaller = Boolean(
      pending &&
      pending.botKey === botKey &&
      pending.userId === userId &&
      pending.chatId === chatId &&
      pending.topicId === topicId &&
      pending.threadId === currentThreadId,
    );
    if (belongsToCaller && isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "当前 turn 还在收尾，请稍后再点" });
      return;
    }

    const submissionKey = choiceSubmissionKey(botKey, chatId, messageId);
    const result = deliveryStore.claimChoiceCallback(token, {
      botKey,
      userId,
      chatId,
      ...(topicId ? { topicId } : {}),
      threadId: currentThreadId ?? "",
    }, submissionKey);
    if (!result.ok) {
      const text = result.reason === "expired"
        ? "这个选择已过期"
        : result.reason === "user_mismatch"
          ? "这个选择不是给你的"
          : result.reason === "pending"
            ? result.callback?.state === "claimed"
              ? "这个选择正在提交"
              : "这个选择还不能用"
            : "这个选择已经失效";
      await ctx.answerCallbackQuery({ text });
      if (belongsToCaller && result.reason !== "pending") {
        await bot.api.editMessageReplyMarkup(chatId, messageId, {
          reply_markup: new InlineKeyboard(),
        }).catch(() => {});
      }
      return;
    }

    const callback = result.callback;
    await ctx.answerCallbackQuery({ text: `✓ ${callback.optionLabel}` }).catch(() => {});

    if (!contextSession) {
      deliveryStore.releaseChoiceCallback(token, submissionKey);
      return;
    }
    let accepted = false;
    const prompt = `[Telegram choice selected]\noption_key: ${callback.optionKey}`;
    await handleUserPrompt(
      ctx,
      contextKey,
      chatId,
      contextSession.session,
      prompt,
      {
        sourceMessageIds: [],
        onTurnAccepted: () => {
          accepted = true;
          try {
            deliveryStore.completeChoiceCallback(token, submissionKey);
          } catch (error) {
            console.error(`Failed to finalize Telegram choice ${token}:`, error);
          }
          const selected = formatMarkdownMessage(`${callback.prompt}\n\n✓ ${callback.optionLabel}`);
          if (selected.text.length <= TELEGRAM_MESSAGE_LIMIT) {
            void safeEditMessage(bot, chatId, messageId, selected.text, {
              parseMode: selected.parseMode,
              fallbackText: selected.fallbackText,
              replyMarkup: new InlineKeyboard(),
            }).catch(() => {});
          } else {
            void bot.api.editMessageReplyMarkup(chatId, messageId, {
              reply_markup: new InlineKeyboard(),
            }).catch(() => {});
          }
        },
      },
    );
    if (!accepted) {
      const released = deliveryStore.releaseChoiceCallback(token, submissionKey);
      if (released) {
        await safeReply(ctx, "选择没有提交成功，请再点一次。", { parseMode: undefined });
      }
    }
  });

  bot.callbackQuery(/^latex_copy_limit:/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "这条公式超过 Telegram 的 256 字符剪贴板按钮上限。",
      show_alert: true,
    });
  });
  handlePageCallback(
    /^sess_page_(\d+)$/,
    "sess",
    pendingSessionButtons,
    "Expired, run /view again",
    SESSION_DETAILS_FOOTER,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");

  bot.callbackQuery(/^skill:([a-f0-9]+)_page_(\d+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const generation = ctx.match?.[1];
    const page = Number.parseInt(ctx.match?.[2] ?? "", 10);
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!contextKey || !generation || Number.isNaN(page) || !chatId || !messageId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const picker = pendingSkillPickers.get(contextKey);
    if (!picker || picker.generation !== generation || picker.expiresAt <= Date.now()) {
      if (picker?.generation === generation) pendingSkillPickers.delete(contextKey);
      await ctx.answerCallbackQuery({ text: "已过期，请重新运行 /skill" });
      return;
    }

    await ctx.answerCallbackQuery();
    try {
      await bot.api.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: buildSkillKeyboard(picker, page),
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        console.error("Failed to update skill keyboard page", error);
      }
    }
  });

  bot.callbackQuery(/^skill_pick:([a-f0-9]+):(\d+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const generation = ctx.match?.[1];
    const index = Number.parseInt(ctx.match?.[2] ?? "", 10);
    if (!contextKey || !generation || Number.isNaN(index)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const picker = pendingSkillPickers.get(contextKey);
    const skill =
      picker?.generation === generation && picker.expiresAt > Date.now()
        ? picker.skills[index]
        : undefined;
    if (!picker || !skill) {
      if (picker?.generation === generation) pendingSkillPickers.delete(contextKey);
      await ctx.answerCallbackQuery({ text: "已过期，请重新运行 /skill" });
      return;
    }
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "当前 turn 仍在运行" });
      return;
    }

    pendingSkillPickers.delete(contextKey);
    pendingSkillInvocations.set(contextKey, {
      generation,
      skill,
      expiresAt: Date.now() + SKILL_PENDING_TTL_MS,
      claimed: false,
    });
    await ctx.answerCallbackQuery({ text: `已选择 ${skill.name}` });

    const description = skill.description.trim() || skill.shortDescription?.trim() || "（无描述）";
    const keyboard = new InlineKeyboard()
      .text("直接运行", `skill_run:${generation}`)
      .text("取消", `skill_cancel:${generation}`);
    const html = [
      `<b>${escapeHTML(skill.name)}</b>`,
      escapeHTML(description),
      "",
      "下一条普通消息会作为参数，与这个 skill 一起发送。",
    ].join("\n");
    const plain = [skill.name, description, "", "下一条普通消息会作为参数，与这个 skill 一起发送。"].join("\n");
    await safeReply(ctx, html, { fallbackText: plain, replyMarkup: keyboard });
  });

  bot.callbackQuery(/^skill_run:([a-f0-9]+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const generation = ctx.match?.[1];
    if (!contextKey || !generation) {
      await ctx.answerCallbackQuery();
      return;
    }

    const pending = pendingSkillInvocations.get(contextKey);
    if (!pending || pending.generation !== generation || pending.expiresAt <= Date.now()) {
      if (pending?.generation === generation) pendingSkillInvocations.delete(contextKey);
      await ctx.answerCallbackQuery({ text: "已过期，请重新运行 /skill" });
      return;
    }
    if (pending.claimed) {
      await ctx.answerCallbackQuery({ text: "这个 skill 正在提交" });
      return;
    }
    pending.claimed = true;

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      if (pendingSkillInvocations.get(contextKey) === pending) pending.claimed = false;
      await ctx.answerCallbackQuery();
      return;
    }
    const { session } = contextSession;
    if (pendingSkillInvocations.get(contextKey) !== pending) {
      await ctx.answerCallbackQuery({ text: "已取消" });
      return;
    }
    if (isBusy(contextKey) && !session.canSteer()) {
      pending.claimed = false;
      await ctx.answerCallbackQuery({ text: "当前操作未结束，skill 选择仍保留" });
      return;
    }

    pendingSkillInvocations.delete(contextKey);
    await ctx.answerCallbackQuery({ text: "正在运行…" });
    const messageId = ctx.callbackQuery.message?.message_id;
    if (ctx.chat?.id && messageId) {
      await bot.api.editMessageReplyMarkup(ctx.chat.id, messageId, {
        reply_markup: new InlineKeyboard(),
      }).catch(() => {});
    }

    try {
      await runSkillPrompt(ctx, contextKey, session, pending.skill);
    } catch (error) {
      const message = `运行 skill 失败：${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    }
  });

  bot.callbackQuery(/^skill_cancel:([a-f0-9]+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const generation = ctx.match?.[1];
    if (!contextKey || !generation) {
      await ctx.answerCallbackQuery();
      return;
    }

    const pending = pendingSkillInvocations.get(contextKey);
    if (!pending || pending.generation !== generation || pending.expiresAt <= Date.now()) {
      if (pending?.generation === generation) pendingSkillInvocations.delete(contextKey);
      await ctx.answerCallbackQuery({ text: "已过期，请重新运行 /skill" });
      return;
    }
    if (pending.claimed) {
      await ctx.answerCallbackQuery({ text: "这个 skill 正在提交，无法取消" });
      return;
    }

    pendingSkillInvocations.delete(contextKey);
    await ctx.answerCallbackQuery({ text: "已取消" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId && messageId) {
      const html = `<b>已取消：</b> ${escapeHTML(pending.skill.name)}`;
      await safeEditMessage(bot, chatId, messageId, html, {
        fallbackText: `已取消：${pending.skill.name}`,
      });
    }
  });

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    if (session.supportsAbort?.() === false) {
      await ctx.answerCallbackQuery({ text: "Desktop relay turns must be stopped from Codex Desktop" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    try {
      await session.abort();
    } catch (error) {
      console.error("Failed to abort Codex turn:", formatError(error));
    }
  });

  bot.callbackQuery(/^sess_show_(\d+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
    if (!contextKey || Number.isNaN(page)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const sessions = pendingSessionDetails.get(contextKey);
    if (!sessions) {
      await ctx.answerCallbackQuery({ text: "Expired, run /view again" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在读取…" });
    const pageSessions = getSessionPage(sessions, page);
    const details = await Promise.all(
      pageSessions.map(async (session) => {
        try {
          return { session, lastInput: await registry.readLastInput(session.id) };
        } catch (error) {
          console.warn(`Failed to read last input for ${session.id}:`, error);
          return { session, lastInput: "（读取失败）" };
        }
      }),
    );
    await safeReply(ctx, renderSessionDetailsPage(details, page), { parseMode: undefined });
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /view again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    clearPendingSkillState(contextKey);
    pendingSessionPicks.delete(contextKey);
    pendingSessionDetails.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = await session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Model set to</b> <code>${escapeHTML(model)}</code> — applies to new threads.`;
      const plainText = `Model set to ${model} — applies to new threads.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText) {
      return;
    }
    if (userText.startsWith("/")) {
      await safeReply(ctx, "未知或已停用的命令。用 /help 查看当前命令。", { parseMode: undefined });
      return;
    }

    const replyContextKey = contextKeyFromCtx(ctx);
    const pendingSkill = replyContextKey
      ? pendingSkillInvocations.get(replyContextKey)
      : undefined;
    if (replyContextKey && pendingSkill) {
      if (pendingSkill.expiresAt <= Date.now()) {
        pendingSkillInvocations.delete(replyContextKey);
        await safeReply(ctx, "Skill 选择已过期；这条消息没有发送。请重新运行 /skill。", {
          parseMode: undefined,
        });
        return;
      }
      if (pendingSkill.claimed) {
        await safeReply(ctx, "这个 skill 正在提交；这条消息没有发送。", { parseMode: undefined });
        return;
      }
      pendingSkill.claimed = true;

      const contextSession = await getContextSession(ctx);
      if (!contextSession) {
        if (pendingSkillInvocations.get(replyContextKey) === pendingSkill) {
          pendingSkill.claimed = false;
        }
        return;
      }
      const { session } = contextSession;
      if (pendingSkillInvocations.get(replyContextKey) !== pendingSkill) {
        await safeReply(ctx, "Skill 选择已取消；这条消息没有发送。", { parseMode: undefined });
        return;
      }
      if (isBusy(replyContextKey) && !session.canSteer()) {
        pendingSkill.claimed = false;
        await safeReply(ctx, "当前操作未结束；skill 选择仍保留，结束后请重新发送参数。", {
          parseMode: undefined,
        });
        return;
      }

      pendingSkillInvocations.delete(replyContextKey);
      await setReaction(ctx, "👀");
      try {
        await runSkillPrompt(ctx, replyContextKey, session, pendingSkill.skill, userText);
        await setReaction(ctx, "👍");
      } catch (error) {
        await clearReaction(ctx);
        const message = `运行 skill 失败：${friendlyErrorText(error)}`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    const currentSession = replyContextKey ? registry.get(replyContextKey) : undefined;
    if (replyContextKey && isBusy(replyContextKey) && !currentSession?.canSteer()) {
      await safeReply(ctx, "当前操作未结束；这条消息没有发送，请稍后重发。", { parseMode: undefined });
      return;
    }

    const replyRoute = replyContextKey
      ? await registry.resolveReplyRoute(replyContextKey, ctx.message.reply_to_message?.message_id)
      : undefined;
    if (replyContextKey && replyRoute) {
      await setReaction(ctx, "👀");
      try {
        const replySession = await registry.getReplySession(replyRoute.threadId);
        const executionKey = `reply:${replyRoute.contextKey}:${replyRoute.messageId}:${replyRoute.threadId}`;
        if (replySession.canSteer()) {
          const steeredTurnId = await replySession.steer(withTelegramProvenance(ctx, userText, botKey));
          if (!steeredTurnId) throw new Error("The routed turn ended before the message was accepted");
          if (ctx.message.message_id) {
            recordTurnMessage(replyContextKey, steeredTurnId, ctx.chat.id, "user", ctx.message.message_id);
          }
        } else {
          await handleUserPrompt(
            ctx,
            replyContextKey,
            ctx.chat.id,
            replySession,
            userText,
            { executionKey, persistSession: false, abortable: false },
          );
        }
        await setReaction(ctx, "👍");
      } catch (error) {
        await clearReaction(ctx);
        await safeReply(ctx, escapeHTML(`回复路由失败：${friendlyErrorText(error)}`), {
          fallbackText: `回复路由失败：${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey) && !session.canSteer()) {
      await safeReply(ctx, "当前操作未结束；这条消息没有发送，请稍后重发。", { parseMode: undefined });
      return;
    }
    await setReaction(ctx, "👀");
    if (session.canSteer()) {
      try {
        const steeredTurnId = await session.steer(withTelegramProvenance(ctx, userText, botKey));
        if (!steeredTurnId) throw new Error("The active turn ended before the message was accepted");
        recordTurnMessage(contextKey, steeredTurnId, ctx.chat.id, "user", ctx.message.message_id);
        updateSessionMetadata(contextKey, session);
        await setReaction(ctx, "👍");
      } catch (error) {
        await clearReaction(ctx);
        await safeReply(ctx, escapeHTML(`追加消息失败：${friendlyErrorText(error)}`), {
          fallbackText: `追加消息失败：${friendlyErrorText(error)}`,
        });
      }
      return;
    }
    const queue = queuedTextPrompts.get(contextKey) ?? [];
    queue.push({ ctx, chatId: ctx.chat.id, session, text: userText });
    queuedTextPrompts.set(contextKey, queue);
    void drainTextPrompts(contextKey);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    await safeReply(ctx, "语音未启用，请发送文字。", { parseMode: undefined });
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transferring = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, {
        apiRoot: config.telegramApiRoot,
        proxyUrl: config.telegramProxyUrl,
        maxBytes: 20 * 1024 * 1024,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transferring = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
    }
    await setReaction(ctx, "👀");
    try {
      if (session.canSteer()) {
        const steeredTurnId = await session.steer(withTelegramProvenance(ctx, promptInput, botKey));
        if (!steeredTurnId) throw new Error("The active turn ended before the photo was accepted");
        recordTurnMessage(contextKey, steeredTurnId, chatId, "user", ctx.message.message_id);
        updateSessionMetadata(contextKey, session);
      } else {
        await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      }
      await setReaction(ctx, "👍");
    } catch (error) {
      await clearReaction(ctx);
      await safeReply(ctx, escapeHTML(`图片追加失败：${friendlyErrorText(error)}`), {
        fallbackText: `图片追加失败：${friendlyErrorText(error)}`,
      });
    } finally {
      await unlink(tempFilePath).catch(() => {});
    }
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transferring = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, {
        apiRoot: config.telegramApiRoot,
        proxyUrl: config.telegramProxyUrl,
        maxBytes: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transferring = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      try {
        await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
      } catch (artifactError) {
        console.error("Failed to deliver artifacts:", artifactError);
      } finally {
        await cleanupInbox(workspace, turnId);
        // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
      }
    }
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  const injectable = bot as TeleCodexBot;
  injectable.enqueueInjectedText = enqueueInjectedText;
  injectable.sendLocalFile = sendLocalFile;
  injectable.sendInteraction = sendInteraction;
  return injectable;
}

export async function recoverPendingDeliveries(
  bot: Bot<Context>,
  registry: SessionRegistryApi,
  store: TelegramDeliveryStore,
  botKey: string,
): Promise<{ recovered: number; failed: number }> {
  store.revokeDanglingPendingChoices(botKey);
  let recovered = 0;
  let failed = 0;
  for (const delivery of store.listPending(botKey)) {
    try {
      await deliverStoredText(bot, store, delivery);
      if (delivery.historyItemId) {
        const session = await registry.getOrCreate(delivery.contextKey, { deferThreadStart: true });
        if (!delivery.threadId || session.getInfo().threadId === delivery.threadId) {
          await registry.markPastDelivered(delivery.contextKey, delivery.historyItemId);
        }
      }
      recovered += 1;
    } catch (error) {
      failed += 1;
      console.error(`Failed to recover Telegram delivery ${delivery.deliveryId}:`, error);
    }
  }
  return { recovered, failed };
}

export async function deliverStoredText(
  bot: Bot<Context>,
  store: TelegramDeliveryStore,
  delivery: TextDelivery,
  onMessage?: (messageId: number) => void,
): Promise<number[]> {
  store.beginAttempt(delivery.deliveryId);
  const deliveredMessageIds: number[] = [];
  const parts = store.listParts(delivery.deliveryId);
  for (const part of parts) {
    if (part.state === "delivered" && part.telegramMessageId) {
      deliveredMessageIds.push(part.telegramMessageId);
      continue;
    }
    try {
      let messageId: number;
      if (part.partIndex === 0 && delivery.anchorMessageId) {
        await safeEditMessage(bot, delivery.chatId, delivery.anchorMessageId, part.text, {
          parseMode: part.parseMode,
          fallbackText: part.fallbackText,
        });
        messageId = delivery.anchorMessageId;
      } else {
        const message = await sendTextMessage(bot.api, delivery.chatId, part.text, {
          parseMode: part.parseMode,
          fallbackText: part.fallbackText,
          messageThreadId: delivery.topicId,
        });
        messageId = message.message_id;
      }
      store.markPartDelivered(delivery.deliveryId, part.partIndex, messageId);
      deliveredMessageIds.push(messageId);
      onMessage?.(messageId);
    } catch (error) {
      store.markPartFailed(delivery.deliveryId, part.partIndex, error);
      throw error;
    }
  }
  store.markDelivered(delivery.deliveryId);
  return deliveredMessageIds;
}

function finalDeliveryId(botKey: string, contextKey: string, turnId: string): string {
  return `telegram:${botKey}:${contextKey}:${turnId}:final`;
}

function richTurnKey(botKey: string, contextKey: string, turnId: string): string {
  return `${botKey}\u001f${contextKey}\u001f${turnId}`;
}

function richActionDeliveryId(
  botKey: string,
  contextKey: string,
  turnId: string,
  requestId: string,
  actionIndex: number,
): string {
  return `telegram:${botKey}:${contextKey}:${turnId}:interaction:${requestId}:${actionIndex}`;
}

function choiceSubmissionKey(botKey: string, chatId: TelegramChatId, messageId: number): string {
  return `telegram:${botKey}:${chatId}:${messageId}`;
}

function reactionTargetKey(chatId: TelegramChatId, messageId: number): string {
  return `${chatId}\u001f${messageId}`;
}

function normalizeTelegramReaction(emoji: string): string {
  return emoji.replaceAll("\ufe0f", "");
}

function verifiedActionReceipt(
  requestId: string,
  actionIndex: number,
  action: TelemoodAction,
  providerDeliveryId?: string,
  callbackExpiresAt?: number,
): TelemoodActionReceipt {
  return {
    requestId,
    actionIndex,
    actionType: action.type,
    status: "VERIFIED",
    blocking: action.type !== "reaction",
    verifiedVisibleCompletion: action.type !== "reaction",
    ...(providerDeliveryId ? { providerDeliveryId } : {}),
    ...(callbackExpiresAt ? { callbackExpiresAt } : {}),
  };
}

function stoppedInteractionReceipt(
  requestId: string,
  totalActions: number,
  actionIndex: number,
  action: TelemoodAction,
  priorReceipts: TelemoodActionReceipt[],
  status: TelemoodActionReceipt["status"],
  detail: string,
): TelemoodInteractionReceipt {
  return {
    requestId,
    completed: false,
    visibleCompletion: priorReceipts.some((receipt) => receipt.verifiedVisibleCompletion),
    receipts: [
      ...priorReceipts,
      {
        requestId: `${requestId}:${actionIndex}`,
        actionIndex,
        actionType: action.type,
        status,
        blocking: action.type !== "reaction",
        verifiedVisibleCompletion: false,
        detail,
      },
    ],
    stoppedAt: actionIndex,
    unexecutedCount: Math.max(0, totalActions - actionIndex - 1),
  };
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "past", description: "Show 1-19 unseen desktop messages (default 5)" },
    { command: "view", description: "Browse interactive and automation threads" },
    { command: "status", description: "Current thread details" },
    { command: "rewind", description: "Undo recent rounds" },
    { command: "skill", description: "Choose a skill for the next message" },
    { command: "new", description: "Start a new thread" },
    { command: "compact", description: "Compact the current thread" },
    { command: "model", description: "View and change model" },
    { command: "handback", description: "Hand thread to Codex CLI" },
    { command: "help", description: "Command reference" },
  ]);
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    info.model ? `Model: ${info.model}` : undefined,
    info.bindingMode === "desktop-relay" ? "Route: Desktop relay" : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.bindingMode === "desktop-relay" ? "<b>Route:</b> <code>Desktop relay</code>" : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

export function parsePastMessageCount(rawArgument: string | undefined): number | null {
  const argument = rawArgument?.trim() ?? "";
  if (!argument) {
    return 5;
  }
  if (!/^\d+$/.test(argument)) {
    return null;
  }

  const count = Number(argument);
  return Number.isSafeInteger(count) && count >= 1 && count < 20 ? count : null;
}

export function parseRewindCount(rawArgument: string | undefined): number | null {
  const argument = rawArgument?.trim() ?? "";
  if (!argument) return 1;
  if (!/^\d+$/.test(argument)) return null;

  const count = Number(argument);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_REWIND_TURNS
    ? count
    : null;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function renderProtocolStatusPlain(status: AppServerStatusSnapshot): string[] {
  return [
    `Weekly usage: ${formatRateLimitUsage(status.weeklyUsage)}`,
    status.fiveHourUsage ? `5h usage: ${formatRateLimitUsage(status.fiveHourUsage)}` : undefined,
    `Context: ${formatContextUsage(status)}`,
  ].filter((line): line is string => Boolean(line));
}

function renderProtocolStatusHTML(status: AppServerStatusSnapshot): string[] {
  return [
    `<b>Weekly usage:</b> <code>${escapeHTML(formatRateLimitUsage(status.weeklyUsage))}</code>`,
    status.fiveHourUsage
      ? `<b>5h usage:</b> <code>${escapeHTML(formatRateLimitUsage(status.fiveHourUsage))}</code>`
      : undefined,
    `<b>Context:</b> <code>${escapeHTML(formatContextUsage(status))}</code>`,
  ].filter((line): line is string => Boolean(line));
}

function formatRateLimitUsage(usage: RateLimitWindowUsage | undefined): string {
  if (!usage) return "unavailable";
  const reset = usage.resetsAt ? ` · resets ${formatResetTime(usage.resetsAt)}` : "";
  return `${formatPercentage(usage.usedPercent)}${reset}`;
}

function formatContextUsage(status: AppServerStatusSnapshot): string {
  if (!status.contextUsage) return "unavailable (not observed)";
  return `${formatCompactCount(status.contextUsage.contextTokens)} / ${formatCompactCount(status.contextUsage.modelContextWindow)}`;
}

function formatPercentage(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function formatCompactCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const divisor = value >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = divisor === 1_000_000 ? "m" : "k";
  return `${Number((value / divisor).toFixed(1))}${suffix}`;
}

function formatResetTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(unixSeconds * 1_000));
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = parseMode ? splitTelegramText(text) : splitTelegramPlainText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

export function splitTelegramPlainText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    const newlineIndex = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT - 1);
    const spaceIndex = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT - 1);
    const preferredIndex = Math.max(newlineIndex, spaceIndex);
    let cut = preferredIndex >= TELEGRAM_MESSAGE_LIMIT * 0.5
      ? preferredIndex + 1
      : TELEGRAM_MESSAGE_LIMIT;
    if (
      cut < remaining.length &&
      isHighSurrogate(remaining.charCodeAt(cut - 1)) &&
      isLowSurrogate(remaining.charCodeAt(cut))
    ) {
      cut -= 1;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

export function countStreamingCharacters(text: string): number {
  return Array.from(text).length;
}

export function hasCompleteStreamingChunk(
  accumulatedCharacterCount: number,
  lastPublishedCharacterCount: number,
): boolean {
  return accumulatedCharacterCount - lastPublishedCharacterCount >= STREAMING_CHUNK_SIZE;
}

function withTelegramProvenance(
  ctx: Context,
  input: CodexPromptInput,
  botKey = "main",
): CodexPromptInput {
  const triggerMessage = ctx.message ?? ctx.callbackQuery?.message;
  const telegramContextKey = contextKeyFromCtx(ctx);
  const messageThreadId = telegramContextKey
    ? parseContextKey(telegramContextKey).messageThreadId
    : undefined;
  const provenance: ConversationPromptProvenance = {
    transport: "telegram",
    botKey,
    senderTrust: "allowed-user-id",
    ...(ctx.from?.id ? { senderUserId: ctx.from.id } : {}),
    chatId: String(ctx.chat?.id ?? "unknown"),
    ...(triggerMessage?.message_id ? { messageId: triggerMessage.message_id } : {}),
    ...(messageThreadId ? { messageThreadId } : {}),
    messageKind: telegramMessageKind(ctx),
    forwarded: Boolean(ctx.message?.forward_origin),
  };

  return typeof input === "string"
    ? { text: input, provenance }
    : { ...input, provenance };
}

function telegramMessageKind(ctx: Context): ConversationPromptProvenance["messageKind"] {
  if (ctx.message?.photo) return "photo";
  if (ctx.message?.document) return "document";
  return "text";
}

export function groupUpdateAddressesBot(ctx: Context): boolean {
  if (ctx.callbackQuery) return true;
  const message = ctx.message;
  if (!message) return false;
  const text = "text" in message ? message.text : undefined;
  const caption = "caption" in message ? message.caption : undefined;
  const content = `${text ?? ""}\n${caption ?? ""}`;
  if (content.trimStart().startsWith("/")) return true;
  if (message.reply_to_message?.from?.id === ctx.me.id) return true;
  const username = ctx.me.username;
  return Boolean(username && new RegExp(`(^|\\s)@${escapeRegExp(username)}(?=\\s|$)`, "i").test(content));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function isDefiniteTelegramRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { error_code?: unknown };
  return typeof record.error_code === "number" &&
    record.error_code >= 400 &&
    record.error_code < 500 &&
    record.error_code !== 429;
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
