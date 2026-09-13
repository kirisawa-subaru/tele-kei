import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TeleCodexConfig } from "../src/config.js";

const mockCodexState = vi.hoisted(() => {
  const queryThreads = vi.fn();
  const queryThread = vi.fn();

  return {
    queryThreads,
    queryThread,
    reset: () => {
      queryThreads.mockReset();
      queryThreads.mockReturnValue({ available: true, value: [] });
      queryThread.mockReset();
      queryThread.mockReturnValue({ available: true, value: null });
    },
  };
});

vi.mock("../src/codex-state.js", () => ({
  getThread: vi.fn(() => null),
  queryThreads: mockCodexState.queryThreads,
  queryThread: mockCodexState.queryThread,
}));

import { createBot } from "../src/bot.js";

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

function commandUpdate(text: string) {
  const commandLength = text.split(/\s/, 1)[0]?.length ?? text.length;
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
      entities: [{ offset: 0, length: commandLength, type: "bot_command" as const }],
    },
  };
}

function createHarness() {
  const sent: string[] = [];
  const session = {
    isProcessing: vi.fn(() => false),
    switchSession: vi.fn(),
  };
  const registry = {
    onRemove: vi.fn(),
    getOrCreate: vi.fn(async () => session),
    get: vi.fn(() => session),
    updateMetadata: vi.fn(),
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
      sent.push(String((payload as { text?: string }).text ?? ""));
      return { ok: true, result: { message_id: sent.length } };
    }
    return { ok: true, result: true };
  });
  return { bot, session, sent };
}

beforeEach(() => {
  mockCodexState.reset();
});

describe("/view and /attach state database failures", () => {
  it("shows an unavailable message for /view when the database query cannot run", async () => {
    mockCodexState.queryThreads.mockReturnValue({ available: false });
    const { bot, sent } = createHarness();

    await bot.handleUpdate(commandUpdate("/view"));

    expect(mockCodexState.queryThreads).toHaveBeenCalledWith(50);
    expect(sent).toEqual(["\u4f1a\u8bdd\u5217\u8868\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002"]);
  });

  it("keeps the existing true-empty /view response when the database is healthy", async () => {
    const { bot, sent } = createHarness();

    await bot.handleUpdate(commandUpdate("/view"));

    expect(sent).toEqual(["No recent threads found."]);
  });

  it("shows an unavailable message for /attach without attempting a switch", async () => {
    mockCodexState.queryThread.mockReturnValue({ available: false });
    const { bot, session, sent } = createHarness();

    await bot.handleUpdate(commandUpdate("/attach thread-1"));

    expect(mockCodexState.queryThread).toHaveBeenCalledWith("thread-1");
    expect(sent).toEqual(["\u4f1a\u8bdd\u5217\u8868\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002"]);
    expect(session.switchSession).not.toHaveBeenCalled();
  });

  it("keeps the unknown-thread response for a healthy database miss", async () => {
    const { bot, session, sent } = createHarness();

    await bot.handleUpdate(commandUpdate("/attach missing"));

    expect(sent).toEqual(["<b>Failed:</b> Unknown Codex thread: missing"]);
    expect(session.switchSession).not.toHaveBeenCalled();
  });
});
