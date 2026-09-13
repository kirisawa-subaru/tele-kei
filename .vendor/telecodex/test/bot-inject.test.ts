import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBot } from "../src/bot.js";
import type { CodexPromptInput, CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

describe("inject to Telegram prompt path", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const directory of workspaces.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("queues a prompt and delivers the answer without a fake Telegram message id", async () => {
    const harness = buildHarness(workspaces);

    await expect(harness.bot.enqueueInjectedText({ chatId: 123, text: "准备日报" })).resolves.toEqual({
      ok: true,
      queued: true,
      contextKey: "123",
      rollover: false,
    });
    await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.sentTexts()).toContain("answer"));

    const input = harness.prompt.mock.calls[0]![0] as Exclude<CodexPromptInput, string>;
    expect(input.text).toBe("准备日报");
    expect(input.provenance).toMatchObject({
      transport: "telegram",
      botKey: "study",
      chatId: "123",
      messageKind: "text",
    });
    expect(input.provenance).not.toHaveProperty("messageId");
  });

  it("finishes a rollover prompt before creating the next thread", async () => {
    const order: string[] = [];
    const harness = buildHarness(workspaces, {
      prompt: async (_input, callbacks) => {
        order.push("prompt");
        callbacks.onTurnAccepted?.("turn-1");
        callbacks.onTextDelta("closed");
        callbacks.onAgentEnd();
      },
      newThread: async () => {
        order.push("new-thread");
        return { threadId: "thread-next", workspace: "/study" };
      },
    });

    await harness.bot.enqueueInjectedText({
      chatId: 123,
      text: "最终收口日报",
      rollover: true,
    });
    await vi.waitFor(() => expect(harness.newThread).toHaveBeenCalledOnce());

    expect(order).toEqual(["prompt", "new-thread"]);
    expect(harness.registry.updateMetadata).toHaveBeenCalled();
  });

  it("writes the rollover follow-up as the new thread's first turn", async () => {
    const order: string[] = [];
    const harness = buildHarness(workspaces, {
      prompt: async (input, callbacks) => {
        const text = typeof input === "string" ? input : input.text;
        order.push(`prompt:${text}`);
        callbacks.onTurnAccepted?.(`turn-${order.length}`);
        callbacks.onTextDelta("answer");
        callbacks.onAgentEnd();
      },
      newThread: async () => {
        order.push("new-thread");
        return { threadId: "thread-next", workspace: "/study" };
      },
    });

    await harness.bot.enqueueInjectedText({
      chatId: 123,
      text: "close",
      rollover: true,
      afterRolloverText: "Today card",
    });

    await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["prompt:close", "new-thread", "prompt:Today card"]);
    expect(harness.registry.updateMetadata).toHaveBeenCalled();
  });

  it("does not write the rollover follow-up when new thread creation fails", async () => {
    const harness = buildHarness(workspaces, {
      newThread: async () => {
        throw new Error("thread start failed");
      },
    });

    await harness.bot.enqueueInjectedText({
      chatId: 123,
      text: "close",
      rollover: true,
      afterRolloverText: "Today card",
    });

    await vi.waitFor(() => expect(harness.newThread).toHaveBeenCalledOnce());
    expect(harness.prompt).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.sentTexts()).toContain("每日换日失败：thread start failed"));
  });

  it("does not create a new thread when the closing turn fails", async () => {
    const harness = buildHarness(workspaces, {
      prompt: async () => {
        throw new Error("close failed");
      },
    });

    await harness.bot.enqueueInjectedText({
      chatId: 123,
      text: "close",
      rollover: true,
      afterRolloverText: "Today card",
    });

    await vi.waitFor(() => expect(harness.sentTexts()).toContain("⚠️ close failed"));
    expect(harness.newThread).not.toHaveBeenCalled();
    expect(harness.prompt).toHaveBeenCalledOnce();
  });

  it("keeps prompts after a rollover boundary for the new thread", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let promptCount = 0;
    const harness = buildHarness(workspaces, {
      prompt: async (_input, callbacks) => {
        promptCount += 1;
        callbacks.onTurnAccepted?.(`turn-${promptCount}`);
        if (promptCount === 1) await gate;
        callbacks.onTextDelta(`answer-${promptCount}`);
        callbacks.onAgentEnd();
      },
    });

    await harness.bot.enqueueInjectedText({ chatId: 123, text: "close", rollover: true });
    await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalledTimes(1));
    await harness.bot.enqueueInjectedText({ chatId: 123, text: "morning" });
    releaseFirst();

    await vi.waitFor(() => expect(harness.newThread).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalledTimes(2));
    expect((harness.prompt.mock.calls[1]![0] as Exclude<CodexPromptInput, string>).text).toBe("morning");
  });

  it("refuses a chat outside the worker allowlist", async () => {
    const harness = buildHarness(workspaces);
    await expect(harness.bot.enqueueInjectedText({ chatId: 999, text: "no" })).resolves.toEqual({
      ok: false,
      error: "chat 999 is not in this bot's allowlist",
    });
    expect(harness.registry.getOrCreate).not.toHaveBeenCalled();
  });

  it("sends a local file only for the thread that owns the Telegram context", async () => {
    const harness = buildHarness(workspaces);
    const filePath = path.join(harness.workspace, "paper analysis.md");
    writeFileSync(filePath, "analysis", "utf8");

    await expect(harness.bot.sendLocalFile({
      command: "send-file",
      threadId: "thread-current",
      chatId: 123,
      topicId: 42,
      filePath,
      caption: "论文分析",
    })).resolves.toEqual({
      ok: true,
      sent: true,
      chatId: 123,
      topicId: 42,
      messageId: 100,
      fileName: "paper_analysis.md",
    });

    expect(harness.calls.find((call) => call.method === "sendDocument")?.payload).toMatchObject({
      chat_id: 123,
      caption: "论文分析",
      message_thread_id: 42,
    });
    await expect(harness.bot.sendLocalFile({
      command: "send-file",
      threadId: "thread-other",
      chatId: 123,
      filePath,
    })).resolves.toEqual({
      ok: false,
      error: "This Codex thread does not own the Telegram context",
    });
  });
});

function buildHarness(
  workspaces: string[],
  options: {
    prompt?: (input: CodexPromptInput, callbacks: CodexSessionCallbacks) => Promise<void>;
    newThread?: () => Promise<{ threadId: string; workspace: string }>;
  } = {},
) {
  const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-inject-bot-"));
  workspaces.push(workspace);
  let currentThread = "thread-current";
  const prompt = vi.fn(async (input: CodexPromptInput, callbacks: CodexSessionCallbacks) => {
    if (options.prompt) return options.prompt(input, callbacks);
    callbacks.onTurnAccepted?.("turn-1");
    callbacks.onTextDelta("answer");
    callbacks.onAgentEnd();
  });
  const newThread = vi.fn(async () => {
    const info = options.newThread
      ? await options.newThread()
      : { threadId: "thread-next", workspace };
    currentThread = info.threadId;
    return info;
  });
  const session = {
    canSteer: () => false,
    getInfo: () => ({ threadId: currentThread, workspace, model: "gpt-test" }),
    hasActiveThread: () => true,
    isProcessing: () => false,
    prompt,
    supportsAbort: () => false,
    newThread,
  };
  const registry = {
    get: vi.fn(() => session),
    getOrCreate: vi.fn(async () => session),
    markPastDelivered: vi.fn(),
    onRemove: vi.fn(),
    resolveReplyRoute: vi.fn(() => undefined),
    updateMetadata: vi.fn(),
  };
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const bot = createBot(config(workspace), registry as never, { botKey: "study" });
  let nextMessageId = 100;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: nextMessageId++ } } as never;
    }
    if (method === "sendDocument" || method === "sendPhoto") {
      return { ok: true, result: { message_id: nextMessageId++ } } as never;
    }
    return { ok: true, result: true } as never;
  });

  return {
    bot,
    calls,
    newThread,
    prompt,
    registry,
    workspace,
    sentTexts: () => calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text)),
  };
}

function config(workspace: string): TeleCodexConfig {
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
    enableTelegramReactions: false,
  };
}
