import { describe, expect, it, vi } from "vitest";

import {
  createBot,
  parsePastMessageCount,
  registerCommands,
} from "../src/bot.js";
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

function createPastHarness(
  historyText: string,
  protocolStatus = {
    weeklyUsage: { usedPercent: 27, windowDurationMins: 10_080, resetsAt: 1_788_462_327 },
    fiveHourUsage: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_787_953_187 },
    contextUsage: { contextTokens: 10_000, modelContextWindow: 456_000, observedAt: 1_700_000_000_000 },
  },
) {
  const sent: string[] = [];
  const sendMessage = vi.fn(async (payload: unknown) => {
    sent.push(String((payload as { text?: string }).text ?? ""));
    return { ok: true, result: { message_id: sent.length } };
  });
  const registry = {
    onRemove: vi.fn(),
    getOrCreate: vi.fn(async () => ({
      getInfo: () => ({ threadId: "thread-main", workspace: "/workspace", model: "gpt-5.4" }),
      isThreadAttached: () => true,
    })),
    readPast: vi.fn(async () => ({
      text: historyText,
      lastItemId: "assistant-7",
      shownMessages: 7,
      omittedMessages: 0,
    })),
    markPastDelivered: vi.fn(),
    readProtocolStatus: vi.fn(async () => protocolStatus),
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
      return sendMessage(payload);
    }
    return { ok: true, result: true };
  });
  return { bot, registry, sendMessage, sent };
}

describe("/past command", () => {
  it("defaults to five messages", () => {
    expect(parsePastMessageCount(undefined)).toBe(5);
    expect(parsePastMessageCount("")).toBe(5);
    expect(parsePastMessageCount("   ")).toBe(5);
  });

  it("accepts positive integer counts from 1 through 19", () => {
    expect(parsePastMessageCount("1")).toBe(1);
    expect(parsePastMessageCount(" 7 ")).toBe(7);
    expect(parsePastMessageCount("19")).toBe(19);
  });

  it("rejects non-integers, out-of-range values, and extra arguments", () => {
    for (const value of ["0", "20", "-1", "1.5", "abc", "2 3"]) {
      expect(parsePastMessageCount(value)).toBeNull();
    }
  });

  it("passes n to history selection and delivers every long-text chunk before watermarking", async () => {
    const historyText = [
      `你（电脑）：${"甲".repeat(4_500)}`,
      `Codex：${"乙".repeat(4_500)}`,
      `你（电脑）：${"丙".repeat(4_500)}`,
    ].join("\n\n");
    const { bot, registry, sendMessage, sent } = createPastHarness(historyText);

    await bot.handleUpdate(commandUpdate("/past 7"));

    expect(registry.readPast).toHaveBeenCalledWith("123", { maxMessages: 7 });
    expect(sent.length).toBeGreaterThan(3);
    expect(sent.join("")).toBe(historyText);
    expect(registry.markPastDelivered).toHaveBeenCalledWith("123", "assistant-7");
    expect(registry.markPastDelivered.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendMessage.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it("replies with usage and does not read history for invalid arguments", async () => {
    const { bot, registry, sent } = createPastHarness("unused");

    await bot.handleUpdate(commandUpdate("/past 3 extra"));

    expect(registry.getOrCreate).not.toHaveBeenCalled();
    expect(registry.readPast).not.toHaveBeenCalled();
    expect(sent).toEqual(["用法：/past [1-19]（默认 5）"]);
  });

  it("keeps retrying a rate-limited chunk beyond the old three-retry cap", async () => {
    const { bot } = createPastHarness("unused");
    const retryTransformer = bot.api.config.installedTransformers()[0];
    expect(retryTransformer).toBeDefined();
    let attempts = 0;

    const response = await retryTransformer!(
      vi.fn(async () => {
        attempts += 1;
        if (attempts <= 4) {
          return {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          };
        }
        return { ok: true, result: { message_id: 1 } };
      }) as never,
      "sendMessage",
      { chat_id: 123, text: "chunk" },
      undefined,
    );

    expect(response.ok).toBe(true);
    expect(attempts).toBe(5);
  });

  it("registers the final phone menu in frequency order", async () => {
    const setMyCommands = vi.fn(async () => true);
    await registerCommands({ api: { setMyCommands } } as never);

    const commands = setMyCommands.mock.calls[0]?.[0] ?? [];
    expect(commands).toEqual([
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
  });
});

describe("menu consolidation UX", () => {
  it("reports typed deleted commands through the generic unknown-command path", async () => {
    const { bot, registry, sent } = createPastHarness("unused");

    await bot.handleUpdate(commandUpdate("/retry"));

    expect(sent).toEqual(["未知或已停用的命令。用 /help 查看当前命令。"]);
    expect(registry.getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["voice", "audio"] as const)("rejects unsupported %s input without creating a session", async (kind) => {
    const { bot, registry, sent } = createPastHarness("unused");
    const media = { file_id: `${kind}-file`, file_unique_id: `${kind}-unique`, duration: 1 };

    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        chat: { id: 123, type: "private" as const, first_name: "Ada" },
        from: { id: 123, is_bot: false, first_name: "Ada" },
        [kind]: media,
      },
    });

    expect(sent).toEqual(["语音未启用，请发送文字。"]);
    expect(registry.getOrCreate).not.toHaveBeenCalled();
  });

  it("renders /status with one read-only auth line and no launch settings", async () => {
    const { bot, sent } = createPastHarness("unused");

    await bot.handleUpdate(commandUpdate("/status"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Auth:");
    expect(sent[0]).toContain("authenticated (api-key)");
    expect(sent[0]).toContain("Weekly usage:");
    expect(sent[0]).toContain("27%");
    expect(sent[0]).toContain("5h usage:");
    expect(sent[0]).toContain("Context:");
    expect(sent[0]).toContain("10k / 456k");
    expect(sent[0]).not.toContain("Session tokens");
    expect(sent[0]).not.toContain("Launch profile");
    expect(sent[0]).not.toContain("Launch behavior");
  });

  it("renders honest /status placeholders when protocol data is missing", async () => {
    const { bot, sent } = createPastHarness("unused", {});

    await bot.handleUpdate(commandUpdate("/status"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Weekly usage:");
    expect(sent[0]).toContain("unavailable");
    expect(sent[0]).toContain("Context:");
    expect(sent[0]).toContain("not observed");
    expect(sent[0]).not.toContain("5h usage:");
  });
});
