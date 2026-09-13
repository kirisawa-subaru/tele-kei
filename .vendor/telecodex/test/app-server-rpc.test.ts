import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppServerRpcClient, AppServerRpcError } from "../src/app-server-rpc.js";

type ReceivedMessage = Record<string, unknown>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createFakeAppServer(
  onMessage: (message: ReceivedMessage, socket: Socket) => void,
): Promise<{ socketPath: string; received: ReceivedMessage[] }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "telecodex-app-server-"));
  const socketPath = path.join(tempDir, "app-server.sock");
  const received: ReceivedMessage[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) return;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as ReceivedMessage;
        received.push(message);
        onMessage(message, socket);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await listen(server, socketPath);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  return { socketPath, received };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function reply(socket: Socket, message: object): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake app-server message");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createHandshakeServer(
  handler?: (message: ReceivedMessage, socket: Socket) => void,
): ReturnType<typeof createFakeAppServer> {
  return createFakeAppServer((message, socket) => {
    if (message.method === "initialize") {
      reply(socket, {
        id: message.id,
        result: {
          userAgent: "fake",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    }
    if (message.method === "initialized") return;
    handler?.(message, socket);
  });
}

describe("AppServerRpcClient", () => {
  it("performs initialize/initialized and correlates concurrent responses", async () => {
    const held = new Map<string, { id: unknown; socket: Socket }>();
    const fake = await createHandshakeServer((message, socket) => {
      held.set(String((message.params as { value?: string } | undefined)?.value), {
        id: message.id,
        socket,
      });
      if (held.size === 2) {
        const second = held.get("second")!;
        const first = held.get("first")!;
        reply(second.socket, { id: second.id, result: { value: 2 } });
        reply(first.socket, { id: first.id, result: { value: 1 } });
      }
    });
    const client = new AppServerRpcClient(fake.socketPath, { rawUnixJsonl: true });
    cleanups.push(async () => client.close());

    await client.connect();
    const [first, second] = await Promise.all([
      client.request<{ value: number }>("test/echo", { value: "first" }),
      client.request<{ value: number }>("test/echo", { value: "second" }),
    ]);

    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
    expect(fake.received[0]?.method).toBe("initialize");
    expect(fake.received[1]).toEqual({ method: "initialized" });
  });

  it("advertises experimental API support when the client enables it", async () => {
    const fake = await createHandshakeServer(() => {});
    const client = new AppServerRpcClient(fake.socketPath, {
      rawUnixJsonl: true,
      experimentalApi: true,
    });
    cleanups.push(async () => client.close());

    await client.connect();

    expect(fake.received[0]).toMatchObject({
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
        },
      },
    });
  });

  it("frames fragmented notifications and multiple messages", async () => {
    const fake = await createHandshakeServer((message, socket) => {
      if (message.method !== "test/notify") return;
      socket.write('{"method":"turn/sta');
      socket.write('rted","params":{"turnId":"t1"}}\n{"method":"turn/completed"}\n');
      reply(socket, { id: message.id, result: {} });
    });
    const client = new AppServerRpcClient(fake.socketPath, { rawUnixJsonl: true });
    cleanups.push(async () => client.close());
    const methods: string[] = [];
    client.onNotification((notification) => methods.push(notification.method));

    await client.connect();
    await client.request("test/notify");
    await new Promise((resolve) => setImmediate(resolve));

    expect(methods).toEqual(["turn/started", "turn/completed"]);
  });

  it("returns structured RPC errors", async () => {
    const fake = await createHandshakeServer((message, socket) => {
      reply(socket, { id: message.id, error: { code: -32001, message: "Server overloaded" } });
    });
    const client = new AppServerRpcClient(fake.socketPath, { rawUnixJsonl: true });
    cleanups.push(async () => client.close());

    await client.connect();

    await expect(client.request("turn/start", {})).rejects.toMatchObject<AppServerRpcError>({
      name: "AppServerRpcError",
      code: -32001,
      message: "Server overloaded",
    });
  });

  it("rejects unsupported server requests instead of hanging", async () => {
    let serverReply: ReceivedMessage | undefined;
    const fake = await createHandshakeServer((message, socket) => {
      if (message.method !== "test/server-request") return;
      reply(socket, { id: "server-1", method: "tool/requestUserInput", params: {} });
      reply(socket, { id: message.id, result: {} });
    });
    const client = new AppServerRpcClient(fake.socketPath, { rawUnixJsonl: true });
    cleanups.push(async () => client.close());

    await client.connect();
    await client.request("test/server-request");
    await waitFor(() => fake.received.some((message) => message.id === "server-1" && !message.method));
    serverReply = fake.received.find((message) => message.id === "server-1" && !message.method);

    expect(serverReply).toEqual({
      id: "server-1",
      error: { code: -32601, message: "Unsupported app-server request: tool/requestUserInput" },
    });
  });

  it("returns a configured dynamic tool result to the app-server", async () => {
    const fake = await createHandshakeServer((message, socket) => {
      if (message.method !== "test/server-request") return;
      reply(socket, {
        id: "server-tool-1",
        method: "item/tool/call",
        params: { threadId: "thread-1", tool: "send_file" },
      });
      reply(socket, { id: message.id, result: {} });
    });
    const client = new AppServerRpcClient(fake.socketPath, {
      rawUnixJsonl: true,
      onServerRequest: async (request) => ({
        success: request.method === "item/tool/call",
        contentItems: [{ type: "inputText", text: "sent" }],
      }),
    });
    cleanups.push(async () => client.close());

    await client.connect();
    await client.request("test/server-request");
    await waitFor(() =>
      fake.received.some((message) => message.id === "server-tool-1" && !message.method),
    );

    expect(fake.received.find(
      (message) => message.id === "server-tool-1" && !message.method,
    )).toEqual({
      id: "server-tool-1",
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "sent" }],
      },
    });
  });
});
