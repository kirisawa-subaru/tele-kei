import Database from "better-sqlite3";

import { splitScopedContextKey } from "./core-protocol.js";
import type { ContextMetadata, ReplyRoute } from "./session-registry.js";

export class CoreStateStore {
  private readonly db: Database.Database;

  constructor(readonly path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  loadBindings(): ContextMetadata[] {
    const rows = this.db.prepare(`
      SELECT context_key, thread_id, workspace, model, past_watermark,
             binding_mode, desktop_relay_json, updated_at
      FROM context_bindings
      ORDER BY updated_at DESC
    `).all() as BindingRow[];
    return rows.map((row) => ({
      contextKey: row.context_key,
      threadId: row.thread_id,
      workspace: row.workspace,
      ...(row.model ? { model: row.model } : {}),
      ...(row.past_watermark ? { pastWatermark: row.past_watermark } : {}),
      ...(row.binding_mode === "desktop-relay"
        ? {
            bindingMode: "desktop-relay" as const,
            ...(row.desktop_relay_json
              ? { desktopRelay: JSON.parse(row.desktop_relay_json) as ContextMetadata["desktopRelay"] }
              : {}),
          }
        : {}),
      updatedAt: row.updated_at,
    }));
  }

  replaceBindings(bindings: ContextMetadata[]): void {
    const replace = this.db.transaction((entries: ContextMetadata[]) => {
      this.db.prepare("DELETE FROM context_bindings").run();
      const insert = this.db.prepare(`
        INSERT INTO context_bindings (
          context_key, bot_key, telegram_context_key, thread_id, workspace,
          model, past_watermark, binding_mode, desktop_relay_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        const address = splitScopedContextKey(entry.contextKey);
        insert.run(
          entry.contextKey,
          address.botKey,
          address.contextKey,
          entry.threadId,
          entry.workspace,
          entry.model ?? null,
          entry.pastWatermark ?? null,
          entry.bindingMode ?? null,
          entry.desktopRelay ? JSON.stringify(entry.desktopRelay) : null,
          entry.updatedAt,
        );
      }
    });
    try {
      replace(bindings);
    } catch (error) {
      if (String(error).includes("context_bindings.thread_id")) {
        throw new Error("A Codex thread can only be owned by one Telegram context", { cause: error });
      }
      throw error;
    }
  }

  loadReplyRoutes(): ReplyRoute[] {
    return (this.db.prepare(`
      SELECT context_key, message_id, thread_id, automation_id, created_at
      FROM reply_routes
      ORDER BY created_at ASC
    `).all() as ReplyRouteRow[]).map((row) => ({
      contextKey: row.context_key,
      messageId: row.message_id,
      threadId: row.thread_id,
      ...(row.automation_id ? { automationId: row.automation_id } : {}),
      createdAt: row.created_at,
    }));
  }

  replaceReplyRoutes(routes: ReplyRoute[]): void {
    const replace = this.db.transaction((entries: ReplyRoute[]) => {
      this.db.prepare("DELETE FROM reply_routes").run();
      const insert = this.db.prepare(`
        INSERT INTO reply_routes (
          context_key, bot_key, telegram_context_key, message_id,
          thread_id, automation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const route of entries) {
        const address = splitScopedContextKey(route.contextKey);
        insert.run(
          route.contextKey,
          address.botKey,
          address.contextKey,
          route.messageId,
          route.threadId,
          route.automationId ?? null,
          route.createdAt,
        );
      }
    });
    replace(routes);
  }

  getThreadOwner(threadId: string): { botKey: string; contextKey: string } | undefined {
    const row = this.db.prepare(`
      SELECT bot_key, telegram_context_key
      FROM context_bindings
      WHERE thread_id = ?
    `).get(threadId) as { bot_key: string; telegram_context_key: string } | undefined;
    return row ? { botKey: row.bot_key, contextKey: row.telegram_context_key } : undefined;
  }

  getTurnRequest(requestKey: string): TurnRequestRecord | undefined {
    const row = this.db.prepare(`
      SELECT request_key, bot_key, context_key, thread_id, turn_id, state,
             error, last_seq, created_at, updated_at
      FROM turn_requests WHERE request_key = ?
    `).get(requestKey) as TurnRequestRow | undefined;
    return row ? mapTurnRequest(row) : undefined;
  }

  beginTurnRequest(
    requestKey: string,
    botKey: string,
    contextKey: string,
    threadId?: string,
  ): TurnRequestRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO turn_requests (
        request_key, bot_key, context_key, thread_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?)
    `).run(requestKey, botKey, contextKey, threadId ?? null, now, now);
    return this.getTurnRequest(requestKey)!;
  }

  appendTurnEvent(requestKey: string, event: string, payload?: unknown): number {
    return this.db.transaction(() => {
      const current = this.getTurnRequest(requestKey);
      if (!current) throw new Error(`Unknown turn request: ${requestKey}`);
      const seq = current.lastSeq + 1;
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO turn_events (request_key, seq, event, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(requestKey, seq, event, payload === undefined ? null : JSON.stringify(payload), now);
      this.db.prepare(`
        UPDATE turn_requests SET last_seq = ?, updated_at = ? WHERE request_key = ?
      `).run(seq, now, requestKey);
      return seq;
    })();
  }

  listTurnEvents(requestKey: string): StoredTurnEvent[] {
    return (this.db.prepare(`
      SELECT seq, event, payload_json FROM turn_events
      WHERE request_key = ? ORDER BY seq ASC
    `).all(requestKey) as TurnEventRow[]).map((row) => ({
      seq: row.seq,
      event: row.event,
      ...(row.payload_json === null ? {} : { payload: JSON.parse(row.payload_json) as unknown }),
    }));
  }

  finishTurnRequest(requestKey: string): void {
    this.db.prepare(`
      UPDATE turn_requests SET state = 'completed', error = NULL, updated_at = ?
      WHERE request_key = ?
    `).run(Date.now(), requestKey);
  }

  failTurnRequest(requestKey: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare(`
      UPDATE turn_requests SET state = 'failed', error = ?, updated_at = ?
      WHERE request_key = ?
    `).run(message, Date.now(), requestKey);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_bindings (
        context_key TEXT PRIMARY KEY,
        bot_key TEXT NOT NULL,
        telegram_context_key TEXT NOT NULL,
        thread_id TEXT,
        workspace TEXT NOT NULL,
        model TEXT,
        past_watermark TEXT,
        binding_mode TEXT,
        desktop_relay_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS context_bindings_thread_owner
        ON context_bindings(thread_id) WHERE thread_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS context_bindings_address
        ON context_bindings(bot_key, telegram_context_key);

      CREATE TABLE IF NOT EXISTS reply_routes (
        context_key TEXT NOT NULL,
        bot_key TEXT NOT NULL,
        telegram_context_key TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        automation_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (context_key, message_id)
      );

      CREATE TABLE IF NOT EXISTS inbound_updates (
        bot_key TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        context_key TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_key, update_id)
      );

      CREATE TABLE IF NOT EXISTS turn_requests (
        request_key TEXT PRIMARY KEY,
        bot_key TEXT NOT NULL,
        context_key TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        state TEXT NOT NULL,
        final_text TEXT,
        history_item_id TEXT,
        error TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turn_events (
        request_key TEXT NOT NULL REFERENCES turn_requests(request_key) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (request_key, seq)
      );

      CREATE TABLE IF NOT EXISTS telegram_outbox (
        delivery_id TEXT PRIMARY KEY,
        bot_key TEXT NOT NULL,
        context_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id INTEGER,
        thread_id TEXT,
        turn_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        telegram_message_id INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS telegram_outbox_parts (
        delivery_id TEXT NOT NULL REFERENCES telegram_outbox(delivery_id) ON DELETE CASCADE,
        part_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        fallback_text TEXT NOT NULL,
        parse_mode TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        telegram_message_id INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (delivery_id, part_index)
      );
    `);
  }
}

type BindingRow = {
  context_key: string;
  thread_id: string | null;
  workspace: string;
  model: string | null;
  past_watermark: string | null;
  binding_mode: string | null;
  desktop_relay_json: string | null;
  updated_at: number;
};

type ReplyRouteRow = {
  context_key: string;
  message_id: number;
  thread_id: string;
  automation_id: string | null;
  created_at: number;
};

export type TurnRequestRecord = {
  requestKey: string;
  botKey: string;
  contextKey: string;
  threadId?: string;
  turnId?: string;
  state: "running" | "completed" | "failed";
  error?: string;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
};

export type StoredTurnEvent = { seq: number; event: string; payload?: unknown };

type TurnRequestRow = {
  request_key: string;
  bot_key: string;
  context_key: string;
  thread_id: string | null;
  turn_id: string | null;
  state: TurnRequestRecord["state"];
  error: string | null;
  last_seq: number;
  created_at: number;
  updated_at: number;
};

type TurnEventRow = { seq: number; event: string; payload_json: string | null };

function mapTurnRequest(row: TurnRequestRow): TurnRequestRecord {
  return {
    requestKey: row.request_key,
    botKey: row.bot_key,
    contextKey: row.context_key,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    state: row.state,
    ...(row.error ? { error: row.error } : {}),
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
