import { describe, expect, it, vi } from "vitest";

import { createBot, parseRewindCount } from "../src/bot.js";
import { RewindTerminalTimeoutError } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

function createConfig(): TeleCodexConfig {
  return {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "test-key",
    codexBackend: "sdk",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    toolVerbosity: "none",
    showTurnTokenUsage: false,
    enableTelegramReactions: false,
  };
}

function messageUpdate(text: string, messageId: number, updateId = messageId) {
  const commandLength = text.startsWith("/") ? text.split(/\s/, 1)[0]?.length : undefined;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
      ...(commandLength
        ? { entities: [{ offset: 0, length: commandLength, type: "bot_command" as const }] }
        : {}),
    },
  };
}

function callbackUpdate(data: string) {
  return {
    update_id: 99,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-instance",
      from: { id: 123, is_bot: false, first_name: "Ada" },
      data,
      message: {
        message_id: 100,
        date: 1_700_000_000,
        chat: { id: 123, type: "private" as const, first_name: "Ada" },
        text: "streaming",
      },
    },
  };
}

function createHarness(rewindError?: Error) {
  const sent: Array<{ text: string; messageId: number }> = [];
  const deleted: number[] = [];
  let nextBotMessageId = 1_000;
  const session = {
    getInfo: vi.fn(() => ({ threadId: "thread-main", workspace: "/workspace", model: "gpt-5.4" })),
    isProcessing: vi.fn(() => false),
    hasActiveThread: vi.fn(() => true),
    canSteer: vi.fn(() => false),
    prompt: vi.fn(async (_input, callbacks) => {
      callbacks.onTurnAccepted?.("turn-1");
      callbacks.onTextDelta("answer");
      callbacks.onHistoryWatermark?.("agent-1");
      callbacks.onAgentEnd();
    }),
    rewind: rewindError
      ? vi.fn(async () => { throw rewindError; })
      : vi.fn(async () => ({ rolledBackTurnIds: ["turn-1"] })),
    abort: vi.fn(async () => {}),
  };
  const registry = {
    onRemove: vi.fn(),
    getOrCreate: vi.fn(async () => session),
    get: vi.fn(() => session),
    resolveReplyRoute: vi.fn(() => undefined),
    updateMetadata: vi.fn(),
    markPastDelivered: vi.fn(),
    resetPastDelivered: vi.fn(),
    readPastTail: vi.fn(async () => ({
      text: "你（电脑）：earlier\n\nCodex：retained",
      lastItemId: "agent-retained",
      shownMessages: 2,
      omittedMessages: 0,
    })),
  };
  const bot = createBot(createConfig(), registry as never);
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "TeleCodex",
    username: "telecodex_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage") {
      const messageId = nextBotMessageId++;
      sent.push({ text: String((payload as { text?: string }).text ?? ""), messageId });
      return { ok: true, result: { message_id: messageId } };
    }
    if (method === "deleteMessage") {
      deleted.push(Number((payload as { message_id?: number }).message_id));
      return { ok: true, result: true };
    }
    return { ok: true, result: true };
  });
  return { bot, session, registry, sent, deleted };
}

describe("/rewind command", () => {
  it("defaults to one turn and accepts an explicit 1-20 range", () => {
    expect(parseRewindCount(undefined)).toBe(1);
    expect(parseRewindCount("")).toBe(1);
    expect(parseRewindCount(" 7 ")).toBe(7);
    expect(parseRewindCount("20")).toBe(20);
  });

  it("rejects invalid counts instead of clamping or rewinding all", () => {
    for (const value of ["0", "21", "-1", "1.5", "abc", "2 3"]) {
      expect(parseRewindCount(value)).toBeNull();
    }
  });

  it("rolls back exactly n, resets /past, and best-effort deletes the tracked round", async () => {
    const { bot, session, registry, sent, deleted } = createHarness();

    await bot.handleUpdate(messageUpdate("mistyped input", 10));
    await vi.waitFor(() => expect(sent.some((message) => message.text === "answer")).toBe(true));
    const answerMessageId = sent.find((message) => message.text === "answer")?.messageId;

    await bot.handleUpdate(messageUpdate("/rewind 1", 20));
    await vi.waitFor(() => expect(deleted.length).toBe(2));

    expect(session.rewind).toHaveBeenCalledWith(1);
    expect(registry.resetPastDelivered).toHaveBeenCalledWith("123");
    expect(registry.readPastTail).toHaveBeenCalledWith("123", { maxMessages: 2 });
    expect(deleted).toEqual(expect.arrayContaining([10, answerMessageId]));
    expect(deleted).not.toContain(20);
    expect(sent.at(-1)?.text).toContain("已回滚 1 轮");
    expect(sent.at(-1)?.text).toContain("Codex：retained");
  });

  it("keeps /past reset when an interrupted turn finalizes after rewind", async () => {
    const { bot, session, registry, sent } = createHarness();
    let signalTurnTerminal!: () => void;
    const turnTerminal = new Promise<void>((resolve) => {
      signalTurnTerminal = resolve;
    });
    let releaseLateFinalization!: () => void;
    const lateFinalizationAllowed = new Promise<void>((resolve) => {
      releaseLateFinalization = resolve;
    });

    session.prompt.mockImplementationOnce(async (_input, callbacks) => {
      callbacks.onTurnAccepted?.("turn-1");
      callbacks.onTextDelta("obsolete answer");
      callbacks.onHistoryWatermark?.("agent-obsolete");
      await turnTerminal;
      await lateFinalizationAllowed;
      callbacks.onAgentEnd();
    });
    session.rewind.mockImplementationOnce(async () => {
      signalTurnTerminal();
      return { rolledBackTurnIds: ["turn-1"] };
    });

    await bot.handleUpdate(messageUpdate("mistyped input", 10));
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());

    await bot.handleUpdate(messageUpdate("/rewind", 20));
    expect(registry.resetPastDelivered).toHaveBeenCalledWith("123");

    releaseLateFinalization();
    await vi.waitFor(() =>
      expect(sent.some((message) => message.text === "obsolete answer")).toBe(true),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registry.markPastDelivered).not.toHaveBeenCalled();
  });

  it("states that no rollback occurred when the interrupted turn misses the deadline", async () => {
    const { bot, registry, sent, deleted } = createHarness(new RewindTerminalTimeoutError(15_000));

    await bot.handleUpdate(messageUpdate("/rewind", 20));

    expect(sent.at(-1)?.text).toBe("当前轮次在 15 秒内未结束；未执行回滚。");
    expect(registry.resetPastDelivered).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("keeps the inline stop button interrupt-only", async () => {
    const { bot, session } = createHarness();

    await bot.handleUpdate(callbackUpdate("codex_abort:123"));

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.rewind).not.toHaveBeenCalled();
  });
});
