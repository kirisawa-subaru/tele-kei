import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CodexSessionService } from "./codex-session.js";
import { AppServerRpcClient } from "./app-server-rpc.js";
import { AppServerStatusTracker, type AppServerStatusSnapshot } from "./app-server-status.js";
import {
  buildPastHistory,
  findLastUserMessage,
  normalizeAppServerHistory,
  readRolloutHistory,
  type HistoryTurn,
  type PastHistoryResult,
} from "./codex-history.js";
import { getThread } from "./codex-state.js";
import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import type { CodexSessionApi, SessionRegistryApi } from "./session-api.js";
import type { ConversationPromptProvenance } from "./conversation-backend.js";
import { scopeContextKey, splitScopedContextKey } from "./core-protocol.js";
import { loadBotProfileDefaults, type BotProfileDefaults } from "./bot-profile.js";
import {
  buildDynamicToolSpecs,
  createDynamicToolRequestHandler,
} from "./dynamic-tools.js";
import type { CoreStateStore } from "./state-store.js";
import {
  isActiveWriterError,
  type DesktopRelayDescriptor,
} from "./desktop-relay.js";

const REPLY_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_REPLY_ROUTES = 1_000;

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  pastWatermark?: string;
  bindingMode?: "desktop-relay";
  desktopRelay?: DesktopRelayDescriptor;
  updatedAt: number;
}

export interface ActiveThreadBinding {
  contextKey: TelegramContextKey;
  threadId: string;
  previousThreadId: string | null;
  workspace: string;
  mode: "direct" | "desktop-relay";
}

export interface DesktopRelayCapability {
  pipePath: string;
}

export interface ReplyRoute {
  contextKey: TelegramContextKey;
  messageId: number;
  threadId: string;
  automationId?: string;
  createdAt: number;
}

export type TrustedTurnProvenance = Pick<
  ConversationPromptProvenance,
  "senderUserId" | "chatId" | "messageId" | "messageThreadId"
>;

export type SessionRegistryOptions = {
  /** Import legacy single-bot JSON records into this Core Router namespace. */
  defaultBotKey?: string;
  stateStore?: CoreStateStore;
};

export class SessionRegistry implements SessionRegistryApi {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly replySessions = new Map<string, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly replyRoutes = new Map<string, ReplyRoute>();
  private readonly turnProvenance = new Map<string, TrustedTurnProvenance>();
  private readonly persistPath: string;
  private readonly replyRoutesPath: string;
  private readonly appServerRpc?: AppServerRpcClient;
  private readonly appServerStatus?: AppServerStatusTracker;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(
    private readonly config: TeleCodexConfig,
    private readonly options: SessionRegistryOptions = {},
  ) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.replyRoutesPath = path.join(config.workspace, ".telecodex", "reply-routes.json");
    if (config.codexBackend === "app-server") {
      if (!config.codexAppServerSocket) throw new Error("Missing CODEX_APP_SERVER_SOCKET");
      this.appServerRpc = new AppServerRpcClient(config.codexAppServerSocket, {
        experimentalApi: true,
        requestTimeoutMs: 155_000,
        onServerRequest: createDynamicToolRequestHandler({
          repositoryRoot: config.workspace,
          resolveThreadOwner: (threadId) => this.resolveThreadOwner(threadId),
          resolveTurnProvenance: (threadId, turnId) =>
            this.turnProvenance.get(turnProvenanceKey(threadId, turnId)),
          enabledToolsForBot: (botKey) =>
            loadBotProfileDefaults(config.workspace, botKey).dynamicToolNames ?? [],
        }),
      });
      this.appServerStatus = new AppServerStatusTracker(this.appServerRpc);
    }
    if (this.options.stateStore) {
      this.loadStateStore();
    } else {
      this.loadPersistedMetadata();
      this.loadReplyRoutes();
    }
  }

  async initialize(): Promise<void> {
    await this.appServerRpc?.connect();
  }

  registerTurnProvenance(
    threadId: string,
    turnId: string,
    provenance: TrustedTurnProvenance,
  ): void {
    this.turnProvenance.set(turnProvenanceKey(threadId, turnId), { ...provenance });
  }

  clearTurnProvenance(threadId: string, turnId: string): void {
    this.turnProvenance.delete(turnProvenanceKey(threadId, turnId));
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    const profile = this.getProfileDefaults(contextKey);
    const dynamicTools = buildDynamicToolSpecs(profile.dynamicToolNames ?? []);
    const createOptions = {
      workspace: meta?.workspace ?? profile.workspace,
      model: meta?.model ?? profile.model,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
      desktopRelay: meta?.bindingMode === "desktop-relay" ? meta.desktopRelay : undefined,
      ...(profile.developerInstructions
        ? { developerInstructions: profile.developerInstructions }
        : {}),
      ...(dynamicTools.length ? { dynamicTools } : {}),
    };
    session = this.appServerRpc
      ? await CodexSessionService.create(this.config, createOptions, this.appServerRpc)
      : await CodexSessionService.create(this.config, createOptions);

    this.sessions.set(contextKey, session);
    return session;
  }

  getProfileDefaults(contextKey: TelegramContextKey): BotProfileDefaults {
    const { botKey } = splitScopedContextKey(contextKey);
    return loadBotProfileDefaults(this.config.workspace, botKey);
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionApi): void {
    const info = session.getInfo();
    const previous = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      pastWatermark: previous?.threadId === info.threadId ? previous.pastWatermark : undefined,
      ...(info.bindingMode === "desktop-relay" && info.desktopRelay
        ? { bindingMode: info.bindingMode, desktopRelay: info.desktopRelay }
        : {}),
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  async bindActiveThread(
    threadId: string,
    requestedContextKey?: TelegramContextKey,
    desktopRelayCapability?: DesktopRelayCapability,
  ): Promise<ActiveThreadBinding> {
    if (this.config.codexBackend !== "app-server") {
      throw new Error("CLI thread binding requires the app-server backend");
    }

    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || normalizedThreadId.length > 200) {
      throw new Error("Invalid Codex thread id");
    }

    const contextKey = this.resolveActiveContextKey(requestedContextKey);
    this.assertThreadAvailable(normalizedThreadId, contextKey);
    const session = await this.getOrCreate(contextKey, { deferThreadStart: true });
    const previousThreadId = session.getInfo().threadId;

    try {
      if (previousThreadId !== normalizedThreadId) {
        if (session.isProcessing()) {
          throw new Error("Cannot replace the Telegram thread while its current turn is active");
        }
        await session.switchSession(normalizedThreadId);
      } else if (!session.isThreadAttached()) {
        // Persisted sessions start cold. Attaching here makes an already-running
        // CLI turn immediately steerable from Telegram.
        await session.resumeThread(normalizedThreadId);
      }
    } catch (error) {
      if (!isActiveWriterError(error) || !desktopRelayCapability) throw error;
      const callerThreadId = this.resolveDesktopRelayCaller(
        normalizedThreadId,
        previousThreadId,
      );
      await session.useDesktopRelay(normalizedThreadId, {
        pipePath: desktopRelayCapability.pipePath,
        callerThreadId,
      });
    }

    this.updateMetadata(contextKey, session);
    const info = session.getInfo();
    if (!info.threadId) {
      throw new Error("Codex app-server did not bind the requested thread");
    }

    return {
      contextKey,
      threadId: info.threadId,
      previousThreadId,
      workspace: info.workspace,
      mode: info.bindingMode ?? "direct",
    };
  }

  registerReplyRoute(
    threadId: string,
    requestedContextKey: TelegramContextKey,
    messageId: number,
    automationId?: string,
  ): ReplyRoute {
    if (this.config.codexBackend !== "app-server") {
      throw new Error("Reply routes require the app-server backend");
    }

    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || normalizedThreadId.length > 200) {
      throw new Error("Invalid Codex thread id");
    }
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error("Invalid Telegram message id");
    }

    const contextKey = this.resolveActiveContextKey(requestedContextKey);
    const normalizedAutomationId = automationId?.trim();
    if (normalizedAutomationId && normalizedAutomationId.length > 200) {
      throw new Error("Invalid automation id");
    }

    this.pruneReplyRoutes();
    const route: ReplyRoute = {
      contextKey,
      messageId,
      threadId: normalizedThreadId,
      ...(normalizedAutomationId ? { automationId: normalizedAutomationId } : {}),
      createdAt: Date.now(),
    };
    this.replyRoutes.set(replyRouteKey(contextKey, messageId), route);
    this.pruneReplyRoutes();
    this.persistReplyRoutes();
    return route;
  }

  resolveReplyRoute(
    contextKey: TelegramContextKey,
    repliedToMessageId: number | undefined,
  ): ReplyRoute | undefined {
    if (!repliedToMessageId) return undefined;
    this.pruneReplyRoutes();
    return this.replyRoutes.get(replyRouteKey(contextKey, repliedToMessageId));
  }

  async getReplySession(threadId: string): Promise<CodexSessionService> {
    if (this.config.codexBackend !== "app-server" || !this.appServerRpc) {
      throw new Error("Reply routes require the app-server backend");
    }

    const owner = [...this.metadata.values()].find((entry) => entry.threadId === threadId);
    if (owner) return this.getOrCreate(owner.contextKey, { deferThreadStart: true });

    const existing = this.replySessions.get(threadId);
    if (existing) return existing;

    const record = getThread(threadId);
    if (!record) {
      throw new Error(`Unknown Codex thread: ${threadId}`);
    }
    const session = await CodexSessionService.create(
      this.config,
      {
        workspace: record.cwd,
        model: record.model || undefined,
        resumeThreadId: threadId,
      },
      this.appServerRpc,
    );
    this.replySessions.set(threadId, session);
    return session;
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  assertThreadAvailable(threadId: string, contextKey: TelegramContextKey): void {
    const owner = [...this.metadata.values()].find(
      (entry) => entry.threadId === threadId && entry.contextKey !== contextKey,
    );
    if (!owner) return;
    const address = splitScopedContextKey(owner.contextKey);
    throw new Error(
      `Codex thread ${threadId} is already owned by Telegram context ${address.botKey}/${address.contextKey}`,
    );
  }

  async readPast(
    contextKey: TelegramContextKey,
    options: { maxMessages?: number } = {},
  ): Promise<PastHistoryResult> {
    const meta = this.metadata.get(contextKey);
    const threadId = this.sessions.get(contextKey)?.getInfo().threadId ?? meta?.threadId;
    if (!threadId) throw new Error("No Codex thread is bound to this Telegram context");

    const turns = await this.readThreadHistory(threadId);
    return buildPastHistory(turns, meta?.pastWatermark, options);
  }

  async readPastTail(
    contextKey: TelegramContextKey,
    options: { maxMessages?: number } = {},
  ): Promise<PastHistoryResult> {
    const meta = this.metadata.get(contextKey);
    const threadId = this.sessions.get(contextKey)?.getInfo().threadId ?? meta?.threadId;
    if (!threadId) throw new Error("No Codex thread is bound to this Telegram context");

    return buildPastHistory(await this.readThreadHistory(threadId), undefined, options);
  }

  async readLastInput(threadId: string): Promise<string> {
    const message = findLastUserMessage(await this.readThreadHistory(threadId));
    return message?.text ?? "";
  }

  markPastDelivered(contextKey: TelegramContextKey, itemId: string): void {
    const previous = this.metadata.get(contextKey);
    if (!previous) return;
    this.metadata.set(contextKey, { ...previous, pastWatermark: itemId, updatedAt: Date.now() });
    this.persistMetadata();
  }

  resetPastDelivered(contextKey: TelegramContextKey): void {
    const previous = this.metadata.get(contextKey);
    if (!previous) return;
    const { pastWatermark: _pastWatermark, ...rest } = previous;
    this.metadata.set(contextKey, { ...rest, updatedAt: Date.now() });
    this.persistMetadata();
  }

  async readProtocolStatus(threadId: string | null): Promise<AppServerStatusSnapshot> {
    return this.appServerStatus?.readSnapshot(threadId) ?? {};
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    for (const session of this.replySessions.values()) {
      session.dispose();
    }
    this.replySessions.clear();
    this.appServerStatus?.dispose();
    this.appServerRpc?.close();
  }

  private persistMetadata(): void {
    if (this.options.stateStore) {
      this.options.stateStore.replaceBindings([...this.metadata.values()]);
      return;
    }
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async readThreadHistory(threadId: string): Promise<HistoryTurn[]> {
    if (this.appServerRpc) {
      try {
        await this.appServerRpc.connect();
        const result = await this.appServerRpc.request<{ thread: unknown }>("thread/read", {
          threadId,
          includeTurns: true,
        });
        return normalizeAppServerHistory(result.thread);
      } catch (error) {
        console.warn("thread/read failed; falling back to rollout JSONL:", error);
      }
    }
    return readRolloutHistory(threadId);
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          const contextKey = this.normalizeLoadedContextKey(entry.contextKey);
          this.metadata.set(contextKey, { ...entry, contextKey });
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }

  private persistReplyRoutes(): void {
    if (this.options.stateStore) {
      this.options.stateStore.replaceReplyRoutes([...this.replyRoutes.values()]);
      return;
    }
    try {
      const dir = path.dirname(this.replyRoutesPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.replyRoutesPath, JSON.stringify([...this.replyRoutes.values()], null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist Telegram reply routes:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadReplyRoutes(): void {
    try {
      if (!existsSync(this.replyRoutesPath)) return;
      const raw = readFileSync(this.replyRoutesPath, "utf8");
      const data = JSON.parse(raw) as ReplyRoute[];
      for (const route of data) {
        if (route.contextKey && Number.isSafeInteger(route.messageId) && route.threadId) {
          const contextKey = this.normalizeLoadedContextKey(route.contextKey);
          const normalized = { ...route, contextKey };
          this.replyRoutes.set(replyRouteKey(contextKey, route.messageId), normalized);
        }
      }
      this.pruneReplyRoutes();
    } catch {
      // A malformed route store must not prevent the Telegram bridge from starting.
    }
  }

  private loadStateStore(): void {
    const bindings = this.options.stateStore!.loadBindings();
    if (bindings.length > 0) {
      for (const entry of bindings) this.metadata.set(entry.contextKey, entry);
    } else {
      this.loadPersistedMetadata();
      if (this.metadata.size > 0) this.persistMetadata();
    }

    const routes = this.options.stateStore!.loadReplyRoutes();
    if (routes.length > 0) {
      for (const route of routes) {
        this.replyRoutes.set(replyRouteKey(route.contextKey, route.messageId), route);
      }
      this.pruneReplyRoutes();
    } else {
      this.loadReplyRoutes();
      if (this.replyRoutes.size > 0) this.persistReplyRoutes();
    }
  }

  private pruneReplyRoutes(): void {
    const cutoff = Date.now() - REPLY_ROUTE_TTL_MS;
    for (const [key, route] of this.replyRoutes) {
      if (route.createdAt < cutoff) this.replyRoutes.delete(key);
    }
    if (this.replyRoutes.size <= MAX_REPLY_ROUTES) return;
    const oldestFirst = [...this.replyRoutes.entries()].sort(
      ([, left], [, right]) => left.createdAt - right.createdAt,
    );
    for (const [key] of oldestFirst.slice(0, this.replyRoutes.size - MAX_REPLY_ROUTES)) {
      this.replyRoutes.delete(key);
    }
  }

  private resolveActiveContextKey(
    requestedContextKey?: TelegramContextKey,
  ): TelegramContextKey {
    if (requestedContextKey) {
      if (!this.metadata.has(requestedContextKey)) {
        throw new Error(`Unknown Telegram context: ${requestedContextKey}`);
      }
      return requestedContextKey;
    }

    const mostRecent = this.listContexts()[0]?.contextKey;
    if (mostRecent) {
      return mostRecent;
    }

    if (this.config.telegramAllowedUserIds.length === 1) {
      return String(this.config.telegramAllowedUserIds[0]);
    }

    throw new Error("No active Telegram context; send the bot a message first or pass --context");
  }

  private resolveDesktopRelayCaller(
    targetThreadId: string,
    previousThreadId: string | null,
  ): string {
    if (previousThreadId && previousThreadId !== targetThreadId) {
      return previousThreadId;
    }
    const alternate = this.listContexts()
      .map((context) => context.threadId)
      .find((candidate): candidate is string => Boolean(candidate && candidate !== targetThreadId));
    if (alternate) return alternate;
    throw new Error(
      "Desktop relay needs a different local caller thread; send the Telegram bot a message and run telegram-active again",
    );
  }

  private resolveThreadOwner(
    threadId: string,
  ): { botKey: string; contextKey: TelegramContextKey } | undefined {
    const inMemory = [...this.metadata.values()].find((entry) => entry.threadId === threadId);
    if (inMemory) {
      const address = splitScopedContextKey(inMemory.contextKey);
      return { botKey: address.botKey, contextKey: address.contextKey };
    }
    return this.options.stateStore?.getThreadOwner(threadId);
  }

  private normalizeLoadedContextKey(contextKey: TelegramContextKey): TelegramContextKey {
    if (!this.options.defaultBotKey || contextKey.includes("\u001f")) return contextKey;
    return scopeContextKey(this.options.defaultBotKey, contextKey);
  }
}

function replyRouteKey(contextKey: TelegramContextKey, messageId: number): string {
  return `${contextKey}:${messageId}`;
}

function turnProvenanceKey(threadId: string, turnId: string): string {
  return `${threadId}\u001f${turnId}`;
}
