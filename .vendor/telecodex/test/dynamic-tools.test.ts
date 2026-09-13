import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createDynamicToolRequestHandler } from "../src/dynamic-tools.js";
import {
  injectSocketPath,
  startInjectServer,
  type TeleCodexInjectServer,
} from "../src/inject-server.js";

describe("dynamic Telegram tools", () => {
  const directories: string[] = [];
  let server: TeleCodexInjectServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives the destination from thread ownership and forwards to the owning bot worker", async () => {
    const repositoryRoot = mkdtempSync("/tmp/telecodex-tools-");
    directories.push(repositoryRoot);
    let seen: unknown;
    server = await startInjectServer(
      injectSocketPath(repositoryRoot, "study"),
      async () => ({ ok: false, error: "unexpected text injection" }),
      async (request) => {
        seen = request;
        return {
          ok: true,
          sent: true,
          chatId: request.chatId,
          messageId: 91,
          fileName: "analysis.md",
          ...(request.topicId ? { topicId: request.topicId } : {}),
        };
      },
    );
    const handler = createDynamicToolRequestHandler({
      repositoryRoot,
      resolveThreadOwner: () => ({ botKey: "study", contextKey: "1234567890:42" }),
      resolveTurnProvenance: () => undefined,
      enabledToolsForBot: () => ["telegram.send_file"],
    });

    await expect(handler({
      id: 1,
      method: "item/tool/call",
      params: {
        callId: "call-1",
        threadId: "thread-study",
        turnId: "turn-1",
        namespace: "telegram",
        tool: "send_file",
        arguments: { path: "/tmp/analysis.md", caption: "论文分析" },
      },
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: "Telegram accepted analysis.md via bot study (chat 1234567890, message 91).",
      }],
    });
    expect(seen).toEqual({
      command: "send-file",
      threadId: "thread-study",
      chatId: 1234567890,
      topicId: 42,
      filePath: "/tmp/analysis.md",
      caption: "论文分析",
      mode: "document",
    });
  });

  it("rejects a tool call when the owning bot profile does not enable it", async () => {
    const handler = createDynamicToolRequestHandler({
      repositoryRoot: "/tmp/unused",
      resolveThreadOwner: () => ({ botKey: "main", contextKey: "123" }),
      resolveTurnProvenance: () => undefined,
      enabledToolsForBot: () => [],
    });

    const response = await handler({
      id: 1,
      method: "item/tool/call",
      params: {
        callId: "call-1",
        threadId: "thread-main",
        turnId: "turn-1",
        namespace: "telegram",
        tool: "send_file",
        arguments: { path: "/tmp/analysis.md" },
      },
    });
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain("not enabled for bot main");
  });

  it("binds trusted turn provenance before forwarding a Telemood plan", async () => {
    const repositoryRoot = mkdtempSync("/tmp/telecodex-tools-");
    directories.push(repositoryRoot);
    let seen: unknown;
    server = await startInjectServer(
      injectSocketPath(repositoryRoot, "main"),
      async () => ({ ok: false, error: "unexpected text injection" }),
      undefined,
      async (request) => {
        seen = request;
        return {
          ok: true,
          receipt: {
            requestId: request.requestId,
            completed: true,
            visibleCompletion: true,
            receipts: [],
            unexecutedCount: 0,
          },
        };
      },
    );
    const handler = createDynamicToolRequestHandler({
      repositoryRoot,
      resolveThreadOwner: () => ({ botKey: "main", contextKey: "-100123:42" }),
      resolveTurnProvenance: () => ({
        senderUserId: 77,
        chatId: "-100123",
        messageId: 91,
        messageThreadId: 42,
      }),
      enabledToolsForBot: () => ["telegram.send_interaction"],
    });

    const response = await handler({
      id: 2,
      method: "item/tool/call",
      params: {
        callId: "call-rich",
        threadId: "thread-main",
        turnId: "turn-main",
        namespace: "telegram",
        tool: "send_interaction",
        arguments: {
          version: "telemood.plan.v1",
          actions: [
            { type: "reaction", target: "trigger_message", emoji: "❤" },
            { type: "bubble", text: "hello" },
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
      },
    });

    expect(response.success).toBe(true);
    expect(seen).toMatchObject({
      command: "send-interaction",
      requestId: "call-rich",
      threadId: "thread-main",
      turnId: "turn-main",
      chatId: -100123,
      topicId: 42,
      triggerMessageId: 91,
      userId: 77,
    });
  });

  it("does not accept model-supplied routing when trusted provenance is absent", async () => {
    const handler = createDynamicToolRequestHandler({
      repositoryRoot: "/tmp/unused",
      resolveThreadOwner: () => ({ botKey: "main", contextKey: "123" }),
      resolveTurnProvenance: () => undefined,
      enabledToolsForBot: () => ["telegram.send_interaction"],
    });
    const response = await handler({
      id: 3,
      method: "item/tool/call",
      params: {
        callId: "call-rich",
        threadId: "thread-main",
        turnId: "turn-main",
        namespace: "telegram",
        tool: "send_interaction",
        arguments: {
          version: "telemood.plan.v1",
          actions: [{ type: "reaction", target: "trigger_message", emoji: "❤" }],
          messageId: 999,
        },
      },
    });
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.text).toContain("Invalid Telemood plan");
  });
});
