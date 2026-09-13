import { connect } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  injectSocketPath,
  startInjectServer,
  type InjectResponse,
  type SendInteractionResponse,
  type SendFileResponse,
  type TeleCodexInjectServer,
} from "../src/inject-server.js";

describe("inject server", () => {
  const directories: string[] = [];
  let server: TeleCodexInjectServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a prompt and preserves the rollover follow-up", async () => {
    const directory = mkdtempSync("/tmp/telecodex-inject-");
    directories.push(directory);
    const socketPath = injectSocketPath(directory, "study");
    let seen: unknown;
    server = await startInjectServer(socketPath, async (request) => {
      seen = request;
      return {
        ok: true,
        queued: true,
        contextKey: String(request.chatId),
        rollover: Boolean(request.rollover),
      };
    });

    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await send(socketPath, {
      chatId: "1234567890",
      text: "收口日报",
      rollover: true,
      afterRolloverText: "生成 Today card",
    });

    expect(response).toEqual({
      ok: true,
      queued: true,
      contextKey: "1234567890",
      rollover: true,
    });
    expect(seen).toEqual({
      chatId: 1234567890,
      text: "收口日报",
      rollover: true,
      afterRolloverText: "生成 Today card",
    });
  });

  it("rejects malformed and empty requests before submission", async () => {
    const directory = mkdtempSync("/tmp/telecodex-inject-");
    directories.push(directory);
    const socketPath = injectSocketPath(directory, "study");
    let calls = 0;
    server = await startInjectServer(socketPath, async () => {
      calls += 1;
      return { ok: true, queued: true, contextKey: "1", rollover: false };
    });

    await expect(sendRaw(socketPath, "not-json\n")).resolves.toEqual({
      ok: false,
      error: "Inject request is not valid JSON",
    });
    await expect(send(socketPath, { chatId: 1, text: "   " })).resolves.toEqual({
      ok: false,
      error: "Inject text is empty",
    });
    await expect(send(socketPath, {
      chatId: 1,
      text: "close",
      afterRolloverText: "Today card",
    })).resolves.toEqual({
      ok: false,
      error: "Inject afterRolloverText requires rollover=true",
    });
    expect(calls).toBe(0);
  });

  it("dispatches a validated send-file request to the worker file handler", async () => {
    const directory = mkdtempSync("/tmp/telecodex-inject-");
    directories.push(directory);
    const socketPath = injectSocketPath(directory, "study");
    let seen: unknown;
    server = await startInjectServer(
      socketPath,
      async () => ({ ok: false, error: "unexpected text injection" }),
      async (request) => {
        seen = request;
        return {
          ok: true,
          sent: true,
          chatId: request.chatId,
          messageId: 77,
          fileName: "paper.md",
          ...(request.topicId ? { topicId: request.topicId } : {}),
        };
      },
    );

    const response = await send(socketPath, {
      command: "send-file",
      threadId: "thread-study",
      chatId: "1234567890",
      topicId: 42,
      filePath: "/tmp/paper.md",
      caption: "分析",
      mode: "document",
    });

    expect(response).toEqual({
      ok: true,
      sent: true,
      chatId: 1234567890,
      messageId: 77,
      fileName: "paper.md",
      topicId: 42,
    });
    expect(seen).toEqual({
      command: "send-file",
      threadId: "thread-study",
      chatId: 1234567890,
      topicId: 42,
      filePath: "/tmp/paper.md",
      caption: "分析",
      mode: "document",
    });
  });

  it("validates and dispatches a Telemood interaction plan", async () => {
    const directory = mkdtempSync("/tmp/telecodex-inject-");
    directories.push(directory);
    const socketPath = injectSocketPath(directory, "main");
    let seen: unknown;
    server = await startInjectServer(
      socketPath,
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

    const response = await send(socketPath, {
      command: "send-interaction",
      requestId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      chatId: 123,
      topicId: 7,
      triggerMessageId: 44,
      userId: 123,
      plan: {
        version: "telemood.plan.v1",
        actions: [{ type: "bubble", text: "hello" }],
      },
    });

    expect(response).toMatchObject({ ok: true, receipt: { requestId: "call-1" } });
    expect(seen).toMatchObject({
      command: "send-interaction",
      requestId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      chatId: 123,
      topicId: 7,
      triggerMessageId: 44,
      userId: 123,
      plan: { version: "telemood.plan.v1" },
    });
  });
});

function send(
  socketPath: string,
  request: unknown,
): Promise<InjectResponse | SendFileResponse | SendInteractionResponse> {
  return sendRaw(socketPath, `${JSON.stringify(request)}\n`);
}

function sendRaw(
  socketPath: string,
  frame: string,
): Promise<InjectResponse | SendFileResponse | SendInteractionResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => socket.write(frame));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as
        InjectResponse | SendFileResponse | SendInteractionResponse);
    });
  });
}
