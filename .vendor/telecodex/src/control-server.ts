import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import type { TelegramContextKey } from "./context-key.js";
import type { ActiveThreadBinding, ReplyRoute, SessionRegistry } from "./session-registry.js";
import { assertBotKey, scopeContextKey, splitScopedContextKey } from "./core-protocol.js";

const MAX_REQUEST_BYTES = 16 * 1024;

type BindActiveThreadRequest = {
  command: "bind-active-thread";
  threadId: string;
  botKey?: string;
  contextKey?: TelegramContextKey;
  desktopRelay?: {
    pipePath: string;
  };
};

type RegisterReplyRouteRequest = {
  command: "register-reply-route";
  threadId: string;
  botKey?: string;
  contextKey: TelegramContextKey;
  messageId: number;
  automationId?: string;
};

type ControlRequest = BindActiveThreadRequest | RegisterReplyRouteRequest;

type ControlResponse =
  | ({ ok: true; botKey: string } & ActiveThreadBinding)
  | ({ ok: true; botKey: string } & ReplyRoute)
  | { ok: false; error: string };

export interface TeleCodexControlServer {
  socketPath: string;
  close(): Promise<void>;
}

export async function startControlServer(
  socketPath: string,
  registry: Pick<SessionRegistry, "bindActiveThread" | "registerReplyRoute" | "listContexts">,
): Promise<TeleCodexControlServer> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const server = createServer((socket) => handleConnection(socket, registry));
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);

  let closePromise: Promise<void> | undefined;
  return {
    socketPath,
    close: () => {
      closePromise ??= closeServer(server, socketPath);
      return closePromise;
    },
  };
}

function handleConnection(
  socket: Socket,
  registry: Pick<SessionRegistry, "bindActiveThread" | "registerReplyRoute" | "listContexts">,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let handled = false;

  const respond = (response: ControlResponse): void => {
    if (handled) return;
    handled = true;
    socket.end(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      respond({ ok: false, error: "Control request is too large" });
      return;
    }

    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    void processRequest(buffer.slice(0, newline), registry)
      .then(respond)
      .catch((error) =>
        respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  });

  socket.on("error", () => {
    // Client disconnects must not affect the Telegram bridge.
  });
}

async function processRequest(
  raw: string,
  registry: Pick<SessionRegistry, "bindActiveThread" | "registerReplyRoute" | "listContexts">,
): Promise<ControlResponse> {
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Control request is not valid JSON" };
  }

  if (!isControlRequest(request)) {
    return { ok: false, error: "Unsupported control request" };
  }

  const botKey = assertBotKey(request.botKey ?? "main");
  if (request.command === "register-reply-route") {
    const route = registry.registerReplyRoute(
      request.threadId,
      scopeContextKey(botKey, request.contextKey),
      request.messageId,
      request.automationId,
    );
    return { ok: true, botKey, ...route, contextKey: request.contextKey };
  }

  const requestedContextKey = request.contextKey
    ? scopeContextKey(botKey, request.contextKey)
    : registry.listContexts()
        .find((entry) => splitScopedContextKey(entry.contextKey).botKey === botKey)
        ?.contextKey;
  if (!requestedContextKey) {
    return { ok: false, error: `No active Telegram context for bot ${botKey}` };
  }
  const binding = request.desktopRelay
    ? await registry.bindActiveThread(request.threadId, requestedContextKey, request.desktopRelay)
    : await registry.bindActiveThread(request.threadId, requestedContextKey);
  return {
    ok: true,
    botKey,
    ...binding,
    contextKey: splitScopedContextKey(binding.contextKey).contextKey,
  };
}

function isControlRequest(value: unknown): value is ControlRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.command === "bind-active-thread") {
    return (
      typeof record.threadId === "string" &&
      (record.botKey === undefined || typeof record.botKey === "string") &&
      (record.contextKey === undefined || typeof record.contextKey === "string") &&
      (
        record.desktopRelay === undefined ||
        isDesktopRelayCapability(record.desktopRelay)
      )
    );
  }
  if (record.command === "register-reply-route") {
    return (
      typeof record.threadId === "string" &&
      (record.botKey === undefined || typeof record.botKey === "string") &&
      typeof record.contextKey === "string" &&
      typeof record.messageId === "number" &&
      (record.automationId === undefined || typeof record.automationId === "string")
    );
  }
  return false;
}

function isDesktopRelayCapability(value: unknown): value is { pipePath: string } {
  if (!value || typeof value !== "object") return false;
  const pipePath = (value as Record<string, unknown>).pipePath;
  return typeof pipePath === "string" && pipePath.length > 0 && pipePath.length <= 1_024;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      void rm(socketPath, { force: true }).finally(resolve);
    });
  });
}
