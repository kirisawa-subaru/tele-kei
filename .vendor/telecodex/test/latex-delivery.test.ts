import { beforeEach, describe, expect, it, vi } from "vitest";

const renderLatexFormulaImage = vi.hoisted(() => vi.fn());

vi.mock("../src/latex-renderer.js", () => ({ renderLatexFormulaImage }));

import { createBot } from "../src/bot.js";
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

function textUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
    },
  };
}

function createHarness(finalText: string) {
  const methods: string[] = [];
  const sentTexts: string[] = [];
  const calls: Array<{ method: string; payload: unknown }> = [];
  let nextMessageId = 100;
  const session = {
    canSteer: () => false,
    getInfo: () => ({ threadId: "thread-main", workspace: "/workspace", model: "gpt-5.4" }),
    hasActiveThread: () => true,
    isProcessing: () => false,
    prompt: vi.fn(async (_input, callbacks) => {
      callbacks.onTurnAccepted?.("turn-1");
      callbacks.onTextDelta(finalText);
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
    methods.push(method);
    calls.push({ method, payload });
    if (method === "sendMessage") {
      sentTexts.push(String((payload as { text?: string }).text ?? ""));
      return { ok: true, result: { message_id: nextMessageId++ } };
    }
    if (method === "sendPhoto") {
      return { ok: true, result: { message_id: nextMessageId++ } };
    }
    return { ok: true, result: true };
  });
  return { bot, calls, methods, registry, sentTexts };
}

describe("LaTeX summary delivery", () => {
  beforeEach(() => {
    renderLatexFormulaImage.mockReset();
  });

  it("sends at most three formulas per photo with continuous copy buttons", async () => {
    const finalText = "Intro $$a=1$$$$b=2$$$$c=3$$ bridge $$d=4$$$$e=5$$$$f=6$$ tail";
    renderLatexFormulaImage.mockResolvedValue({
      buffer: Buffer.from("png"),
      fileName: "latex-summary.png",
      formulaCount: 3,
      width: 1200,
      height: 300,
    });
    const { bot, calls, registry } = createHarness(finalText);

    await bot.handleUpdate(textUpdate("show formulas"));
    await vi.waitFor(() => expect(registry.updateMetadata).toHaveBeenCalledOnce());

    const photos = calls.filter((call) => call.method === "sendPhoto");
    expect(photos).toHaveLength(2);
    const first = photos[0].payload as {
      caption: string;
      show_caption_above_media: boolean;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; copy_text?: { text: string } }>> };
    };
    const second = photos[1].payload as typeof first;
    expect(first.caption).toContain("[1]");
    expect(first.caption).toContain("[2]");
    expect(first.caption).toContain("[3]");
    expect(first.caption).not.toContain("$$a=1$$");
    expect(first.show_caption_above_media).toBe(true);
    expect(first.reply_markup.inline_keyboard[0].map((button) => button.text)).toEqual([
      "[1]",
      "[2]",
      "[3]",
    ]);
    expect(first.reply_markup.inline_keyboard[0][0].copy_text?.text).toBe("$$a=1$$");
    expect(second.caption).toContain("[4]");
    expect(second.caption).toContain("[5]");
    expect(second.caption).toContain("[6]");
    expect(second.reply_markup.inline_keyboard[0].map((button) => button.text)).toEqual([
      "[4]",
      "[5]",
      "[6]",
    ]);
    expect(renderLatexFormulaImage.mock.calls.map(([formulas]) =>
      formulas.map((formula: { number: number }) => formula.number)
    )).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("restores original formula source when image rendering fails", async () => {
    const finalText = "Text survives.\n\n$$broken_{formula}$$";
    renderLatexFormulaImage.mockRejectedValue(new Error("renderer unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bot, methods, registry, sentTexts } = createHarness(finalText);

    await bot.handleUpdate(textUpdate("show a formula"));
    await vi.waitFor(() => expect(registry.updateMetadata).toHaveBeenCalledOnce());

    expect(sentTexts.join("\n")).toContain("Text survives.");
    expect(sentTexts.join("\n")).toContain("$$broken_{formula}$$");
    expect(methods).not.toContain("sendPhoto");
    expect(error).toHaveBeenCalledWith(
      "Failed to render or send LaTeX formula group:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("falls back to a preceding text message when the caption exceeds 1024 characters", async () => {
    const finalText = `${"long ".repeat(230)}$$a=1$$`;
    renderLatexFormulaImage.mockResolvedValue({
      buffer: Buffer.from("png"),
      fileName: "latex-summary.png",
      formulaCount: 1,
      width: 1200,
      height: 180,
    });
    const { bot, calls, registry } = createHarness(finalText);

    await bot.handleUpdate(textUpdate("show a long explanation"));
    await vi.waitFor(() => expect(registry.updateMetadata).toHaveBeenCalledOnce());

    const photo = calls.find((call) => call.method === "sendPhoto")?.payload as {
      caption?: string;
    };
    expect(photo.caption).toBeUndefined();
    expect(calls.some((call) =>
      call.method === "sendMessage" && String((call.payload as { text?: string }).text).includes("[1]")
    )).toBe(true);
  });
});
