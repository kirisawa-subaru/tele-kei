import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { CodexSessionApi } from "./session-api.js";
import type { SessionRegistry, TrustedTurnProvenance } from "./session-registry.js";
import {
  CORE_MAX_FRAME_BYTES,
  CORE_PROTOCOL_VERSION,
  assertBotKey,
  scopeContextKey,
  type CoreRpcEvent,
  type CoreRpcRequest,
  type CoreRpcResponse,
  type CoreSessionTarget,
  type SessionSnapshot,
} from "./core-protocol.js";
import type { CodexSessionCallbacks } from "./codex-session.js";
import type { DurableTurnJournal } from "./turn-journal.js";

export interface CoreRouterServer {
  socketPath: string;
  close(): Promise<void>;
}

export async function startCoreRouterServer(
  socketPath: string,
  registry: SessionRegistry,
  turnJournal?: DurableTurnJournal,
): Promise<CoreRouterServer> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const server = createServer((socket) => handleSocket(socket, registry, turnJournal));
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

function handleSocket(
  socket: Socket,
  registry: SessionRegistry,
  turnJournal?: DurableTurnJournal,
): void {
  socket.setEncoding("utf8");
  let buffer = "";

  const write = (message: CoreRpcResponse | CoreRpcEvent): void => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > CORE_MAX_FRAME_BYTES) {
      socket.destroy(new Error("Core Router request frame is too large"));
      return;
    }

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;

      let request: CoreRpcRequest;
      try {
        request = JSON.parse(line) as CoreRpcRequest;
      } catch {
        write({ id: 0, ok: false, error: "Core Router request is not valid JSON" });
        continue;
      }

      void processRequest(
        request,
        registry,
        (event, payload) =>
          write({ id: request.id, event, ...(payload === undefined ? {} : { payload }) }),
        turnJournal,
      ).then(
        (result) => write({ id: request.id, ok: true, ...(result === undefined ? {} : { result }) }),
        (error) => write({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  socket.on("error", () => {
    // A disconnected worker must not stop a Codex turn already owned by Core.
  });
}

async function processRequest(
  request: CoreRpcRequest,
  registry: SessionRegistry,
  emit: (event: string, payload?: unknown) => void,
  turnJournal?: DurableTurnJournal,
): Promise<unknown> {
  if (!Number.isSafeInteger(request.id) || request.id <= 0) throw new Error("Invalid Core request id");
  if (request.version !== CORE_PROTOCOL_VERSION) throw new Error("Unsupported Core protocol version");
  const botKey = assertBotKey(request.botKey);
  const params = asRecord(request.params);

  switch (request.method) {
    case "ping":
      return { version: CORE_PROTOCOL_VERSION };
    case "registry.getOrCreate": {
      const contextKey = requireString(params.contextKey, "contextKey");
      const scoped = scopeContextKey(botKey, contextKey);
      const hadMetadata = registry.hasMetadata(scoped);
      const session = await registry.getOrCreate(scoped, {
        deferThreadStart: params.deferThreadStart === true,
      });
      return { snapshot: snapshot(session), hadMetadata };
    }
    case "registry.getReplySession": {
      const session = await registry.getReplySession(requireString(params.threadId, "threadId"));
      return { snapshot: snapshot(session) };
    }
    case "registry.resolveReplyRoute": {
      const contextKey = requireString(params.contextKey, "contextKey");
      const messageId = optionalSafeInteger(params.messageId);
      const route = registry.resolveReplyRoute(scopeContextKey(botKey, contextKey), messageId);
      return route ? { ...route, contextKey } : null;
    }
    case "registry.readPast":
      return registry.readPast(
        scopeContextKey(botKey, requireString(params.contextKey, "contextKey")),
        { maxMessages: optionalSafeInteger(params.maxMessages) },
      );
    case "registry.readPastTail":
      return registry.readPastTail(
        scopeContextKey(botKey, requireString(params.contextKey, "contextKey")),
        { maxMessages: optionalSafeInteger(params.maxMessages) },
      );
    case "registry.readLastInput":
      return registry.readLastInput(requireString(params.threadId, "threadId"));
    case "registry.markPastDelivered":
      registry.markPastDelivered(
        scopeContextKey(botKey, requireString(params.contextKey, "contextKey")),
        requireString(params.itemId, "itemId"),
      );
      return undefined;
    case "registry.resetPastDelivered":
      registry.resetPastDelivered(
        scopeContextKey(botKey, requireString(params.contextKey, "contextKey")),
      );
      return undefined;
    case "registry.readProtocolStatus":
      return registry.readProtocolStatus(optionalString(params.threadId) ?? null);
  }

  if (!request.method.startsWith("session.")) throw new Error(`Unsupported Core method: ${request.method}`);
  const target = parseTarget(params.target);
  const { session, contextKey } = await resolveSession(registry, botKey, target);

  switch (request.method) {
    case "session.snapshot":
      return { snapshot: snapshot(session) };
    case "session.newThread":
      {
        const defaults = contextKey ? registry.getProfileDefaults(contextKey) : {};
        await session.newThread(
          optionalString(params.workspace) ?? defaults.workspace,
          optionalString(params.model) ?? defaults.model,
        );
      }
      persistContext(registry, contextKey, session);
      return { snapshot: snapshot(session) };
    case "session.switchSession":
      if (contextKey) registry.assertThreadAvailable(requireString(params.threadId, "threadId"), contextKey);
      await session.switchSession(requireString(params.threadId, "threadId"));
      persistContext(registry, contextKey, session);
      return { snapshot: snapshot(session) };
    case "session.prompt": {
      const promptProvenance = trustedTurnProvenance(params.input);
      const execute = async (durableEmit: (event: string, payload?: unknown) => void): Promise<void> => {
        let accepted: { threadId: string; turnId: string } | undefined;
        const callbacks = eventCallbacks(session, durableEmit, (turnId) => {
          const threadId = session.getInfo().threadId;
          if (!threadId || !promptProvenance) return;
          accepted = { threadId, turnId };
          registry.registerTurnProvenance(threadId, turnId, promptProvenance);
        });
        try {
          await session.prompt(params.input as never, callbacks);
        } finally {
          if (accepted) registry.clearTurnProvenance(accepted.threadId, accepted.turnId);
        }
      };
      const requestKey = optionalString(params.requestKey);
      if (turnJournal && requestKey) {
        await turnJournal.run(
          requestKey,
          {
            botKey,
            contextKey: target.kind === "context" ? target.contextKey : `thread:${target.threadId}`,
            ...(session.getInfo().threadId ? { threadId: session.getInfo().threadId! } : {}),
          },
          emit,
          execute,
        );
      } else {
        await execute(emit);
      }
      persistContext(registry, contextKey, session);
      return { snapshot: snapshot(session) };
    }
    case "session.steer": {
      const turnId = await session.steer(params.input as never);
      const threadId = session.getInfo().threadId;
      const provenance = trustedTurnProvenance(params.input);
      if (turnId && threadId && provenance) {
        registry.registerTurnProvenance(threadId, turnId, provenance);
      }
      persistContext(registry, contextKey, session);
      return { turnId, snapshot: snapshot(session) };
    }
    case "session.abort":
      await session.abort();
      return { snapshot: snapshot(session) };
    case "session.rewind": {
      const result = await session.rewind(
        requireSafeInteger(params.numTurns, "numTurns"),
        optionalSafeInteger(params.terminalTimeoutMs),
      );
      persistContext(registry, contextKey, session);
      return { result, snapshot: snapshot(session) };
    }
    case "session.compactThread":
      await session.compactThread();
      return { snapshot: snapshot(session) };
    case "session.listSkills":
      return { skills: await session.listSkills(), snapshot: snapshot(session) };
    case "session.setModel": {
      const model = await session.setModel(requireString(params.slug, "slug"));
      persistContext(registry, contextKey, session);
      return { model, snapshot: snapshot(session) };
    }
    case "session.handback": {
      const result = await session.handback();
      persistContext(registry, contextKey, session);
      return { result, snapshot: snapshot(session) };
    }
    default:
      throw new Error(`Unsupported Core method: ${request.method}`);
  }
}

function eventCallbacks(
  session: CodexSessionApi,
  emit: (event: string, payload?: unknown) => void,
  onTurnAccepted?: (turnId: string) => void,
): CodexSessionCallbacks {
  return {
    onTurnAccepted: (turnId) => {
      onTurnAccepted?.(turnId);
      emit("turnAccepted", { turnId, snapshot: snapshot(session) });
    },
    onTextDelta: (delta) => emit("textDelta", { delta }),
    onToolStart: (toolName, toolCallId) => emit("toolStart", { toolName, toolCallId }),
    onToolUpdate: (toolCallId, partialResult) => emit("toolUpdate", { toolCallId, partialResult }),
    onToolEnd: (toolCallId, isError) => emit("toolEnd", { toolCallId, isError }),
    onHistoryWatermark: (itemId) => emit("historyWatermark", { itemId }),
    onTodoUpdate: (items) => emit("todoUpdate", { items }),
    onTurnComplete: (usage) => emit("turnComplete", { usage }),
    onAgentEnd: () => emit("agentEnd"),
  };
}

function trustedTurnProvenance(value: unknown): TrustedTurnProvenance | undefined {
  const input = asRecord(value);
  const provenance = asRecord(input.provenance);
  if (provenance.transport !== "telegram" || typeof provenance.chatId !== "string") return undefined;
  const senderUserId = optionalSafeInteger(provenance.senderUserId);
  const messageId = optionalSafeInteger(provenance.messageId);
  const messageThreadId = optionalSafeInteger(provenance.messageThreadId);
  return {
    chatId: provenance.chatId,
    ...(senderUserId ? { senderUserId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(messageThreadId ? { messageThreadId } : {}),
  };
}

async function resolveSession(
  registry: SessionRegistry,
  botKey: string,
  target: CoreSessionTarget,
): Promise<{ session: CodexSessionApi; contextKey?: string }> {
  if (target.kind === "thread") {
    return { session: await registry.getReplySession(target.threadId) };
  }
  const contextKey = scopeContextKey(botKey, target.contextKey);
  return { session: await registry.getOrCreate(contextKey, { deferThreadStart: true }), contextKey };
}

function persistContext(
  registry: SessionRegistry,
  contextKey: string | undefined,
  session: CodexSessionApi,
): void {
  if (contextKey) registry.updateMetadata(contextKey, session);
}

function snapshot(session: CodexSessionApi): SessionSnapshot {
  return {
    info: session.getInfo(),
    processing: session.isProcessing(),
    activeThread: session.hasActiveThread(),
    attached: session.isThreadAttached(),
    steerable: session.canSteer(),
    abortable: session.supportsAbort(),
  };
}

function parseTarget(value: unknown): CoreSessionTarget {
  const target = asRecord(value);
  if (target.kind === "context") {
    return { kind: "context", contextKey: requireString(target.contextKey, "target.contextKey") };
  }
  if (target.kind === "thread") {
    return { kind: "thread", threadId: requireString(target.threadId, "target.threadId") };
  }
  throw new Error("Invalid Core session target");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function requireString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireSafeInteger(value: unknown, name: string): number {
  const result = optionalSafeInteger(value);
  if (result === undefined) throw new Error(`${name} must be an integer`);
  return result;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
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

function closeServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => void rm(socketPath, { force: true }).finally(resolve));
  });
}
