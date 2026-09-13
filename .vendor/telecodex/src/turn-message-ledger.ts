export type TelegramMessageKind = "user" | "bot";

export type TelegramMessageTarget = {
  chatId: number | string;
  messageId: number;
};

type TurnMessageEntry = {
  contextKey: string;
  turnId: string;
  createdAt: number;
  targets: Map<string, { chatId: number | string; userIds: Set<number>; botIds: Set<number> }>;
};

export interface TurnMessageLedgerOptions {
  ttlMs?: number;
  maxTurnsPerContext?: number;
}

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1_000;
const DEFAULT_MAX_TURNS_PER_CONTEXT = 100;

export class TurnMessageLedger {
  private readonly entries = new Map<string, TurnMessageEntry>();
  private readonly rolledBackTurns = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxTurnsPerContext: number;

  constructor(options: TurnMessageLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTurnsPerContext = options.maxTurnsPerContext ?? DEFAULT_MAX_TURNS_PER_CONTEXT;
  }

  record(
    contextKey: string,
    turnId: string,
    chatId: number | string,
    kind: TelegramMessageKind,
    messageId: number,
    now = Date.now(),
  ): boolean {
    this.prune(now);
    const key = turnKey(contextKey, turnId);
    if (this.rolledBackTurns.has(key)) {
      return true;
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        contextKey,
        turnId,
        createdAt: now,
        targets: new Map(),
      };
      this.entries.set(key, entry);
    }

    const targetKey = String(chatId);
    let target = entry.targets.get(targetKey);
    if (!target) {
      target = { chatId, userIds: new Set(), botIds: new Set() };
      entry.targets.set(targetKey, target);
    }
    (kind === "user" ? target.userIds : target.botIds).add(messageId);
    this.enforceContextLimit(contextKey);
    return false;
  }

  markRolledBack(contextKey: string, turnIds: string[], now = Date.now()): TelegramMessageTarget[] {
    this.prune(now);
    const targets = new Map<string, TelegramMessageTarget>();

    for (const turnId of turnIds) {
      const key = turnKey(contextKey, turnId);
      this.rolledBackTurns.set(key, now);
      const entry = this.entries.get(key);
      this.entries.delete(key);
      if (!entry) continue;

      for (const target of entry.targets.values()) {
        for (const messageId of [...target.userIds, ...target.botIds]) {
          targets.set(`${String(target.chatId)}:${messageId}`, {
            chatId: target.chatId,
            messageId,
          });
        }
      }
    }

    return [...targets.values()];
  }

  removeContext(contextKey: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.contextKey === contextKey) this.entries.delete(key);
    }
    const prefix = `${contextKey}\0`;
    for (const key of this.rolledBackTurns.keys()) {
      if (key.startsWith(prefix)) this.rolledBackTurns.delete(key);
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt <= cutoff) this.entries.delete(key);
    }
    for (const [key, rolledBackAt] of this.rolledBackTurns) {
      if (rolledBackAt <= cutoff) this.rolledBackTurns.delete(key);
    }
  }

  private enforceContextLimit(contextKey: string): void {
    const matching = [...this.entries.entries()]
      .filter(([, entry]) => entry.contextKey === contextKey)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    const excess = matching.length - this.maxTurnsPerContext;
    for (let index = 0; index < excess; index += 1) {
      const key = matching[index]?.[0];
      if (key) this.entries.delete(key);
    }
  }
}

function turnKey(contextKey: string, turnId: string): string {
  return `${contextKey}\0${turnId}`;
}
