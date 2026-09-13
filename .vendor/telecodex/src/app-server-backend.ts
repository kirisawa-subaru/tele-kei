import { AppServerRpcError, type AppServerNotification, type AppServerRpc } from "./app-server-rpc.js";
import type { DynamicToolSpec } from "./dynamic-tools.js";
import type {
  AcceptedConversationInput,
  ConversationBackend,
  ConversationEvent,
  ConversationItem,
  ConversationPromptInput,
  ConversationPromptProvenance,
  ConversationThreadState,
} from "./conversation-backend.js";

type AppServerThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags?: string[] };

type AppServerTurn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  items?: ConversationItem[];
  error?: { message?: string } | null;
};

type AppServerThread = {
  id: string;
  status?: AppServerThreadStatus;
  turns?: AppServerTurn[];
};

type ThreadLoadedListResponse = {
  data: string[];
};

export type AppServerRollbackResult = {
  rolledBackTurnIds: string[];
  thread: AppServerThread;
};

type CompletionWaiter = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  observed: boolean;
};

type CompactionWaiter = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  turnId?: string;
};

const COMPACTION_TIMEOUT_MS = 5 * 60 * 1_000;

export interface AppServerBackendOptions {
  workspace: string;
  model?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  idleTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class AppServerConversationBackend implements ConversationBackend {
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private subscribed = false;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private submitTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: ConversationEvent) => void>();
  private readonly completionWaiters = new Map<string, CompletionWaiter>();
  private readonly completedTurns = new Map<string, { status: string; error?: string }>();
  private readonly terminalTurnIds = new Set<string>();
  private compactionWaiter: CompactionWaiter | null = null;
  private compactionTurnId: string | null = null;
  private compactionGuardActive = false;
  private readonly removeNotificationListener: () => void;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;

  constructor(
    private readonly rpc: AppServerRpc,
    private readonly options: AppServerBackendOptions,
  ) {
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.removeNotificationListener = rpc.onNotification((notification) =>
      this.handleNotification(notification),
    );
  }

  getState(): ConversationThreadState {
    if (!this.threadId) {
      return { threadId: null, phase: "cold", steerable: false };
    }
    if (!this.subscribed) {
      return { threadId: this.threadId, phase: "cold", steerable: false };
    }
    if (this.compactionGuardActive && !this.activeTurnId) {
      return { threadId: this.threadId, phase: "active", steerable: false };
    }
    if (this.activeTurnId) {
      return {
        threadId: this.threadId,
        phase: "active",
        activeTurnId: this.activeTurnId,
        steerable: !this.compactionGuardActive,
      };
    }
    return { threadId: this.threadId, phase: "idle", steerable: false };
  }

  bindThread(threadId: string): ConversationThreadState {
    this.ensureUsable();
    this.cancelIdleRelease();
    this.threadId = threadId;
    this.activeTurnId = null;
    this.subscribed = false;
    return this.getState();
  }

  async newThread(): Promise<ConversationThreadState> {
    this.ensureUsable();
    await this.rpc.connect();
    this.cancelIdleRelease();

    const result = await this.rpc.request<{ thread: AppServerThread }>("thread/start", {
      cwd: this.options.workspace,
      // /rewind still uses thread/rollback, which rejects paginated threads.
      historyMode: "legacy",
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.developerInstructions
        ? { developerInstructions: this.options.developerInstructions }
        : {}),
      ...(this.options.dynamicTools?.length ? { dynamicTools: this.options.dynamicTools } : {}),
    });
    this.applyThread(result.thread);
    this.subscribed = true;
    this.touchActivity();
    return this.getState();
  }

  async attach(threadId: string): Promise<ConversationThreadState> {
    this.ensureUsable();
    await this.rpc.connect();
    this.cancelIdleRelease();

    const result = await this.rpc.request<{ thread: AppServerThread }>("thread/resume", { threadId });
    this.applyThread(result.thread);
    this.subscribed = true;
    this.touchActivity();
    return this.getState();
  }

  submit(input: ConversationPromptInput): Promise<AcceptedConversationInput> {
    return this.withSubmitLock(async () => {
      this.ensureUsable();
      if (this.compactionGuardActive) {
        throw new Error("Cannot submit input while thread compaction is in progress");
      }
      await this.ensureAttached();
      this.cancelIdleRelease();

      const userInput = buildAppServerInput(input);
      const requestMetadata = buildAppServerRequestMetadata(input);
      if (userInput.length === 0) {
        throw new Error("Cannot submit an empty Codex prompt");
      }

      let retriedAfterReconcile = false;
      while (true) {
        try {
          const accepted = this.activeTurnId
            ? await this.steerActiveTurn(userInput, requestMetadata)
            : await this.startTurn(userInput, requestMetadata);
          this.touchActivity();
          return accepted;
        } catch (error) {
          if (retriedAfterReconcile || !isStateRaceError(error)) {
            throw error;
          }
          retriedAfterReconcile = true;
          await this.reconcileState();
        }
      }
    });
  }

  subscribe(handler: (event: ConversationEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  waitForTurn(turnId: string): Promise<void> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return completed.status === "failed"
        ? Promise.reject(new Error(completed.error ?? "Codex turn failed"))
        : Promise.resolve();
    }

    let waiter = this.completionWaiters.get(turnId);
    if (!waiter) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
      });
      waiter = { promise, resolve, reject, observed: false };
      this.completionWaiters.set(turnId, waiter);
    }
    waiter.observed = true;
    return waiter.promise;
  }

  async interrupt(turnId: string): Promise<void> {
    if (!this.threadId) return;
    const deadline = Date.now() + 1_000;
    while (true) {
      if (this.completedTurns.has(turnId) || this.terminalTurnIds.has(turnId)) return;
      try {
        await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId });
        return;
      } catch (error) {
        if (this.terminalTurnIds.has(turnId)) return;
        if (!isNoActiveTurnError(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => this.scheduleTimeout(resolve, 25));
      }
    }
  }

  async compact(): Promise<void> {
    this.ensureUsable();
    await this.ensureAttached();
    if (this.activeTurnId) {
      throw new Error("Cannot compact while a turn is in progress");
    }
    if (this.compactionWaiter) {
      throw new Error("Thread compaction is already in progress");
    }
    if (this.compactionGuardActive) {
      throw new Error("A previous thread compaction has not reached a terminal state");
    }

    this.cancelIdleRelease();
    this.compactionGuardActive = true;
    const threadId = this.requireThreadId();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    void promise.catch(() => {});
    const timer = this.scheduleTimeout(() => {
      const waiter = this.compactionWaiter;
      if (!waiter) return;
      this.compactionWaiter = null;
      waiter.reject(new Error("Timed out waiting for Codex thread compaction to finish"));
    }, COMPACTION_TIMEOUT_MS) as NodeJS.Timeout;
    timer.unref?.();
    this.compactionWaiter = { promise, resolve, reject, timer };

    let requestAcknowledged = false;
    try {
      await this.rpc.request("thread/compact/start", { threadId });
      requestAcknowledged = true;
      await promise;
      this.touchActivity();
    } catch (error) {
      if (!requestAcknowledged && error instanceof AppServerRpcError) {
        this.clearCompactionGuard();
      }
      throw error;
    } finally {
      this.clearCompactionWaiter();
    }
  }

  async readThread(includeTurns = true): Promise<unknown> {
    if (!this.threadId) {
      throw new Error("No Codex thread is bound to this Telegram context");
    }
    await this.rpc.connect();
    const result = await this.rpc.request<{ thread: AppServerThread }>("thread/read", {
      threadId: this.threadId,
      includeTurns,
    });
    return result.thread;
  }

  async rollback(numTurns: number): Promise<AppServerRollbackResult> {
    if (!Number.isSafeInteger(numTurns) || numTurns < 1) {
      throw new Error("Rollback count must be a positive integer; no rollback was performed");
    }
    const threadId = this.requireThreadId();
    await this.rpc.connect();
    const before = await this.rpc.request<{ thread: AppServerThread }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    const turns = before.thread.turns ?? [];
    if (turns.some((turn) => turn.status === "inProgress")) {
      throw new Error("Cannot rewind while a turn is still in progress; no rollback was performed");
    }
    if (turns.length < numTurns) {
      throw new Error(
        `Cannot rewind ${numTurns} turn${numTurns === 1 ? "" : "s"}; only ${turns.length} available. No rollback was performed`,
      );
    }

    const rolledBackTurnIds = turns.slice(-numTurns).map((turn) => turn.id);
    const result = await this.rpc.request<{ thread: AppServerThread }>("thread/rollback", {
      threadId,
      numTurns,
    });
    this.applyThread(result.thread);
    for (const turnId of rolledBackTurnIds) {
      this.completedTurns.delete(turnId);
      this.terminalTurnIds.delete(turnId);
    }
    this.touchActivity();
    return { rolledBackTurnIds, thread: result.thread };
  }

  async release(): Promise<boolean> {
    if (
      !this.threadId ||
      !this.subscribed ||
      this.activeTurnId ||
      this.compactionGuardActive ||
      this.compactionWaiter ||
      this.completionWaiters.size > 0
    ) {
      return false;
    }
    this.cancelIdleRelease();
    await this.rpc.request("thread/unsubscribe", { threadId: this.threadId });
    this.subscribed = false;
    return true;
  }

  async handback(): Promise<{ threadId: string | null; workspace: string }> {
    const info = { threadId: this.threadId, workspace: this.options.workspace };
    const threadId = this.threadId;
    if (!threadId) return info;
    if (this.activeTurnId || this.compactionGuardActive || this.compactionWaiter) {
      throw new Error("Cannot hand back a Codex thread while it is active");
    }

    // thread/unsubscribe only removes this client's event subscription. Codex
    // 0.147-0.151 keeps the resident thread loaded and retains its disk writer
    // lock, so another app-server (including Desktop) still cannot resume it.
    // Archiving unloads the resident thread; immediately unarchiving restores
    // the same rollout and thread id in a notLoaded state.
    await this.rpc.request("thread/archive", { threadId });
    try {
      await this.rpc.request("thread/unarchive", { threadId });
    } catch (error) {
      throw new Error(
        `Codex archived thread ${threadId} but could not restore it during handback; unarchive it before retrying`,
        { cause: error },
      );
    }

    const loaded = await this.rpc.request<ThreadLoadedListResponse>("thread/loaded/list", {});
    if (loaded.data.includes(threadId)) {
      throw new Error(
        `Codex restored thread ${threadId}, but the shared app-server still holds its writer lock`,
      );
    }

    this.cancelIdleRelease();
    this.subscribed = false;
    this.threadId = null;
    this.activeTurnId = null;
    this.clearCompactionGuard();
    return info;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelIdleRelease();
    this.removeNotificationListener();
    this.rejectCompaction(new Error("Codex app-server backend disposed"));
    this.clearCompactionGuard();
    this.listeners.clear();
    for (const waiter of this.completionWaiters.values()) {
      if (waiter.observed) waiter.reject(new Error("Codex app-server backend disposed"));
      else waiter.resolve();
    }
    this.completionWaiters.clear();
    this.terminalTurnIds.clear();
  }

  private async ensureAttached(): Promise<void> {
    if (!this.threadId) {
      await this.newThread();
      return;
    }
    if (!this.subscribed) {
      await this.attach(this.threadId);
    }
  }

  private async startTurn(
    userInput: unknown[],
    requestMetadata: AppServerRequestMetadata,
  ): Promise<AcceptedConversationInput> {
    const threadId = this.requireThreadId();
    const result = await this.rpc.request<{ turn: AppServerTurn }>("turn/start", {
      threadId,
      input: userInput,
      ...requestMetadata,
    });
    if (!this.completedTurns.has(result.turn.id)) {
      this.activeTurnId = result.turn.id;
      this.ensureCompletionWaiter(result.turn.id);
    }
    return { kind: "started", threadId, turnId: result.turn.id };
  }

  private async steerActiveTurn(
    userInput: unknown[],
    requestMetadata: AppServerRequestMetadata,
  ): Promise<AcceptedConversationInput> {
    const threadId = this.requireThreadId();
    const turnId = this.activeTurnId;
    if (!turnId) {
      throw new Error("No active Codex turn to steer");
    }
    const result = await this.rpc.request<{ turnId: string }>("turn/steer", {
      threadId,
      input: userInput,
      expectedTurnId: turnId,
      ...requestMetadata,
    });
    return { kind: "steered", threadId, turnId: result.turnId };
  }

  private async reconcileState(): Promise<void> {
    const threadId = this.requireThreadId();
    const result = await this.rpc.request<{ thread: AppServerThread }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    this.applyThread(result.thread);
  }

  private applyThread(thread: AppServerThread): void {
    this.threadId = thread.id;
    const activeTurn = [...(thread.turns ?? [])]
      .reverse()
      .find((turn) => turn.status === "inProgress");
    this.activeTurnId = activeTurn?.id ?? null;
    this.compactionTurnId = activeTurn?.items?.some((item) => item.type === "contextCompaction")
      ? activeTurn.id
      : null;
    this.compactionGuardActive = Boolean(this.compactionTurnId);
    if (this.activeTurnId) {
      this.ensureCompletionWaiter(this.activeTurnId);
    }
  }

  private handleNotification(notification: AppServerNotification): void {
    const params = asRecord(notification.params);
    const notificationThreadId = stringValue(params.threadId);
    if (!this.threadId || notificationThreadId !== this.threadId) {
      return;
    }

    switch (notification.method) {
      case "turn/started": {
        const turn = asRecord(params.turn);
        const turnId = stringValue(turn.id);
        if (!turnId) return;
        if (this.compactionTurnId && this.compactionTurnId !== turnId) {
          this.compactionTurnId = null;
        }
        this.activeTurnId = turnId;
        this.ensureCompletionWaiter(turnId);
        this.emit({ type: "turnStarted", threadId: this.threadId, turnId });
        break;
      }
      case "item/agentMessage/delta": {
        const turnId = stringValue(params.turnId);
        const itemId = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        if (!turnId || !itemId || delta === undefined) return;
        this.emit({
          type: "agentMessageDelta",
          threadId: this.threadId,
          turnId,
          itemId,
          delta,
        });
        break;
      }
      case "item/started":
      case "item/completed": {
        const turnId = stringValue(params.turnId);
        const item = asRecord(params.item) as ConversationItem;
        if (!turnId || !item.type) return;
        if (item.type === "contextCompaction") {
          this.compactionTurnId = turnId;
          const waiter = this.compactionWaiter;
          if (waiter) waiter.turnId = turnId;
        }
        this.emit({
          type: notification.method === "item/started" ? "itemStarted" : "itemCompleted",
          threadId: this.threadId,
          turnId,
          item,
        });
        break;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const turnId = stringValue(turn.id);
        if (!turnId) return;
        const status = stringValue(turn.status) ?? "completed";
        const error = stringValue(asRecord(turn.error).message);
        const turnItems = Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
        const compactionWaiter = this.compactionWaiter;
        const isCompactionTurn = Boolean(
          this.compactionTurnId === turnId ||
          (compactionWaiter &&
            (compactionWaiter.turnId === turnId || turnItems.some((item) => item.type === "contextCompaction"))),
        );
        const lastItemId = [...turnItems]
          .reverse()
          .map((item) => stringValue(item.id))
          .find((itemId): itemId is string => Boolean(itemId));
        if (this.activeTurnId === turnId) {
          this.activeTurnId = null;
        }
        this.completeTurn(turnId, status, error);
        if (isCompactionTurn && compactionWaiter) {
          if (status === "completed") {
            compactionWaiter.resolve();
          } else {
            compactionWaiter.reject(new Error(error ?? `Codex compaction turn ${status}`));
          }
        }
        if (isCompactionTurn) {
          this.completedTurns.delete(turnId);
          this.clearCompactionGuard();
        }
        this.emit({
          type: "turnCompleted",
          threadId: this.threadId,
          turnId,
          status,
          ...(error ? { error } : {}),
          ...(lastItemId ? { lastItemId } : {}),
        });
        this.touchActivity();
        break;
      }
      case "thread/closed": {
        this.rejectCompaction(new Error("Codex thread closed during compaction"));
        this.clearCompactionGuard();
        this.subscribed = false;
        this.activeTurnId = null;
        this.emit({ type: "threadClosed", threadId: this.threadId });
        break;
      }
      default:
        break;
    }
  }

  private ensureCompletionWaiter(turnId: string): CompletionWaiter {
    let waiter = this.completionWaiters.get(turnId);
    if (!waiter) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
      });
      waiter = { promise, resolve, reject, observed: false };
      this.completionWaiters.set(turnId, waiter);
    }
    return waiter;
  }

  private completeTurn(turnId: string, status: string, error?: string): void {
    this.terminalTurnIds.add(turnId);
    while (this.terminalTurnIds.size > 100) {
      const oldest = this.terminalTurnIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.terminalTurnIds.delete(oldest);
    }
    const waiter = this.completionWaiters.get(turnId);
    if (!waiter || !waiter.observed) {
      if (waiter) {
        this.completionWaiters.delete(turnId);
        waiter.resolve();
      }
      this.completedTurns.set(turnId, { status, ...(error ? { error } : {}) });
      return;
    }
    this.completionWaiters.delete(turnId);
    if (status === "failed") {
      waiter.reject(new Error(error ?? "Codex turn failed"));
    } else {
      waiter.resolve();
    }
  }

  private clearCompactionWaiter(): void {
    const waiter = this.compactionWaiter;
    if (!waiter) return;
    this.cancelTimeout(waiter.timer);
    this.compactionWaiter = null;
  }

  private rejectCompaction(error: Error): void {
    const waiter = this.compactionWaiter;
    if (!waiter) return;
    this.cancelTimeout(waiter.timer);
    this.compactionWaiter = null;
    waiter.reject(error);
  }

  private clearCompactionGuard(): void {
    this.compactionGuardActive = false;
    this.compactionTurnId = null;
  }

  private touchActivity(): void {
    this.cancelIdleRelease();
    if (!this.subscribed || this.activeTurnId) return;
    const timeoutMs = this.options.idleTimeoutMs ?? 60 * 60 * 1_000;
    this.idleTimer = this.scheduleTimeout(() => {
      this.idleTimer = null;
      void this.release().catch((error) => {
        console.error("Failed to release idle Codex app-server thread:", error);
        this.touchActivity();
      });
    }, timeoutMs) as NodeJS.Timeout;
    this.idleTimer.unref?.();
  }

  private cancelIdleRelease(): void {
    if (!this.idleTimer) return;
    this.cancelTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private emit(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Codex app-server backend listener failed:", error);
      }
    }
  }

  private withSubmitLock<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.submitTail.then(operation, operation);
    this.submitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireThreadId(): string {
    if (!this.threadId) throw new Error("Codex thread is not initialized");
    return this.threadId;
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error("Codex app-server backend is disposed");
  }
}

function buildAppServerInput(input: ConversationPromptInput): unknown[] {
  if (typeof input === "string") {
    return input ? [{ type: "text", text: input, text_elements: [] }] : [];
  }

  const result: unknown[] = [];
  if (input.skill) {
    result.push({ type: "skill", name: input.skill.name, path: input.skill.path });
  }
  const text = [input.stagedFileInstructions, input.text].filter(Boolean).join("\n\n");
  if (text) {
    result.push({ type: "text", text, text_elements: [] });
  }
  for (const imagePath of input.imagePaths ?? []) {
    result.push({ type: "localImage", path: imagePath });
  }
  return result;
}

type AppServerRequestMetadata = {
  additionalContext?: Record<string, { kind: "application"; value: string }>;
  clientUserMessageId?: string;
};

function buildAppServerRequestMetadata(input: ConversationPromptInput): AppServerRequestMetadata {
  if (typeof input === "string" || !input.provenance) {
    return {};
  }

  const provenance: ConversationPromptProvenance = input.provenance;
  return {
    additionalContext: {
      "telecodex.transport": {
        kind: "application",
        value: JSON.stringify(provenance),
      },
    },
    ...(provenance.messageId
      ? {
          clientUserMessageId: provenance.botKey
            ? `telegram:${provenance.botKey}:${provenance.chatId}:${provenance.messageId}`
            : `telegram:${provenance.chatId}:${provenance.messageId}`,
        }
      : {}),
  };
}

function isStateRaceError(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  const text = `${error.message} ${JSON.stringify(error.data ?? "")}`.toLowerCase();
  return (
    text.includes("active turn") ||
    text.includes("expectedturnid") ||
    text.includes("expected turn") ||
    text.includes("not steerable") ||
    text.includes("in progress")
  );
}

function isNoActiveTurnError(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  const text = `${error.message} ${JSON.stringify(error.data ?? "")}`.toLowerCase();
  return text.includes("no active turn to interrupt");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
