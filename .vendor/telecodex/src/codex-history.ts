import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { getThreadRolloutPath } from "./codex-state.js";

export type HistoryRole = "user" | "assistant";

export interface HistoryMessage {
  itemId: string;
  turnId: string;
  role: HistoryRole;
  text: string;
  createdAt?: number;
}

export interface HistoryTurn {
  turnId: string;
  messages: HistoryMessage[];
}

export interface PastHistoryResult {
  text: string;
  lastItemId?: string;
  shownMessages: number;
  omittedMessages: number;
}

type RecordValue = Record<string, unknown>;

export function normalizeAppServerHistory(thread: unknown): HistoryTurn[] {
  const threadRecord = asRecord(thread);
  const turns = Array.isArray(threadRecord.turns) ? threadRecord.turns : [];
  const normalized: HistoryTurn[] = [];

  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn);
    const turnId = stringValue(turn.id);
    const status = stringValue(turn.status);
    if (!turnId || status === "inProgress") continue;

    const messages: HistoryMessage[] = [];
    for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
      const item = asRecord(rawItem);
      const itemId = stringValue(item.id);
      const type = stringValue(item.type);
      if (!itemId || !type) continue;

      if (type === "userMessage") {
        const text = extractUserInputText(item.content);
        if (text) messages.push({ itemId, turnId, role: "user", text });
      } else if (type === "agentMessage") {
        const text = stringValue(item.text)?.trim();
        if (text) messages.push({ itemId, turnId, role: "assistant", text });
      }
    }
    if (messages.length > 0) normalized.push({ turnId, messages });
  }

  return normalized;
}

export function readRolloutHistory(threadId: string, rolloutPath?: string): HistoryTurn[] {
  const resolvedPath = rolloutPath ?? findRolloutPath(threadId);
  if (!resolvedPath) {
    throw new Error(`Could not locate rollout JSONL for thread ${threadId}`);
  }
  return parseRolloutJsonl(readFileSync(resolvedPath, "utf8"), threadId);
}

export function parseRolloutJsonl(contents: string, threadId = "thread"): HistoryTurn[] {
  const lines = contents.split("\n");
  const turns = new Map<string, HistoryMessage[]>();
  const turnOrder: string[] = [];
  let currentTurnId: string | null = null;
  let generatedTurn = 0;
  let generatedItem = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;

    let entry: RecordValue;
    try {
      entry = JSON.parse(line) as RecordValue;
    } catch (error) {
      const isFinalNonEmptyLine = lines.slice(index + 1).every((candidate) => !candidate.trim());
      if (isFinalNonEmptyLine) break;
      throw new Error(
        `Invalid rollout JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (entry.type !== "response_item") continue;
    const payload = asRecord(entry.payload);
    const payloadType = stringValue(payload.type);

    if (payloadType === "internal_chat_message_metadata_passthrough") {
      currentTurnId =
        stringValue(payload.turn_id) ??
        stringValue(asRecord(payload.metadata).turn_id) ??
        currentTurnId;
      continue;
    }

    const role = historyRole(payload);
    if (!role) continue;
    const text = extractPayloadText(payload);
    if (!text) continue;

    if (role === "user") {
      currentTurnId =
        stringValue(payload.turn_id) ??
        stringValue(asRecord(payload.metadata).turn_id) ??
        `jsonl:${threadId}:${++generatedTurn}`;
    } else if (!currentTurnId) {
      currentTurnId = `jsonl:${threadId}:${++generatedTurn}`;
    }

    if (!turns.has(currentTurnId)) {
      turns.set(currentTurnId, []);
      turnOrder.push(currentTurnId);
    }
    const itemId =
      stringValue(payload.id) ??
      stringValue(entry.id) ??
      `jsonl-item:${threadId}:${++generatedItem}`;
    turns.get(currentTurnId)!.push({
      itemId,
      turnId: currentTurnId,
      role,
      text,
      ...(typeof entry.timestamp === "number" ? { createdAt: entry.timestamp } : {}),
    });
  }

  return turnOrder
    .map((turnId) => ({ turnId, messages: turns.get(turnId) ?? [] }))
    .filter((turn) => turn.messages.length > 0);
}

export function buildPastHistory(
  turns: HistoryTurn[],
  watermark?: string,
  options: { maxMessages?: number } = {},
): PastHistoryResult {
  const maxMessages = options.maxMessages ?? 5;
  const flattened = turns.flatMap((turn) => turn.messages);
  const watermarkIndex = watermark
    ? flattened.findIndex((message) => message.itemId === watermark)
    : -1;
  const unseenMessages = flattened.slice(watermarkIndex >= 0 ? watermarkIndex + 1 : 0);

  if (unseenMessages.length === 0) {
    return { text: "", shownMessages: 0, omittedMessages: 0 };
  }

  const selectedMessages = unseenMessages.slice(-maxMessages);
  const omittedMessages = Math.max(0, unseenMessages.length - selectedMessages.length);
  const blocks = selectedMessages.map(
    (message) => `${message.role === "user" ? "你（电脑）" : "Codex"}：${message.text}`,
  );
  const prefix = omittedMessages > 0 ? `（已省略 ${omittedMessages} 条更早消息）\n\n` : "";
  const text = `${prefix}${blocks.join("\n\n")}`;
  const lastItemId = selectedMessages.at(-1)?.itemId;

  return {
    text,
    ...(lastItemId ? { lastItemId } : {}),
    shownMessages: selectedMessages.length,
    omittedMessages,
  };
}

export function findLastUserMessage(turns: HistoryTurn[]): HistoryMessage | undefined {
  const messages = turns.flatMap((turn) => turn.messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return undefined;
}

export function findRolloutPath(threadId: string): string | null {
  const databasePath = getThreadRolloutPath(threadId);
  if (databasePath && existsSync(databasePath)) {
    return databasePath;
  }

  const codexHome = process.env.CODEX_HOME?.trim() || (process.env.HOME ? path.join(process.env.HOME, ".codex") : "");
  const sessionsRoot = codexHome ? path.join(codexHome, "sessions") : "";
  if (!sessionsRoot || !existsSync(sessionsRoot)) return null;

  const candidates: Array<{ path: string; modifiedAtMs: number }> = [];
  walkFiles(sessionsRoot, (filePath) => {
    const name = path.basename(filePath);
    if (!name.endsWith(".jsonl") || !name.includes(threadId)) return;
    try {
      candidates.push({ path: filePath, modifiedAtMs: statSync(filePath).mtimeMs });
    } catch {
      // Ignore files that disappear during the scan.
    }
  });
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  return candidates[0]?.path ?? null;
}

function walkFiles(root: string, visit: (filePath: string) => void): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(entryPath, visit);
    else if (entry.isFile()) visit(entryPath);
  }
}

function historyRole(payload: RecordValue): HistoryRole | null {
  if (payload.type === "agent_message") return "assistant";
  if (payload.type !== "message") return null;
  return payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
}

function extractPayloadText(payload: RecordValue): string {
  const direct = stringValue(payload.text)?.trim();
  if (direct) return direct;
  return extractContentText(payload.content);
}

function extractUserInputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => asRecord(entry))
    .filter((entry) => entry.type === "text")
    .map((entry) => stringValue(entry.text)?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function extractContentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => asRecord(entry))
    .filter((entry) => ["input_text", "output_text", "text"].includes(String(entry.type)))
    .map((entry) => stringValue(entry.text)?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" ? (value as RecordValue) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
