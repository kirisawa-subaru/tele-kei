import type { AppServerStatusSnapshot } from "./app-server-status.js";
import type {
  CodexPromptInput,
  CodexSessionCallbacks,
  CodexSessionInfo,
  CodexSkill,
  RewindResult,
} from "./codex-session.js";
import type { CodexModelRecord } from "./codex-state.js";
import type { PastHistoryResult } from "./codex-history.js";
import type { TelegramContextKey } from "./context-key.js";
import type { ReplyRoute } from "./session-registry.js";

/**
 * The Telegram worker only needs this surface.  Keeping it independent from
 * CodexSessionService lets the worker use a remote Core Router proxy without
 * importing or connecting to the Codex app-server.
 */
export interface CodexSessionApi {
  getInfo(): CodexSessionInfo;
  isProcessing(): boolean;
  hasActiveThread(): boolean;
  isThreadAttached(): boolean;
  canSteer(): boolean;
  supportsAbort(): boolean;
  getCurrentWorkspace(): string;
  prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void>;
  abort(): Promise<void>;
  steer(input: CodexPromptInput): Promise<string | null>;
  rewind(numTurns: number, terminalTimeoutMs?: number): Promise<RewindResult>;
  newThread(workspace?: string, model?: string): Promise<CodexSessionInfo>;
  switchSession(threadId: string): Promise<CodexSessionInfo>;
  listModels(): CodexModelRecord[];
  listSkills(): Promise<CodexSkill[]>;
  compactThread(): Promise<void>;
  setModel(slug: string): string | Promise<string>;
  handback(): Promise<{ threadId: string | null; workspace: string }>;
}

export interface SessionRegistryApi {
  getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionApi>;
  get(contextKey: TelegramContextKey): CodexSessionApi | undefined;
  hasMetadata(contextKey: TelegramContextKey): boolean;
  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionApi): void;
  getReplySession(threadId: string): Promise<CodexSessionApi>;
  resolveReplyRoute(
    contextKey: TelegramContextKey,
    repliedToMessageId: number | undefined,
  ): ReplyRoute | undefined | Promise<ReplyRoute | undefined>;
  readPast(
    contextKey: TelegramContextKey,
    options?: { maxMessages?: number },
  ): Promise<PastHistoryResult>;
  readPastTail(
    contextKey: TelegramContextKey,
    options?: { maxMessages?: number },
  ): Promise<PastHistoryResult>;
  readLastInput(threadId: string): Promise<string>;
  markPastDelivered(contextKey: TelegramContextKey, itemId: string): void | Promise<void>;
  resetPastDelivered(contextKey: TelegramContextKey): void | Promise<void>;
  readProtocolStatus(threadId: string | null): Promise<AppServerStatusSnapshot>;
  onRemove(callback: (contextKey: TelegramContextKey) => void): void;
}
