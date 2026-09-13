import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import type { AppServerStatusSnapshot } from "./app-server-status.js";
import {
  CORE_MAX_FRAME_BYTES,
  CORE_PROTOCOL_VERSION,
  assertBotKey,
  type CoreRpcEvent,
  type CoreRpcResponse,
  type CoreSessionTarget,
  type SessionSnapshot,
} from "./core-protocol.js";
import type {
  CodexPromptInput,
  CodexSessionCallbacks,
  CodexSessionInfo,
  CodexSkill,
  RewindResult,
} from "./codex-session.js";
import { listModels, type CodexModelRecord } from "./codex-state.js";
import type { PastHistoryResult } from "./codex-history.js";
import type { TelegramContextKey } from "./context-key.js";
import type { CodexSessionApi, SessionRegistryApi } from "./session-api.js";
import type { ReplyRoute } from "./session-registry.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: (event: CoreRpcEvent) => void;
  timer?: NodeJS.Timeout;
};

export class CoreRpcClient {
  private socket: Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    readonly socketPath: string,
    readonly botKey: string,
  ) {
    this.botKey = assertBotKey(botKey);
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async request<TResult>(
    method: string,
    params: Record<string, unknown> = {},
    options: { onEvent?: (event: CoreRpcEvent) => void; timeoutMs?: number } = {},
  ): Promise<TResult> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new Error("Core Router is not connected");

    const id = this.nextId++;
    const result = new Promise<TResult>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Core Router request timed out: ${method}`));
          }, timeoutMs)
        : undefined;
      timer?.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        onEvent: options.onEvent,
        timer,
      });
    });

    socket.write(`${JSON.stringify({
      id,
      version: CORE_PROTOCOL_VERSION,
      botKey: this.botKey,
      method,
      params,
    })}\n`);
    return result;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.rejectPending(new Error("Core Router connection closed"));
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      this.socket = socket;
      this.buffer = "";
      socket.setEncoding("utf8");

      const onErrorBeforeConnect = (error: Error): void => {
        cleanup();
        if (this.socket === socket) this.socket = null;
        reject(error);
      };
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        socket.off("error", onErrorBeforeConnect);
        socket.off("connect", onConnect);
      };

      socket.once("error", onErrorBeforeConnect);
      socket.once("connect", onConnect);
      socket.on("data", (chunk: string) => this.handleData(socket, chunk));
      socket.on("error", (error) => this.handleFailure(socket, error));
      socket.on("close", () => this.handleFailure(socket, new Error("Core Router disconnected")));
    });
  }

  private handleData(socket: Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > CORE_MAX_FRAME_BYTES) {
      this.handleFailure(socket, new Error("Core Router response frame is too large"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: CoreRpcResponse | CoreRpcEvent;
      try {
        message = JSON.parse(line) as CoreRpcResponse | CoreRpcEvent;
      } catch {
        this.handleFailure(socket, new Error("Core Router returned invalid JSON"));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      if ("event" in message) {
        pending.onEvent?.(message);
        continue;
      }
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    }
  }

  private handleFailure(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (!socket.destroyed) socket.destroy();
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class RemoteSessionRegistry implements SessionRegistryApi {
  private readonly rpc: CoreRpcClient;
  private readonly sessions = new Map<TelegramContextKey, RemoteCodexSession>();
  private readonly replySessions = new Map<string, RemoteCodexSession>();
  private readonly metadata = new Set<TelegramContextKey>();
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(socketPath: string, readonly botKey: string) {
    this.rpc = new CoreRpcClient(socketPath, botKey);
  }

  async initialize(): Promise<void> {
    await this.rpc.request("ping");
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<RemoteCodexSession> {
    const existing = this.sessions.get(contextKey);
    if (existing) return existing;
    const response = await this.rpc.request<{ snapshot: SessionSnapshot; hadMetadata: boolean }>(
      "registry.getOrCreate",
      { contextKey, deferThreadStart: options?.deferThreadStart === true },
    );
    const session = new RemoteCodexSession(
      this.rpc,
      { kind: "context", contextKey },
      response.snapshot,
    );
    this.sessions.set(contextKey, session);
    if (response.hadMetadata) this.metadata.add(contextKey);
    return session;
  }

  get(contextKey: TelegramContextKey): RemoteCodexSession | undefined {
    return this.sessions.get(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionApi): void {
    if (session.getInfo().threadId) this.metadata.add(contextKey);
  }

  async getReplySession(threadId: string): Promise<RemoteCodexSession> {
    const existing = this.replySessions.get(threadId);
    if (existing) return existing;
    const response = await this.rpc.request<{ snapshot: SessionSnapshot }>(
      "registry.getReplySession",
      { threadId },
    );
    const session = new RemoteCodexSession(
      this.rpc,
      { kind: "thread", threadId },
      response.snapshot,
    );
    this.replySessions.set(threadId, session);
    return session;
  }

  async resolveReplyRoute(
    contextKey: TelegramContextKey,
    repliedToMessageId: number | undefined,
  ): Promise<ReplyRoute | undefined> {
    if (!repliedToMessageId) return undefined;
    const route = await this.rpc.request<ReplyRoute | null>("registry.resolveReplyRoute", {
      contextKey,
      messageId: repliedToMessageId,
    });
    return route ?? undefined;
  }

  readPast(
    contextKey: TelegramContextKey,
    options: { maxMessages?: number } = {},
  ): Promise<PastHistoryResult> {
    return this.rpc.request("registry.readPast", { contextKey, ...options });
  }

  readPastTail(
    contextKey: TelegramContextKey,
    options: { maxMessages?: number } = {},
  ): Promise<PastHistoryResult> {
    return this.rpc.request("registry.readPastTail", { contextKey, ...options });
  }

  readLastInput(threadId: string): Promise<string> {
    return this.rpc.request("registry.readLastInput", { threadId });
  }

  async markPastDelivered(contextKey: TelegramContextKey, itemId: string): Promise<void> {
    await this.rpc.request("registry.markPastDelivered", { contextKey, itemId });
  }

  async resetPastDelivered(contextKey: TelegramContextKey): Promise<void> {
    await this.rpc.request("registry.resetPastDelivered", { contextKey });
  }

  readProtocolStatus(threadId: string | null): Promise<AppServerStatusSnapshot> {
    return this.rpc.request("registry.readProtocolStatus", { threadId });
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  close(): void {
    for (const key of this.sessions.keys()) this.onRemoveCallback?.(key);
    this.sessions.clear();
    this.replySessions.clear();
    this.rpc.close();
  }
}

export class RemoteCodexSession implements CodexSessionApi {
  constructor(
    private readonly rpc: CoreRpcClient,
    private readonly target: CoreSessionTarget,
    private state: SessionSnapshot,
  ) {}

  getInfo(): CodexSessionInfo { return { ...this.state.info }; }
  isProcessing(): boolean { return this.state.processing; }
  hasActiveThread(): boolean { return this.state.activeThread; }
  isThreadAttached(): boolean { return this.state.attached; }
  canSteer(): boolean { return this.state.steerable; }
  supportsAbort(): boolean { return this.state.abortable; }
  getCurrentWorkspace(): string { return this.state.info.workspace; }
  listModels(): CodexModelRecord[] { return listModels(); }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    const requestKey = durableRequestKey(this.rpc.botKey, input);
    try {
      const response = await this.rpc.request<{ snapshot: SessionSnapshot }>(
        "session.prompt",
        { target: this.target, input, requestKey },
        {
          timeoutMs: 0,
          onEvent: (event) => this.handlePromptEvent(event, callbacks),
        },
      );
      this.state = response.snapshot;
    } catch (error) {
      // Failed turns (including journal replays) can leave turnAccepted's busy
      // snapshot cached here. Core owns the state; a transport failure alone
      // does not prove that its turn stopped.
      try {
        this.apply(await this.rpc.request("session.snapshot", { target: this.target }));
      } catch {
        // Preserve the original prompt error when Core cannot be reached.
      }
      throw error;
    }
  }

  async abort(): Promise<void> {
    this.apply(await this.rpc.request("session.abort", { target: this.target }));
  }

  async steer(input: CodexPromptInput): Promise<string | null> {
    const response = await this.rpc.request<{ turnId: string | null; snapshot: SessionSnapshot }>(
      "session.steer",
      { target: this.target, input },
    );
    this.state = response.snapshot;
    return response.turnId;
  }

  async rewind(numTurns: number, terminalTimeoutMs?: number): Promise<RewindResult> {
    const response = await this.rpc.request<{ result: RewindResult; snapshot: SessionSnapshot }>(
      "session.rewind",
      { target: this.target, numTurns, terminalTimeoutMs },
      { timeoutMs: (terminalTimeoutMs ?? 15_000) + 30_000 },
    );
    this.state = response.snapshot;
    return response.result;
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.apply(await this.rpc.request("session.newThread", { target: this.target, workspace, model }));
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.apply(await this.rpc.request("session.switchSession", { target: this.target, threadId }));
    return this.getInfo();
  }

  async listSkills(): Promise<CodexSkill[]> {
    const response = await this.rpc.request<{ skills: CodexSkill[]; snapshot: SessionSnapshot }>(
      "session.listSkills",
      { target: this.target },
    );
    this.state = response.snapshot;
    return response.skills;
  }

  async compactThread(): Promise<void> {
    this.apply(await this.rpc.request("session.compactThread", { target: this.target }, { timeoutMs: 0 }));
  }

  async setModel(slug: string): Promise<string> {
    const response = await this.rpc.request<{ model: string; snapshot: SessionSnapshot }>(
      "session.setModel",
      { target: this.target, slug },
    );
    this.state = response.snapshot;
    return response.model;
  }

  async handback(): Promise<{ threadId: string | null; workspace: string }> {
    const response = await this.rpc.request<{
      result: { threadId: string | null; workspace: string };
      snapshot: SessionSnapshot;
    }>("session.handback", { target: this.target });
    this.state = response.snapshot;
    return response.result;
  }

  private apply(value: unknown): void {
    const response = value as { snapshot?: SessionSnapshot };
    if (response.snapshot) this.state = response.snapshot;
  }

  private handlePromptEvent(event: CoreRpcEvent, callbacks: CodexSessionCallbacks): void {
    const payload = asRecord(event.payload);
    switch (event.event) {
      case "turnAccepted":
        if (payload.snapshot) this.state = payload.snapshot as SessionSnapshot;
        callbacks.onTurnAccepted?.(stringValue(payload.turnId));
        break;
      case "textDelta": callbacks.onTextDelta(stringValue(payload.delta)); break;
      case "toolStart": callbacks.onToolStart(stringValue(payload.toolName), stringValue(payload.toolCallId)); break;
      case "toolUpdate": callbacks.onToolUpdate(stringValue(payload.toolCallId), stringValue(payload.partialResult)); break;
      case "toolEnd": callbacks.onToolEnd(stringValue(payload.toolCallId), payload.isError === true); break;
      case "historyWatermark": callbacks.onHistoryWatermark?.(stringValue(payload.itemId)); break;
      case "todoUpdate": callbacks.onTodoUpdate?.(Array.isArray(payload.items) ? payload.items as never : []); break;
      case "turnComplete": callbacks.onTurnComplete?.(payload.usage as never); break;
      case "agentEnd": callbacks.onAgentEnd(); break;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function durableRequestKey(botKey: string, input: CodexPromptInput): string {
  if (typeof input !== "string" && input.provenance?.messageId) {
    return `telegram:${botKey}:${input.provenance.chatId}:${input.provenance.messageId}`;
  }
  return `worker:${botKey}:${randomUUID()}`;
}
