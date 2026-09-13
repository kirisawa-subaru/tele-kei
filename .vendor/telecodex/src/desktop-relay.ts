import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { CodexSessionCallbacks } from "./codex-session.js";
import type { AppServerRpc } from "./app-server-rpc.js";
import type { ConversationPromptInput } from "./conversation-backend.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WAIT_SLICE_MS = 120_000;
const REQUIRED_TOOLS = ["read_thread", "send_message_to_thread", "wait_threads"] as const;
const DEFAULT_DESKTOP_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";

export interface DesktopRelayDescriptor {
  pipePath: string;
  callerThreadId: string;
  nodePath?: string;
  serverPath?: string;
}

type AppTool = {
  name: string;
};

type AppToolContentItem = {
  type: "text" | "image" | "audio";
  text?: string;
};

type AppToolCallResponse = {
  content: AppToolContentItem[];
  isError?: boolean;
};

type McpResponse = {
  id: number | string;
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type DesktopWaitPoll = {
  cursor?: string;
  changed?: boolean;
  thread?: { id?: string; status?: { type?: string } };
  latestTurn?: {
    id?: string;
    status?: string;
    error?: string | null;
  } | null;
  latestAssistantMessageId?: string | null;
  latestAssistantMessage?: {
    id?: string;
    turnId?: string;
    phase?: string;
    text?: string;
  } | null;
};

export type DesktopWaitResult = {
  timedOut?: boolean;
  wake?: {
    reason?: string;
    threadId?: string;
    turnId?: string;
    hostId?: string;
  } | null;
  polls?: DesktopWaitPoll[];
};

type DesktopReadResult = {
  thread?: { id?: string; status?: { type?: string } };
  turns?: Array<{
    id?: string;
    status?: string;
    error?: string | null;
    items?: Array<Record<string, unknown>>;
  }>;
};

export interface DesktopRelayClient {
  probe(): Promise<void>;
  snapshot(threadId: string, afterCursor?: string): Promise<DesktopWaitResult>;
  sendMessage(threadId: string, prompt: string): Promise<unknown>;
  readLatestTurn(threadId: string): Promise<DesktopReadResult>;
  close(): void;
}

export type DesktopRelayCommandRequest =
  | { operation: "probe"; descriptor: DesktopRelayDescriptor }
  | {
      operation: "snapshot";
      descriptor: DesktopRelayDescriptor;
      threadId: string;
      afterCursor?: string;
    }
  | {
      operation: "sendMessage";
      descriptor: DesktopRelayDescriptor;
      threadId: string;
      prompt: string;
    }
  | {
      operation: "readLatestTurn";
      descriptor: DesktopRelayDescriptor;
      threadId: string;
    };

export type DesktopRelayCommandResult =
  | { ok: true; result?: unknown }
  | { ok: false; error: string };

export class DesktopRelayUnavailableBeforeSubmitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DesktopRelayUnavailableBeforeSubmitError";
  }
}

export class DesktopRelayDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DesktopRelayDeliveryError";
  }
}

/**
 * Client for Codex Desktop's bundled app-tools adapter. We intentionally run
 * the adapter shipped with the installed Desktop build instead of copying its
 * private native-pipe handshake. The public side of the adapter is MCP JSONL,
 * and every required tool is feature-detected before a binding is accepted.
 */
export class DesktopAppToolsClient implements DesktopRelayClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private readonly pending = new Map<number | string, PendingRequest>();
  private toolsByName: Map<string, AppTool> | null = null;
  private closed = false;
  private readonly nodePath: string;
  private readonly serverPath: string;

  constructor(
    private readonly pipePath: string,
    private readonly callerThreadId: string,
    options: { nodePath?: string; serverPath?: string } = {},
  ) {
    this.nodePath = options.nodePath ?? path.join(DEFAULT_DESKTOP_RESOURCES, "cua_node", "bin", "node");
    this.serverPath = options.serverPath ?? path.join(
      DEFAULT_DESKTOP_RESOURCES,
      "plugins",
      "openai-bundled",
      "plugins",
      "codex-app-tools",
      "server.mjs",
    );
  }

  async probe(): Promise<void> {
    const tools = await this.listTools();
    const missing = REQUIRED_TOOLS.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      throw new Error(`Codex Desktop relay is missing required tools: ${missing.join(", ")}`);
    }
  }

  snapshot(threadId: string, afterCursor?: string): Promise<DesktopWaitResult> {
    return this.callJsonTool<DesktopWaitResult>(
      "wait_threads",
      {
        targets: [{ threadId, ...(afterCursor ? { afterCursor } : {}) }],
        timeoutMs: afterCursor ? WAIT_SLICE_MS : 0,
      },
      afterCursor ? WAIT_SLICE_MS + 15_000 : DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  sendMessage(threadId: string, prompt: string): Promise<unknown> {
    return this.callTool("send_message_to_thread", { threadId, prompt });
  }

  readLatestTurn(threadId: string): Promise<DesktopReadResult> {
    return this.callJsonTool<DesktopReadResult>("read_thread", {
      threadId,
      turnLimit: 1,
      includeOutputs: false,
      maxOutputCharsPerItem: 20_000,
    });
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    child?.stdin.end();
    child?.kill("SIGTERM");
    this.rejectPending(new Error("Codex Desktop relay closed"));
  }

  private async callJsonTool<TResult>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TResult> {
    const response = await this.callTool(name, args, timeoutMs);
    const text = response.content.find((item) => item.type === "text")?.text;
    if (!text) {
      throw new Error(`Codex Desktop tool ${name} returned no text result`);
    }
    try {
      return JSON.parse(text) as TResult;
    } catch (error) {
      throw new Error(`Codex Desktop tool ${name} returned malformed JSON`, { cause: error });
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<AppToolCallResponse> {
    const tool = (await this.listTools()).get(name);
    if (!tool) {
      throw new Error(`Codex Desktop relay tool is unavailable: ${name}`);
    }
    const result = await this.request<AppToolCallResponse>(
      "tools/call",
      {
        arguments: args,
        name: tool.name,
        _meta: { threadId: this.callerThreadId },
      },
      timeoutMs,
    );
    if (result.isError) {
      const detail = result.content
        .filter((item) => item.type === "text" && item.text)
        .map((item) => item.text)
        .join("\n")
        .trim();
      throw new Error(detail || `Codex Desktop tool ${name} failed`);
    }
    return result;
  }

  private async listTools(): Promise<Map<string, AppTool>> {
    if (this.toolsByName) return this.toolsByName;
    const response = await this.request<{ tools?: AppTool[] }>("tools/list", {
      cursor: undefined,
    });
    this.toolsByName = new Map(
      (response.tools ?? [])
        .filter((tool) => tool.name)
        .map((tool) => [tool.name, tool]),
    );
    return this.toolsByName;
  }

  private async request<TResult>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TResult> {
    await this.start();
    return this.sendRequest<TResult>(method, params, timeoutMs);
  }

  private sendRequest<TResult>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<TResult> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Codex Desktop relay is not connected");
    }

    const id = this.nextId++;
    const promise = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex Desktop relay request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
    });

    try {
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return promise;
  }

  private async start(): Promise<void> {
    if (this.child && !this.child.killed && this.child.stdin.writable) return;
    if (this.closed) throw new Error("Codex Desktop relay is closed");
    if (this.startPromise) return this.startPromise;

    const child = spawn(
      this.nodePath,
      [this.serverPath],
      {
        cwd: path.dirname(this.serverPath),
        env: {
          ...process.env,
          CODEX_APP_TOOLS_PIPE_PATH: this.pipePath,
          CODEX_MCP_NODE_PATH: this.nodePath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(child, chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000);
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("exit", (code, signal) => this.handleExit(
      child,
      new Error(
        `Codex Desktop relay adapter exited (${signal ?? code ?? "unknown"})${
          this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""
        }`,
      ),
    ));

    this.startPromise = (async () => {
      await this.sendRequest(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "telecodex-desktop-relay", version: "0.1.0" },
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (!this.child || !this.child.stdin.writable) {
        throw new Error("Codex Desktop relay adapter stopped during initialization");
      }
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`);
    })().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private handleStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;

      let response: McpResponse;
      try {
        response = JSON.parse(line) as McpResponse;
      } catch {
        this.handleExit(child, new Error("Codex Desktop relay adapter returned invalid JSON"));
        child.kill("SIGTERM");
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.toolsByName = null;
    this.stdoutBuffer = "";
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Production relay client. Codex Desktop accepts its capability socket only
 * from the trusted Codex/CUA process lineage. TeleCodex therefore asks its
 * already-running signed app-server to launch one short CUA helper per relay
 * operation instead of moving the whole bridge onto Desktop's restricted Node.
 */
export class AppServerDesktopRelayClient implements DesktopRelayClient {
  private readonly nodePath: string;
  private readonly helperPath: string;

  constructor(
    private readonly descriptor: DesktopRelayDescriptor,
    private readonly rpc: AppServerRpc,
    options: { helperPath?: string } = {},
  ) {
    this.nodePath = descriptor.nodePath ?? path.join(DEFAULT_DESKTOP_RESOURCES, "cua_node", "bin", "node");
    this.helperPath = options.helperPath ?? fileURLToPath(
      new URL("./desktop-relay-command.js", import.meta.url),
    );
  }

  async probe(): Promise<void> {
    await this.run({ operation: "probe", descriptor: this.descriptor });
  }

  snapshot(threadId: string, afterCursor?: string): Promise<DesktopWaitResult> {
    return this.run({
      operation: "snapshot",
      descriptor: this.descriptor,
      threadId,
      ...(afterCursor ? { afterCursor } : {}),
    }, afterCursor ? WAIT_SLICE_MS + 20_000 : DEFAULT_REQUEST_TIMEOUT_MS + 15_000);
  }

  sendMessage(threadId: string, prompt: string): Promise<unknown> {
    return this.run({
      operation: "sendMessage",
      descriptor: this.descriptor,
      threadId,
      prompt,
    });
  }

  readLatestTurn(threadId: string): Promise<DesktopReadResult> {
    return this.run({
      operation: "readLatestTurn",
      descriptor: this.descriptor,
      threadId,
    });
  }

  close(): void {
    // Each command owns and closes its short-lived Desktop adapter.
  }

  private async run<TResult>(
    request: DesktopRelayCommandRequest,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS + 15_000,
  ): Promise<TResult> {
    await this.rpc.connect();
    const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    const response = await this.rpc.request<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>("command/exec", {
      command: [this.nodePath, this.helperPath, encoded],
      cwd: path.dirname(this.helperPath),
      timeoutMs,
      outputBytesCap: 1024 * 1024,
    });

    const line = response.stdout.trim().split("\n").filter(Boolean).at(-1);
    let envelope: DesktopRelayCommandResult | undefined;
    if (line) {
      try {
        envelope = JSON.parse(line) as DesktopRelayCommandResult;
      } catch {
        // Fall through to the bounded process error below.
      }
    }
    if (envelope?.ok) return envelope.result as TResult;
    if (envelope && !envelope.ok) throw new Error(envelope.error);

    const detail = response.stderr.trim() || response.stdout.trim();
    throw new Error(
      `Desktop relay helper exited with code ${response.exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
}

export class DesktopRelaySession {
  private processing = false;

  constructor(
    readonly threadId: string,
    readonly descriptor: DesktopRelayDescriptor,
    private readonly client: DesktopRelayClient = new DesktopAppToolsClient(
      descriptor.pipePath,
      descriptor.callerThreadId,
      { nodePath: descriptor.nodePath, serverPath: descriptor.serverPath },
    ),
  ) {}

  isProcessing(): boolean {
    return this.processing;
  }

  async probe(): Promise<void> {
    await this.client.probe();
    const snapshot = await this.client.snapshot(this.threadId);
    const poll = findPoll(snapshot, this.threadId);
    const status = poll?.thread?.status?.type;
    if (!poll || (status !== "idle" && status !== "active")) {
      throw new Error(
        `Codex Desktop does not own thread ${this.threadId}${status ? ` (status: ${status})` : ""}`,
      );
    }
  }

  async prompt(input: ConversationPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (this.processing) {
      throw new Error("A Codex Desktop relay turn is already in progress");
    }
    const prompt = buildDesktopRelayPrompt(input);
    this.processing = true;
    try {
      let cursor: string | undefined;
      let baselineTurnId: string | undefined;
      try {
        const baseline = await this.client.snapshot(this.threadId);
        const poll = findPoll(baseline, this.threadId);
        cursor = poll?.cursor;
        baselineTurnId = poll?.latestTurn?.id;
        if (!cursor) {
          throw new Error("Codex Desktop did not provide a wait cursor");
        }
      } catch (error) {
        throw new DesktopRelayUnavailableBeforeSubmitError(
          "Codex Desktop relay is unavailable before the message was sent",
          { cause: error },
        );
      }

      try {
        await this.client.sendMessage(this.threadId, prompt);
      } catch (error) {
        throw new DesktopRelayDeliveryError(
          "Codex Desktop did not confirm whether the Telegram message was accepted; it was not retried",
          { cause: error },
        );
      }

      const localTurnId = `desktop-relay-${randomUUID()}`;
      callbacks.onTurnAccepted?.(localTurnId);

      while (true) {
        let update: DesktopWaitResult;
        try {
          update = await this.client.snapshot(this.threadId, cursor);
        } catch (error) {
          throw new DesktopRelayDeliveryError(
            "Codex Desktop accepted the Telegram message, but the relay lost its completion channel",
            { cause: error },
          );
        }
        const poll = findPoll(update, this.threadId);
        cursor = poll?.cursor ?? cursor;
        const status = poll?.latestTurn?.status;
        if (status === "failed" || status === "interrupted") {
          throw new DesktopRelayDeliveryError(
            poll?.latestTurn?.error || `Codex Desktop turn ${status}`,
          );
        }

        const completed =
          update.wake?.threadId === this.threadId && update.wake.reason === "turnCompleted" ||
          poll?.changed === true &&
            status === "completed" &&
            Boolean(poll.latestTurn?.id) &&
            poll.latestTurn?.id !== baselineTurnId;
        if (completed) {
          const final = await this.readFinalMessage(poll);
          if (final.text) callbacks.onTextDelta(final.text);
          if (final.itemId) callbacks.onHistoryWatermark?.(final.itemId);
          callbacks.onAgentEnd();
          return;
        }

        if (update.wake?.threadId === this.threadId && update.wake.reason === "needsAttention") {
          throw new DesktopRelayDeliveryError(
            "Codex Desktop needs attention before this Telegram turn can continue",
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }

  close(): void {
    this.client.close();
  }

  private async readFinalMessage(
    poll: DesktopWaitPoll | undefined,
  ): Promise<{ text: string; itemId?: string }> {
    try {
      const result = await this.client.readLatestTurn(this.threadId);
      const turn = result.turns?.[0];
      const messages = (turn?.items ?? []).filter(
        (item) => item.type === "agentMessage" && typeof item.text === "string",
      );
      const selected = [...messages].reverse().find((item) => item.phase === "final_answer")
        ?? messages.at(-1);
      if (selected && typeof selected.text === "string") {
        return {
          text: selected.text,
          ...(typeof selected.id === "string" ? { itemId: selected.id } : {}),
        };
      }
    } catch {
      // The wait result already carries a final-text fallback.
    }
    return {
      text: poll?.latestAssistantMessage?.text ?? "",
      ...(poll?.latestAssistantMessageId ? { itemId: poll.latestAssistantMessageId } : {}),
    };
  }
}

export function isActiveWriterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: number }).code;
  return (code === undefined || code === -32600) && /already has an active writer|live local writer/i.test(error.message);
}

function buildDesktopRelayPrompt(input: ConversationPromptInput): string {
  if (typeof input === "string") {
    if (!input.trim()) throw new Error("Cannot relay an empty Codex prompt");
    return input;
  }
  if (input.skill) {
    throw new Error("Skill invocation is not available while this thread is using Desktop relay");
  }

  const parts: string[] = [];
  if (input.stagedFileInstructions) parts.push(input.stagedFileInstructions);
  if (input.text) parts.push(input.text);
  if (input.imagePaths?.length) {
    parts.push([
      "Telegram attached the following local image files. Inspect them with the available image tool:",
      ...input.imagePaths.map((imagePath) => `- ${imagePath}`),
    ].join("\n"));
  }
  const prompt = parts.join("\n\n").trim();
  if (!prompt) throw new Error("Cannot relay an empty Codex prompt");
  return prompt;
}

function findPoll(result: DesktopWaitResult, threadId: string): DesktopWaitPoll | undefined {
  return result.polls?.find((poll) => poll.thread?.id === threadId);
}
