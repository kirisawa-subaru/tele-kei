import { expect, it, vi } from "vitest";

import { createBot } from "../src/bot.js";
import type { TeleCodexConfig } from "../src/config.js";

it("retries final projection after the first stage attempt rejects", async () => {
  const stageText = vi.fn()
    .mockImplementationOnce(() => { throw new Error("transient stage failure"); })
    .mockImplementation((input) => ({ ...input, state: "pending", attempts: 0 }));
  const deliveryStore = {
    stageText,
    beginAttempt: vi.fn(),
    listParts: vi.fn(() => [{
      partIndex: 0,
      text: "final text",
      fallbackText: "final text",
      state: "pending",
      attempts: 0,
    }]),
    markPartDelivered: vi.fn(),
    markDelivered: vi.fn(),
  };
  const session = {
    canSteer: () => false,
    getInfo: () => ({ threadId: "thread-1", workspace: "/workspace", model: "gpt-test" }),
    hasActiveThread: () => true,
    isProcessing: () => false,
    prompt: vi.fn(async (_input, callbacks) => {
      callbacks.onTurnAccepted?.("turn-1");
      callbacks.onTextDelta("final text");
      callbacks.onAgentEnd();
      await Promise.resolve();
    }),
    supportsAbort: () => false,
  };
  const registry = {
    get: vi.fn(() => undefined),
    getOrCreate: vi.fn(async () => session),
    markPastDelivered: vi.fn(),
    onRemove: vi.fn(),
    resolveReplyRoute: vi.fn(() => undefined),
    updateMetadata: vi.fn(),
  };
  const bot = createBot(config(), registry as never, {
    botKey: "main",
    deliveryStore: deliveryStore as never,
  });
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
  const sendMessage = vi.fn(() => ({ ok: true, result: { message_id: 100 } }));
  bot.api.config.use(async (_previous, method) => {
    if (method === "sendMessage") return sendMessage();
    return { ok: true, result: true };
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await bot.handleUpdate(textUpdate());
  await vi.waitFor(() => expect(stageText).toHaveBeenCalledTimes(2));

  expect(sendMessage).toHaveBeenCalledOnce();
  expect(deliveryStore.markPartDelivered).toHaveBeenCalledOnce();
  expect(deliveryStore.markDelivered).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledWith(
    "Failed to finalize Telegram response message",
    expect.any(Error),
  );
  error.mockRestore();
});

function config(): TeleCodexConfig {
  return {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "test-key",
    codexBackend: "app-server",
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    toolVerbosity: "none",
    showTurnTokenUsage: false,
    enableTelegramReactions: false,
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
