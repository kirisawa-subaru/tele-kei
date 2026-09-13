import {
  Codex,
  type ApprovalMode,
  type Input,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type UserInput,
} from "@openai/codex-sdk";

import type { TeleCodexConfig } from "./config.js";
import { AppServerConversationBackend } from "./app-server-backend.js";
import type { AppServerRpc } from "./app-server-rpc.js";
import type { DynamicToolSpec } from "./dynamic-tools.js";
import { discoverDesktopRelayDescriptor } from "./desktop-relay-discovery.js";
import {
  AppServerDesktopRelayClient,
  DesktopRelaySession,
  DesktopRelayUnavailableBeforeSubmitError,
  isActiveWriterError,
  type DesktopRelayDescriptor,
} from "./desktop-relay.js";
import type {
  ConversationEvent,
  ConversationItem,
  ConversationPromptInput,
} from "./conversation-backend.js";
import {
  getThread,
  listModels,
  listThreads,
  listWorkspaces,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";

export interface CodexSessionCallbacks {
  onTurnAccepted?: (turnId: string) => void;
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onHistoryWatermark?: (itemId: string) => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
}

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  model?: string;
  bindingMode?: "desktop-relay";
  desktopRelay?: DesktopRelayDescriptor;
}

export interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: "user";
  enabled: true;
}

type AppServerSkill = {
  name?: string;
  description?: string;
  shortDescription?: string | null;
  path?: string;
  scope?: "user" | "repo" | "system" | "admin";
  enabled?: boolean;
};

type AppServerSkillsListResponse = {
  data?: Array<{ cwd?: string; skills?: AppServerSkill[] }>;
};

export interface CreateOptions {
  workspace?: string;
  model?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  deferThreadStart?: boolean;
  resumeThreadId?: string;
  desktopRelay?: DesktopRelayDescriptor;
  desktopRelayResolver?: DesktopRelayResolver;
}

export type CodexPromptInput = ConversationPromptInput;
export type DesktopRelayResolver = (
  threadId: string,
  preferredCallerThreadId?: string | null,
) => DesktopRelayDescriptor | null | Promise<DesktopRelayDescriptor | null>;

export const MAX_REWIND_TURNS = 20;
export const REWIND_TERMINAL_TIMEOUT_MS = 15_000;

export type RewindResult = {
  rolledBackTurnIds: string[];
};

export class RewindTerminalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The interrupted turn did not reach a terminal state within ${Math.ceil(timeoutMs / 1_000)} seconds; no rollback was performed`,
    );
    this.name = "RewindTerminalTimeoutError";
  }
}

export class CodexSessionService {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private currentWorkspace: string;
  private abortController: AbortController | null = null;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private appServerBackend: AppServerConversationBackend | null = null;
  private appServerPromptSettled: Promise<void> | null = null;
  private desktopRelay: DesktopRelaySession | null = null;

  private constructor(
    private readonly config: TeleCodexConfig,
    private readonly appServerRpc?: AppServerRpc,
    private readonly desktopRelayResolver: DesktopRelayResolver = discoverDesktopRelayDescriptor,
    private readonly developerInstructions?: string,
    private readonly dynamicTools?: DynamicToolSpec[],
  ) {
    this.currentWorkspace = config.workspace;
  }

  static async create(
    config: TeleCodexConfig,
    options?: CreateOptions,
    appServerRpc?: AppServerRpc,
  ): Promise<CodexSessionService> {
    const service = new CodexSessionService(
      config,
      appServerRpc,
      options?.desktopRelayResolver,
      options?.developerInstructions,
      options?.dynamicTools,
    );
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.codexModel;
    if (service.usesAppServer()) {
      service.resetAppServerBackend();
    } else {
      service.resetCodexClient();
    }

    if (options?.resumeThreadId) {
      if (service.appServerBackend) {
        service.appServerBackend.bindThread(options.resumeThreadId);
        service.currentThreadId = options.resumeThreadId;
        if (options.desktopRelay) {
          service.desktopRelay = new DesktopRelaySession(
            options.resumeThreadId,
            options.desktopRelay,
            new AppServerDesktopRelayClient(options.desktopRelay, appServerRpc!),
          );
        }
        return service;
      }
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(): CodexSessionInfo {
    const info: CodexSessionInfo = {
      threadId: this.thread?.id ?? this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      ...(this.desktopRelay
        ? {
            bindingMode: "desktop-relay" as const,
            desktopRelay: this.desktopRelay.descriptor,
          }
        : {}),
    };

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null ||
      this.desktopRelay?.isProcessing() === true ||
      this.appServerBackend?.getState().phase === "active";
  }

  hasActiveThread(): boolean {
    return this.usesAppServer() ? this.currentThreadId !== null : this.thread !== null;
  }

  isThreadAttached(): boolean {
    if (this.desktopRelay) return true;
    return this.appServerBackend
      ? this.appServerBackend.getState().phase !== "cold"
      : this.thread !== null;
  }

  canSteer(): boolean {
    if (this.desktopRelay) return false;
    return this.appServerBackend?.getState().steerable ?? false;
  }

  supportsAbort(): boolean {
    return this.desktopRelay === null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (this.desktopRelay) {
      try {
        return await this.desktopRelay.prompt(input, callbacks);
      } catch (error) {
        if (!(error instanceof DesktopRelayUnavailableBeforeSubmitError)) throw error;
        const descriptor = await this.resolveDesktopRelayDescriptor(
          this.desktopRelay.threadId,
          this.desktopRelay.descriptor.callerThreadId,
        );
        if (descriptor) {
          try {
            await this.useDesktopRelay(this.desktopRelay.threadId, descriptor);
            return this.desktopRelay!.prompt(input, callbacks);
          } catch {
            // The owner may have changed between process discovery and target
            // attestation. A direct attach below is still safe because no
            // Desktop submission was attempted.
          }
        }
        await this.promoteDesktopRelayToDirect();
        return this.promptViaAppServer(input, callbacks);
      }
    }
    if (this.appServerBackend) {
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      this.appServerPromptSettled = settled;
      try {
        try {
          return await this.promptViaAppServer(input, callbacks);
        } catch (error) {
          const state = this.appServerBackend?.getState();
          const threadId = this.currentThreadId;
          if (
            !threadId ||
            state?.phase !== "cold" ||
            !isActiveWriterError(error) ||
            !(await this.tryUseDesktopRelay(threadId))
          ) {
            throw error;
          }
          return await this.desktopRelay!.prompt(input, callbacks);
        }
      } finally {
        resolveSettled();
        if (this.appServerPromptSettled === settled) this.appServerPromptSettled = null;
      }
    }
    if (!this.thread) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    let lastAgentText = "";

    // Track cumulative aggregated_output per command item to compute deltas.
    const lastCommandOutput = new Map<string, string>();

    try {
      const { events } = await this.thread.runStreamed(this.buildSdkInput(input), { signal: controller.signal });

      for await (const event of events) {
        this.handleThreadEvent(event);

        switch (event.type) {
          case "item.started":
          case "item.updated": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                lastAgentText = item.text;
                callbacks.onTextDelta(delta);
              } else {
                lastAgentText = item.text;
              }
            } else if (item.type === "command_execution") {
              if (event.type === "item.started") {
                // Record baseline so the first item.updated delta is computed correctly.
                lastCommandOutput.set(item.id, item.aggregated_output);
                callbacks.onToolStart(item.command, item.id);
              } else {
                // aggregated_output grows monotonically; pass only the new portion.
                const prev = lastCommandOutput.get(item.id) ?? "";
                const delta = computeTextDelta(prev, item.aggregated_output);
                lastCommandOutput.set(item.id, item.aggregated_output);
                if (delta) {
                  callbacks.onToolUpdate(item.id, delta);
                }
              }
            } else if (item.type === "web_search") {
              if (event.type === "item.started") {
                const label = truncate(item.query, 60);
                callbacks.onToolStart(`🔍 ${label}`, item.id);
                callbacks.onToolUpdate(item.id, item.query);
              }
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                callbacks.onTextDelta(delta);
              }
              lastAgentText = item.text;
            } else if (item.type === "command_execution") {
              // Pass any output that arrived only in the completion event (e.g. fast
              // commands that never fired item.updated).
              const prev = lastCommandOutput.get(item.id) ?? "";
              const delta = computeTextDelta(prev, item.aggregated_output);
              if (delta) {
                callbacks.onToolUpdate(item.id, delta);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "file_change") {
              const toolId = item.id;
              const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              callbacks.onToolEnd(toolId, item.status === "failed");
            } else if (item.type === "mcp_tool_call") {
              callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
              if (item.error) {
                callbacks.onToolUpdate(item.id, item.error.message);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "web_search") {
              callbacks.onToolEnd(item.id, false);
            } else if (item.type === "error") {
              callbacks.onToolStart("⚠️ error", item.id);
              callbacks.onToolUpdate(item.id, item.message);
              callbacks.onToolEnd(item.id, true);
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "turn.completed": {
            // Deliver usage BEFORE onAgentEnd so that
            // finalizeResponse() can read lastTurnUsage when building the
            // final message text.
            const u = event.usage;
            callbacks.onTurnComplete?.({
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              outputTokens: u.output_tokens,
            });
            callbacks.onAgentEnd();
            break;
          }
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  async abort(): Promise<void> {
    if (this.desktopRelay) {
      throw new Error("Abort is not available while this thread is using Desktop relay");
    }
    const appState = this.appServerBackend?.getState();
    if (this.appServerBackend && appState?.activeTurnId) {
      await this.appServerBackend.interrupt(appState.activeTurnId);
      return;
    }
    this.abortController?.abort();
  }

  async steer(input: CodexPromptInput): Promise<string | null> {
    if (!this.appServerBackend?.getState().steerable) return null;
    const accepted = await this.appServerBackend.submit(input);
    return accepted.kind === "steered" ? accepted.turnId : null;
  }

  async rewind(
    numTurns: number,
    terminalTimeoutMs = REWIND_TERMINAL_TIMEOUT_MS,
  ): Promise<RewindResult> {
    if (!Number.isSafeInteger(numTurns) || numTurns < 1 || numTurns > MAX_REWIND_TURNS) {
      throw new Error(`Rewind count must be an integer from 1 through ${MAX_REWIND_TURNS}`);
    }
    const backend = this.appServerBackend;
    if (this.desktopRelay) {
      throw new Error("Rewind is not available while this thread is using Desktop relay");
    }
    if (!backend) {
      throw new Error("Rewind requires the Codex app-server backend");
    }
    if (!this.currentThreadId) {
      throw new Error("No Codex thread is bound to this Telegram context");
    }

    const appState = backend.getState();
    const activeTurnId = appState.activeTurnId;
    const localPromptSettled = this.appServerPromptSettled;
    const externalTurnSettled = activeTurnId && !localPromptSettled
      ? backend.waitForTurn(activeTurnId)
      : null;

    if (localPromptSettled || activeTurnId || this.abortController) {
      if (activeTurnId) {
        await backend.interrupt(activeTurnId);
      } else {
        this.abortController?.abort();
      }

      const terminal = localPromptSettled ?? externalTurnSettled;
      if (!terminal) {
        throw new Error("Active turn could not be observed; no rollback was performed");
      }
      await waitForRewindTerminal(terminal, terminalTimeoutMs);
    }

    const result = await backend.rollback(numTurns);
    return { rolledBackTurnIds: result.rolledBackTurnIds };
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    if (this.usesAppServer()) {
      this.clearDesktopRelay();
      await this.appServerBackend?.release();
      this.appServerBackend?.dispose();
      this.currentWorkspace = effectiveWorkspace;
      this.currentModel = effectiveModel;
      this.resetAppServerBackend();
      const state = await this.appServerBackend!.newThread();
      this.currentThreadId = state.threadId;
      return this.getInfo();
    }
    this.thread = this.getCodex().startThread(this.buildThreadOptions(effectiveWorkspace, effectiveModel));
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = this.thread.id ?? null;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");

    if (this.appServerBackend) {
      try {
        const state = await this.appServerBackend.attach(threadId);
        this.clearDesktopRelay();
        this.currentThreadId = state.threadId;
        return this.getInfo();
      } catch (error) {
        if (!isActiveWriterError(error) || !(await this.tryUseDesktopRelay(threadId))) {
          throw error;
        }
        return this.getInfo();
      }
    }

    this.thread = this.getCodex().resumeThread(
      threadId,
      this.buildThreadOptions(this.currentWorkspace, this.currentModel),
    );
    this.currentThreadId = threadId;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || undefined;

    if (this.appServerBackend) {
      const previousThreadId = this.currentThreadId;
      await this.appServerBackend.release();
      try {
        const state = await this.appServerBackend.attach(threadId);
        this.clearDesktopRelay();
        this.currentWorkspace = workspace;
        this.currentThreadId = state.threadId;
        if (model) this.currentModel = model;
        return this.getInfo();
      } catch (error) {
        if (
          !isActiveWriterError(error) ||
          !(await this.tryUseDesktopRelay(threadId, previousThreadId))
        ) {
          throw error;
        }
        return this.getInfo();
      }
    }

    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model));
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    return listThreads(limit ?? 20);
  }

  listWorkspaces(): string[] {
    return listWorkspaces();
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  async listSkills(): Promise<CodexSkill[]> {
    if (!this.appServerRpc || !this.usesAppServer()) {
      throw new Error("Skill invocation requires the Codex app-server backend");
    }
    await this.appServerRpc.connect();
    const result = await this.appServerRpc.request<AppServerSkillsListResponse>("skills/list", {
      cwds: [this.currentWorkspace],
      forceReload: true,
    });

    return (result.data ?? [])
      .flatMap((entry) => entry.skills ?? [])
      .filter(
        (skill): skill is AppServerSkill & {
          name: string;
          description: string;
          path: string;
          scope: "user";
          enabled: true;
        } =>
          skill.scope === "user" &&
          skill.enabled === true &&
          Boolean(skill.name) &&
          Boolean(skill.path),
      )
      .map((skill) => ({
        name: skill.name,
        description: skill.description ?? "",
        ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
        path: skill.path,
        scope: skill.scope,
        enabled: skill.enabled,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async compactThread(): Promise<void> {
    this.ensureIdle("compact the current thread");
    if (this.desktopRelay) {
      throw new Error("Compact is not available while this thread is using Desktop relay");
    }
    if (!this.appServerBackend) {
      throw new Error("Thread compaction requires the Codex app-server backend");
    }
    if (!this.currentThreadId) {
      throw new Error("No active thread to compact");
    }
    await this.appServerBackend.compact();
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  async handback(): Promise<{ threadId: string | null; workspace: string }> {
    this.ensureIdle("hand back the current thread");
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    if (this.desktopRelay) {
      // Desktop already owns the writer. Drop the Telegram projection without
      // trying to archive a thread in the unrelated shared app-server.
      this.clearDesktopRelay();
      this.appServerBackend?.dispose();
      this.resetAppServerBackend();
    } else if (this.appServerBackend) {
      // Do not clear local or persisted binding state until the backend has
      // confirmed that another app-server can acquire the writer.
      await this.appServerBackend.handback();
    }
    this.thread = null;
    this.currentThreadId = null;
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.clearDesktopRelay();
    this.appServerBackend?.dispose();
    this.thread = null;
    this.currentThreadId = null;
  }

  private usesAppServer(): boolean {
    return this.config.codexBackend === "app-server";
  }

  async useDesktopRelay(
    threadId: string,
    descriptor: DesktopRelayDescriptor,
  ): Promise<CodexSessionInfo> {
    this.ensureIdle("switch to Desktop relay");
    if (!this.appServerRpc) {
      throw new Error("Desktop relay requires the shared app-server RPC client");
    }
    const relay = new DesktopRelaySession(
      threadId,
      descriptor,
      new AppServerDesktopRelayClient(descriptor, this.appServerRpc),
    );
    try {
      await relay.probe();
      await this.appServerBackend?.release();
      this.clearDesktopRelay();
      this.appServerBackend?.bindThread(threadId);
      const record = getThread(threadId);
      this.currentThreadId = threadId;
      if (record?.cwd) this.currentWorkspace = record.cwd;
      if (record?.model) this.currentModel = record.model;
      this.desktopRelay = relay;
      return this.getInfo();
    } catch (error) {
      relay.close();
      throw error;
    }
  }

  private async tryUseDesktopRelay(
    threadId: string,
    preferredCallerThreadId?: string | null,
  ): Promise<boolean> {
    const descriptor = await this.resolveDesktopRelayDescriptor(
      threadId,
      preferredCallerThreadId,
    );
    if (!descriptor) return false;
    try {
      await this.useDesktopRelay(threadId, descriptor);
      return true;
    } catch {
      return false;
    }
  }

  private resolveDesktopRelayDescriptor(
    threadId: string,
    preferredCallerThreadId?: string | null,
  ): Promise<DesktopRelayDescriptor | null> {
    return Promise.resolve(this.desktopRelayResolver(threadId, preferredCallerThreadId));
  }

  private resetAppServerBackend(): void {
    if (!this.appServerRpc) {
      throw new Error("CODEX_BACKEND=app-server requires a shared app-server RPC client");
    }
    this.appServerBackend = new AppServerConversationBackend(this.appServerRpc, {
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      developerInstructions: this.developerInstructions,
      dynamicTools: this.dynamicTools,
      idleTimeoutMs: this.config.codexThreadIdleTimeoutMs ?? 60 * 60 * 1_000,
    });
  }

  private async promoteDesktopRelayToDirect(): Promise<void> {
    const relay = this.desktopRelay;
    const threadId = relay?.threadId;
    if (!relay || !threadId || !this.appServerBackend) {
      throw new Error("Desktop relay cannot promote without a bound app-server thread");
    }
    try {
      const state = await this.appServerBackend.attach(threadId);
      this.currentThreadId = state.threadId;
      this.clearDesktopRelay();
    } catch (error) {
      if (isActiveWriterError(error)) {
        throw new Error(
          "Codex Desktop relay is unavailable, but Desktop still owns this thread. Run telegram-active again from the Desktop thread.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private clearDesktopRelay(): void {
    this.desktopRelay?.close();
    this.desktopRelay = null;
  }

  private async promptViaAppServer(
    input: CodexPromptInput,
    callbacks: CodexSessionCallbacks,
  ): Promise<void> {
    const backend = this.appServerBackend;
    if (!backend) throw new Error("Codex app-server backend is not initialized");
    if (this.abortController) throw new Error("A Codex turn is already in progress");

    const controller = new AbortController();
    this.abortController = controller;
    let acceptedTurnId: string | null = null;
    const streamedAgentText = new Map<string, string>();
    const unsubscribe = backend.subscribe((event) => {
      if (acceptedTurnId && "turnId" in event && event.turnId !== acceptedTurnId) return;
      this.handleAppServerEvent(event, callbacks, streamedAgentText);
    });

    try {
      const accepted = await backend.submit(input);
      acceptedTurnId = accepted.kind === "queued" ? accepted.afterTurnId : accepted.turnId;
      this.currentThreadId = accepted.threadId;
      callbacks.onTurnAccepted?.(acceptedTurnId);
      if (controller.signal.aborted) {
        await backend.interrupt(acceptedTurnId);
      }
      await backend.waitForTurn(acceptedTurnId);
      callbacks.onAgentEnd();
    } finally {
      unsubscribe();
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private handleAppServerEvent(
    event: ConversationEvent,
    callbacks: CodexSessionCallbacks,
    streamedAgentText: Map<string, string>,
  ): void {
    if (event.type === "turnCompleted") {
      if (event.lastItemId) callbacks.onHistoryWatermark?.(event.lastItemId);
      return;
    }
    if (event.type === "agentMessageDelta") {
      streamedAgentText.set(event.itemId, `${streamedAgentText.get(event.itemId) ?? ""}${event.delta}`);
      callbacks.onTextDelta(event.delta);
      return;
    }
    if (event.type === "itemStarted") {
      const item = event.item;
      const id = stringField(item, "id") ?? `${event.turnId}:${item.type ?? "item"}`;
      if (item.type === "commandExecution") {
        callbacks.onToolStart(stringField(item, "command") ?? "command", id);
      } else if (item.type === "mcpToolCall") {
        callbacks.onToolStart(
          `mcp:${stringField(item, "server") ?? "server"}/${stringField(item, "tool") ?? "tool"}`,
          id,
        );
      }
      return;
    }
    if (event.type !== "itemCompleted") return;

    const item = event.item;
    const id = stringField(item, "id") ?? `${event.turnId}:${item.type ?? "item"}`;
    if (item.type === "agentMessage") {
      const completedText = stringField(item, "text") ?? "";
      const missingText = computeTextDelta(streamedAgentText.get(id) ?? "", completedText);
      if (missingText) callbacks.onTextDelta(missingText);
      streamedAgentText.set(id, completedText);
    } else if (item.type === "commandExecution") {
      const output = stringField(item, "aggregatedOutput") ?? stringField(item, "aggregated_output");
      if (output) callbacks.onToolUpdate(id, output);
      callbacks.onToolEnd(id, stringField(item, "status") === "failed");
    } else if (item.type === "fileChange") {
      callbacks.onToolStart("file_change", id);
      callbacks.onToolEnd(id, stringField(item, "status") === "failed");
    } else if (item.type === "mcpToolCall") {
      const error = recordField(item, "error");
      const message = stringField(error, "message");
      if (message) callbacks.onToolUpdate(id, message);
      callbacks.onToolEnd(id, stringField(item, "status") === "failed");
    }
  }

  private buildSdkInput(input: CodexPromptInput): Input {
    if (typeof input === "string") {
      return input;
    }
    if (input.skill) {
      throw new Error("Skill invocation requires the Codex app-server backend");
    }

    const parts: UserInput[] = [];
    const textParts: string[] = [];

    if (input.provenance) {
      textParts.push(`[TeleCodex transport provenance]\n${JSON.stringify(input.provenance)}`);
    }
    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "local_image", path: imagePath });
    }

    if (parts.length === 0) {
      return "";
    }
    if (parts.length === 1 && parts[0]?.type === "text") {
      return parts[0].text;
    }
    return parts;
  }

  private buildThreadOptions(workspace: string, model?: string): {
    model?: string;
    sandboxMode: SandboxMode;
    workingDirectory: string;
    approvalPolicy: ApprovalMode;
    skipGitRepoCheck: true;
  } {
    const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
    const options = {
      model: effectiveModel,
      sandboxMode: this.config.codexSandboxMode,
      workingDirectory: workspace,
      approvalPolicy: this.config.codexApprovalPolicy,
      skipGitRepoCheck: true as const,
    };
    return options;
  }

  private ensureIdle(action: string): void {
    if (
      this.abortController ||
      this.desktopRelay?.isProcessing() ||
      this.appServerBackend?.getState().phase === "active"
    ) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private handleThreadEvent(event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.currentThreadId = event.thread_id;
    }
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.resetCodexClient();
    }

    return this.codex!;
  }

  private resetCodexClient(): void {
    this.codex = new Codex({
      apiKey: this.config.codexApiKey,
      config: {
        approval_policy: this.config.codexApprovalPolicy,
        ...(this.developerInstructions
          ? { developer_instructions: this.developerInstructions }
          : {}),
      },
      env: buildCodexEnv(this.config.codexApiKey),
    });
  }
}

function buildCodexEnv(apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  return env;
}

async function waitForRewindTerminal(terminal: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      terminal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new RewindTerminalTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function stringField(value: ConversationItem, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function recordField(value: ConversationItem, key: string): ConversationItem {
  const field = value[key];
  return field && typeof field === "object" ? field as ConversationItem : {};
}
