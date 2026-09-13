import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBot, type TeleCodexBot } from "../src/bot.js";
import type { CodexPromptInput, CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";
import { TelegramDeliveryStore } from "../src/delivery-store.js";

describe("Telemood Telegram integration", () => {
  let directory: string | undefined;
  let store: TelegramDeliveryStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("delivers ordered rich actions, suppresses the duplicate final, and consumes a choice once", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-telemood-"));
    store = new TelegramDeliveryStore(path.join(directory, "state.sqlite"));
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let bot!: TeleCodexBot;
    let promptCount = 0;
    const prompt = vi.fn(async (input: CodexPromptInput, callbacks: CodexSessionCallbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTurnAccepted?.("turn-rich");
        const result = await bot.sendInteraction({
          command: "send-interaction",
          requestId: "call-rich",
          threadId: "thread-1",
          turnId: "turn-rich",
          chatId: 123,
          triggerMessageId: 10,
          userId: 123,
          plan: {
            version: "telemood.plan.v1",
            actions: [
              { type: "reaction", target: "trigger_message", emoji: "❤️" },
              { type: "bubble", text: "first bubble" },
              {
                type: "choices",
                prompt: "Continue?",
                options: [
                  { key: "yes", label: "Yes" },
                  { key: "no", label: "No" },
                ],
              },
            ],
          },
        });
        expect(result).toMatchObject({ ok: true, receipt: { completed: true } });
        callbacks.onTextDelta("duplicate final");
        callbacks.onAgentEnd();
        return;
      }
      expect(input).toMatchObject({ text: expect.stringContaining("option_key: yes") });
      callbacks.onTurnAccepted?.("turn-choice");
      callbacks.onTextDelta("continued");
      callbacks.onAgentEnd();
    });
    const session = {
      canSteer: () => false,
      getInfo: () => ({ threadId: "thread-1", workspace: directory!, model: "gpt-test" }),
      hasActiveThread: () => true,
      isProcessing: () => false,
      prompt,
      supportsAbort: () => false,
    };
    const registry = {
      get: vi.fn(() => session),
      getOrCreate: vi.fn(async () => session),
      markPastDelivered: vi.fn(),
      onRemove: vi.fn(),
      resolveReplyRoute: vi.fn(() => undefined),
      updateMetadata: vi.fn(),
    };
    bot = createBot(config(directory, true), registry as never, {
      botKey: "main",
      deliveryStore: store,
    });
    bot.botInfo = botInfo();
    let nextMessageId = 100;
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (
        method === "answerCallbackQuery" &&
        (payload as { callback_query_id?: string }).callback_query_id === "callback-2"
      ) {
        throw new Error("callback answer transport failed");
      }
      if (method === "sendMessage") {
        return { ok: true, result: { message_id: nextMessageId++ } } as never;
      }
      return { ok: true, result: true } as never;
    });

    await expect(bot.sendInteraction({
      command: "send-interaction",
      requestId: "call-unsupported-reaction",
      threadId: "thread-1",
      turnId: "turn-unsupported-reaction",
      chatId: 123,
      triggerMessageId: 10,
      userId: 123,
      plan: {
        version: "telemood.plan.v1",
        actions: [{ type: "reaction", target: "trigger_message", emoji: "😄" }],
      },
    })).resolves.toMatchObject({
      ok: false,
      receipt: { receipts: [{ status: "FAILED" }] },
    });
    expect(calls).toEqual([]);

    await bot.handleUpdate(textUpdate());
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    expect(calls.map((call) => call.method).filter((method) =>
      method === "setMessageReaction" || method === "sendMessage"),
    ).toEqual(["setMessageReaction", "setMessageReaction", "sendMessage", "sendMessage"]);
    expect(calls.filter((call) => call.method === "setMessageReaction").map((call) =>
      (call.payload.reaction as Array<{ emoji: string }>)[0]?.emoji,
    )).toEqual(["👀", "❤"]);
    const sentText = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text));
    expect(sentText).toEqual(["first bubble", "Continue?"]);
    expect(sentText.join("\n")).not.toContain("duplicate final");
    expect(sentText.join("\n")).not.toContain("Done");

    const choiceCall = calls.find((call) =>
      call.method === "sendMessage" && call.payload.text === "Continue?");
    const keyboard = choiceCall?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const callbackData = keyboard.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(callbackData).toMatch(/^tm:[a-f0-9]{32}$/);

    await bot.handleUpdate(callbackUpdate(callbackData!, 101));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(calls.some((call) =>
      call.method === "editMessageText" && String(call.payload.text).includes("✓ Yes"),
    )).toBe(true);
    expect(calls.some((call) =>
      call.method === "sendMessage" && call.payload.text === "continued",
    )).toBe(true);

    await bot.handleUpdate(callbackUpdate(callbackData!, 101, 3));
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(calls.some((call) =>
      call.method === "answerCallbackQuery" && call.payload.text === "这个选择已经失效",
    )).toBe(true);

    const marker = vi.spyOn(store, "markRichTurnDelivered")
      .mockImplementationOnce(() => { throw new Error("marker write failed"); });
    await expect(bot.sendInteraction({
      command: "send-interaction",
      requestId: "call-marker-failure",
      threadId: "thread-1",
      turnId: "turn-marker-failure",
      chatId: 123,
      userId: 123,
      plan: {
        version: "telemood.plan.v1",
        actions: [{ type: "bubble", text: "delivered before marker failure" }],
      },
    })).resolves.toMatchObject({
      ok: false,
      receipt: {
        completed: false,
        visibleCompletion: true,
        receipts: [{ status: "UNCERTAIN" }],
      },
    });
    marker.mockRestore();
  });
});

function config(workspace: string, enableTelegramReactions = false): TeleCodexConfig {
  return {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace,
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "test-key",
    codexBackend: "app-server",
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    toolVerbosity: "none",
    showTurnTokenUsage: false,
    enableTelegramReactions,
  };
}

function botInfo() {
  return {
    id: 999,
    is_bot: true as const,
    first_name: "TeleCodex",
    username: "telecodex_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
}

function textUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text: "hello",
    },
  };
}

function callbackUpdate(data: string, messageId: number, updateId = 2) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: "chat-instance",
      from: { id: 123, is_bot: false, first_name: "Ada" },
      data,
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 123, type: "private" as const, first_name: "Ada" },
        text: "Continue?",
      },
    },
  };
}
