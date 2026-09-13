import type { CodexSessionInfo } from "./codex-session.js";

export const CORE_PROTOCOL_VERSION = 1;
export const CORE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type CoreSessionTarget =
  | { kind: "context"; contextKey: string }
  | { kind: "thread"; threadId: string };

export type SessionSnapshot = {
  info: CodexSessionInfo;
  processing: boolean;
  activeThread: boolean;
  attached: boolean;
  steerable: boolean;
  abortable: boolean;
};

export type CoreRpcRequest = {
  id: number;
  version: typeof CORE_PROTOCOL_VERSION;
  botKey: string;
  method: string;
  params?: Record<string, unknown>;
};

export type CoreRpcEvent = {
  id: number;
  event: string;
  payload?: unknown;
};

export type CoreRpcResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export function assertBotKey(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error("Invalid bot key; expected 1-32 lowercase letters, digits, _ or -");
  }
  return normalized;
}

const SCOPE_SEPARATOR = "\u001f";

export function scopeContextKey(botKey: string, contextKey: string): string {
  return `${assertBotKey(botKey)}${SCOPE_SEPARATOR}${contextKey}`;
}

export function splitScopedContextKey(value: string): { botKey: string; contextKey: string } {
  const separator = value.indexOf(SCOPE_SEPARATOR);
  if (separator === -1) return { botKey: "main", contextKey: value };
  return {
    botKey: value.slice(0, separator),
    contextKey: value.slice(separator + SCOPE_SEPARATOR.length),
  };
}
