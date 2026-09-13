import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { startControlServer } from "../src/control-server.js";

describe("TeleCodex control server", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-control-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("binds a requested CLI thread over a private Unix socket", async () => {
    const bindActiveThread = vi.fn().mockResolvedValue({
      contextKey: "123",
      threadId: "thread-cli",
      previousThreadId: "thread-old",
      workspace: "/workspace",
    });
    const socketPath = path.join(tempDir, "control.sock");
    const server = await startControlServer(socketPath, {
      bindActiveThread,
      registerReplyRoute: vi.fn(),
      listContexts: () => [{ contextKey: "main\u001f123", updatedAt: 1 } as never],
    });

    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await sendRequest(socketPath, {
      command: "bind-active-thread",
      threadId: "thread-cli",
    });

    expect(bindActiveThread).toHaveBeenCalledWith("thread-cli", "main\u001f123");
    expect(response).toEqual({
      ok: true,
      botKey: "main",
      contextKey: "123",
      threadId: "thread-cli",
      previousThreadId: "thread-old",
      workspace: "/workspace",
    });
    await server.close();
  });

  it("returns a bounded error for malformed requests", async () => {
    const bindActiveThread = vi.fn();
    const registerReplyRoute = vi.fn();
    const socketPath = path.join(tempDir, "control.sock");
    const server = await startControlServer(socketPath, {
      bindActiveThread,
      registerReplyRoute,
      listContexts: () => [],
    });

    const response = await sendRawRequest(socketPath, "not-json\n");

    expect(response).toEqual({ ok: false, error: "Control request is not valid JSON" });
    expect(bindActiveThread).not.toHaveBeenCalled();
    expect(registerReplyRoute).not.toHaveBeenCalled();
    await server.close();
  });

  it("passes an explicit Telegram context to the registry", async () => {
    const bindActiveThread = vi.fn().mockRejectedValue(new Error("Unknown Telegram context: 999"));
    const socketPath = path.join(tempDir, "control.sock");
    const server = await startControlServer(socketPath, {
      bindActiveThread,
      registerReplyRoute: vi.fn(),
      listContexts: () => [],
    });

    const response = await sendRequest(socketPath, {
      command: "bind-active-thread",
      threadId: "thread-cli",
      contextKey: "999",
    });

    expect(bindActiveThread).toHaveBeenCalledWith("thread-cli", "main\u001f999");
    expect(response).toEqual({ ok: false, error: "Unknown Telegram context: 999" });
    await server.close();
  });

  it("selects the most recent context inside the requested bot namespace", async () => {
    const bindActiveThread = vi.fn().mockResolvedValue({
      contextKey: "work\u001f-200",
      threadId: "thread-work",
      previousThreadId: null,
      workspace: "/workspace",
      mode: "direct",
    });
    const socketPath = path.join(tempDir, "control.sock");
    const server = await startControlServer(socketPath, {
      bindActiveThread,
      registerReplyRoute: vi.fn(),
      listContexts: () => [
        { contextKey: "main\u001f100", updatedAt: 20 } as never,
        { contextKey: "work\u001f-200", updatedAt: 10 } as never,
      ],
    });

    const response = await sendRequest(socketPath, {
      command: "bind-active-thread",
      botKey: "work",
      threadId: "thread-work",
    });

    expect(bindActiveThread).toHaveBeenCalledWith("thread-work", "work\u001f-200");
    expect(response).toMatchObject({ ok: true, botKey: "work", contextKey: "-200" });
    await server.close();
  });

  it("passes the Desktop relay capability when the local trigger provides it", async () => {
    const bindActiveThread = vi.fn().mockResolvedValue({
      contextKey: "123",
      threadId: "thread-desktop",
      previousThreadId: "thread-old",
      workspace: "/workspace",
      mode: "desktop-relay",
    });
    const socketPath = path.join(tempDir, "control.sock");
    const server = await startControlServer(socketPath, {
      bindActiveThread,
      registerReplyRoute: vi.fn(),
      listContexts: () => [{ contextKey: "main\u001f123", updatedAt: 1 } as never],
    });

    const response = await sendRequest(socketPath, {
      command: "bind-active-thread",
      threadId: "thread-desktop",
      desktopRelay: { pipePath: "/tmp/codex-browser-use/desktop.sock" },
    });

    expect(bindActiveThread).toHaveBeenCalledWith(
      "thread-desktop",
      "main\u001f123",
      { pipePath: "/tmp/codex-browser-use/desktop.sock" },
    );
    expect(response).toMatchObject({
      ok: true,
      threadId: "thread-desktop",
      mode: "desktop-relay",
    });
    await server.close();
  });

  it("registers an alert message as a reply route without rebinding the chat", async () => {
    const bindActiveThread = vi.fn();
    const registerReplyRoute = vi.fn().mockReturnValue({
      contextKey: "123",
      messageId: 456,
      threadId: "thread-automation",
      automationId: "card-hygiene",
      createdAt: 1_787_306_000_000,
    });
    const socketPath = path.join(tempDir, "control.sock");
    const server = await startControlServer(socketPath, {
      bindActiveThread,
      registerReplyRoute,
      listContexts: () => [],
    });

    const response = await sendRequest(socketPath, {
      command: "register-reply-route",
      contextKey: "123",
      messageId: 456,
      threadId: "thread-automation",
      automationId: "card-hygiene",
    });

    expect(registerReplyRoute).toHaveBeenCalledWith(
      "thread-automation",
      "main\u001f123",
      456,
      "card-hygiene",
    );
    expect(bindActiveThread).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: true,
      botKey: "main",
      contextKey: "123",
      messageId: 456,
      threadId: "thread-automation",
    });
    await server.close();
  });

});

function sendRequest(socketPath: string, request: unknown): Promise<unknown> {
  return sendRawRequest(socketPath, `${JSON.stringify(request)}\n`);
}

function sendRawRequest(socketPath: string, request: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response.trim()));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}
