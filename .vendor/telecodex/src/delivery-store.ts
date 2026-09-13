import Database from "better-sqlite3";

const SQLITE_WRITE_RETRY_DELAYS_MS = [10, 25, 50, 100, 250];
const SQLITE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type DeliveryChunk = {
  text: string;
  fallbackText: string;
  parseMode?: "HTML";
};

export type TextDeliveryInput = {
  deliveryId: string;
  botKey: string;
  contextKey: string;
  chatId: number | string;
  topicId?: number;
  threadId?: string;
  turnId?: string;
  historyItemId?: string;
  anchorMessageId?: number;
  chunks: DeliveryChunk[];
};

export type TextDelivery = TextDeliveryInput & {
  state: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  lastError?: string;
};

export type DeliveryPart = DeliveryChunk & {
  partIndex: number;
  state: "pending" | "delivered";
  telegramMessageId?: number;
  attempts: number;
  lastError?: string;
};

export type ChoiceCallbackInput = {
  token: string;
  requestId: string;
  botKey: string;
  contextKey: string;
  userId: number;
  chatId: number;
  topicId?: number;
  threadId: string;
  turnId: string;
  prompt: string;
  optionKey: string;
  optionLabel: string;
  expiresAt: number;
};

export type ChoiceCallbackRecord = ChoiceCallbackInput & {
  state: "pending" | "active" | "claimed" | "used" | "revoked" | "expired";
  messageId?: number;
  submissionKey?: string;
  claimedAt?: number;
};

export type ChoiceCallbackRejection =
  | "unknown"
  | "expired"
  | "user_mismatch"
  | "chat_mismatch"
  | "thread_mismatch"
  | "revoked"
  | "replay"
  | "pending";

export type ChoiceCallbackClaimResult =
  | { ok: true; callback: ChoiceCallbackRecord }
  | { ok: false; reason: ChoiceCallbackRejection; callback?: ChoiceCallbackRecord };

const MAX_CHOICE_CALLBACKS = 1_024;
const CHOICE_CLAIM_LEASE_MS = 30_000;

export class TelegramDeliveryStore {
  private readonly db: Database.Database;

  constructor(readonly path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void { this.db.close(); }

  stageText(input: TextDeliveryInput): TextDelivery {
    const stage = this.db.transaction((value: TextDeliveryInput) => {
      const existing = this.get(value.deliveryId);
      if (existing && !sameTextDelivery(existing, value)) {
        throw new Error(`Delivery id ${value.deliveryId} was reused with a different immutable payload`);
      }
      const now = Date.now();
      const payload = JSON.stringify({
        historyItemId: value.historyItemId,
        anchorMessageId: value.anchorMessageId,
      });
      this.db.prepare(`
        INSERT INTO telegram_outbox (
          delivery_id, bot_key, context_key, chat_id, topic_id, thread_id,
          turn_id, kind, payload_json, state, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'text', ?, 'pending', 0, 0, ?)
        ON CONFLICT(delivery_id) DO NOTHING
      `).run(
        value.deliveryId,
        value.botKey,
        value.contextKey,
        String(value.chatId),
        value.topicId ?? null,
        value.threadId ?? null,
        value.turnId ?? null,
        payload,
        now,
      );
      const insertPart = this.db.prepare(`
        INSERT OR IGNORE INTO telegram_outbox_parts (
          delivery_id, part_index, text, fallback_text, parse_mode, state, attempts
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0)
      `);
      value.chunks.forEach((chunk, index) => insertPart.run(
        value.deliveryId,
        index,
        chunk.text,
        chunk.fallbackText,
        chunk.parseMode ?? null,
      ));
    });
    withSqliteWriteRetry(() => stage(input));
    return this.get(input.deliveryId)!;
  }

  get(deliveryId: string): TextDelivery | undefined {
    const row = this.db.prepare(`
      SELECT delivery_id, bot_key, context_key, chat_id, topic_id, thread_id,
             turn_id, payload_json, state, attempts, last_error
      FROM telegram_outbox WHERE delivery_id = ? AND kind = 'text'
    `).get(deliveryId) as DeliveryRow | undefined;
    if (!row) return undefined;
    const payload = parsePayload(row.payload_json);
    return {
      deliveryId: row.delivery_id,
      botKey: row.bot_key,
      contextKey: row.context_key,
      chatId: parseChatId(row.chat_id),
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(payload.historyItemId ? { historyItemId: payload.historyItemId } : {}),
      ...(payload.anchorMessageId ? { anchorMessageId: payload.anchorMessageId } : {}),
      chunks: this.listParts(deliveryId).map(({ partIndex: _partIndex, state: _state,
        telegramMessageId: _telegramMessageId, attempts: _attempts, lastError: _lastError, ...chunk }) => chunk),
      state: row.state,
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }

  listParts(deliveryId: string): DeliveryPart[] {
    return (this.db.prepare(`
      SELECT part_index, text, fallback_text, parse_mode, state,
             telegram_message_id, attempts, last_error
      FROM telegram_outbox_parts
      WHERE delivery_id = ? ORDER BY part_index ASC
    `).all(deliveryId) as PartRow[]).map((row) => ({
      partIndex: row.part_index,
      text: row.text,
      fallbackText: row.fallback_text,
      ...(row.parse_mode === "HTML" ? { parseMode: "HTML" as const } : {}),
      state: row.state,
      ...(row.telegram_message_id === null ? {} : { telegramMessageId: row.telegram_message_id }),
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    }));
  }

  listPending(botKey: string): TextDelivery[] {
    const ids = this.db.prepare(`
      SELECT delivery_id FROM telegram_outbox
      WHERE bot_key = ? AND kind = 'text' AND state != 'delivered'
      ORDER BY created_at ASC
    `).all(botKey) as Array<{ delivery_id: string }>;
    return ids.map((row) => this.get(row.delivery_id)).filter((value): value is TextDelivery => Boolean(value));
  }

  beginAttempt(deliveryId: string): void {
    withSqliteWriteRetry(() => this.db.prepare(`
      UPDATE telegram_outbox
      SET state = 'delivering', attempts = attempts + 1, last_error = NULL
      WHERE delivery_id = ? AND state != 'delivered'
    `).run(deliveryId));
  }

  markPartDelivered(deliveryId: string, partIndex: number, telegramMessageId: number): void {
    withSqliteWriteRetry(() => this.db.prepare(`
      UPDATE telegram_outbox_parts
      SET state = 'delivered', telegram_message_id = ?, attempts = attempts + 1, last_error = NULL
      WHERE delivery_id = ? AND part_index = ?
    `).run(telegramMessageId, deliveryId, partIndex));
  }

  markPartFailed(deliveryId: string, partIndex: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const update = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE telegram_outbox_parts
        SET attempts = attempts + 1, last_error = ?
        WHERE delivery_id = ? AND part_index = ?
      `).run(message, deliveryId, partIndex);
      this.db.prepare(`
        UPDATE telegram_outbox SET state = 'failed', last_error = ? WHERE delivery_id = ?
      `).run(message, deliveryId);
    });
    withSqliteWriteRetry(() => update());
  }

  markDelivered(deliveryId: string): void {
    withSqliteWriteRetry(() => this.db.prepare(`
      UPDATE telegram_outbox SET state = 'delivered', delivered_at = ?, last_error = NULL
      WHERE delivery_id = ?
    `).run(Date.now(), deliveryId));
  }

  stageChoiceCallbacks(callbacks: ChoiceCallbackInput[]): void {
    if (callbacks.length < 2 || callbacks.length > 4) {
      throw new Error("A choice prompt must stage 2-4 callbacks");
    }
    if (new Set(callbacks.map((callback) => callback.token)).size !== callbacks.length) {
      throw new Error("Choice callback tokens must be unique");
    }
    const group = choiceGroupKey(callbacks[0]);
    if (callbacks.some((callback) => choiceGroupKey(callback) !== group)) {
      throw new Error("Choice callbacks must belong to one exact request scope");
    }
    const stage = this.db.transaction((entries: ChoiceCallbackInput[]) => {
      const now = Date.now();
      this.db.prepare(`
        DELETE FROM telegram_choice_callbacks
        WHERE expires_at <= ?
      `).run(now);
      const count = (this.db.prepare(`
        SELECT COUNT(*) AS count FROM telegram_choice_callbacks
      `).get() as { count: number }).count;
      if (count + entries.length > MAX_CHOICE_CALLBACKS) {
        throw new Error(`Telegram choice callback store exceeds ${MAX_CHOICE_CALLBACKS} entries`);
      }
      const insert = this.db.prepare(`
        INSERT INTO telegram_choice_callbacks (
          token, request_id, bot_key, context_key, user_id, chat_id, topic_id,
          thread_id, turn_id, prompt, option_key, option_label, expires_at,
          state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      for (const entry of entries) {
        insert.run(
          entry.token,
          entry.requestId,
          entry.botKey,
          entry.contextKey,
          entry.userId,
          entry.chatId,
          entry.topicId ?? null,
          entry.threadId,
          entry.turnId,
          entry.prompt,
          entry.optionKey,
          entry.optionLabel,
          entry.expiresAt,
          now,
        );
      }
    });
    withSqliteWriteRetry(() => stage(callbacks));
  }

  activateChoiceCallbacks(tokens: string[], messageId: number): void {
    if (tokens.length < 2 || tokens.length > 4) {
      throw new Error("A choice prompt must activate 2-4 callbacks");
    }
    const placeholders = sqlPlaceholders(tokens.length);
    const activate = this.db.transaction((): boolean => {
      const rows = this.db.prepare(`
        SELECT token FROM telegram_choice_callbacks
        WHERE token IN (${placeholders}) AND state = 'pending'
      `).all(...tokens) as Array<{ token: string }>;
      if (rows.length !== tokens.length) {
        this.db.prepare(`
          UPDATE telegram_choice_callbacks SET state = 'revoked'
          WHERE token IN (${placeholders}) AND state != 'used'
        `).run(...tokens);
        return false;
      }
      const result = this.db.prepare(`
        UPDATE telegram_choice_callbacks
        SET state = 'active', message_id = ?
        WHERE token IN (${placeholders}) AND state = 'pending'
      `).run(messageId, ...tokens);
      if (result.changes !== rows.length) {
        this.db.prepare(`
          UPDATE telegram_choice_callbacks SET state = 'revoked'
          WHERE token IN (${placeholders}) AND state != 'used'
        `).run(...tokens);
        return false;
      }
      return true;
    });
    if (!withSqliteWriteRetry(() => activate())) {
      throw new Error("Choice callbacks could not be activated atomically");
    }
  }

  revokeChoiceCallbacks(tokens: string[]): void {
    if (tokens.length === 0) return;
    const placeholders = sqlPlaceholders(tokens.length);
    withSqliteWriteRetry(() => this.db.prepare(`
      UPDATE telegram_choice_callbacks SET state = 'revoked'
      WHERE token IN (${placeholders}) AND state IN ('pending', 'active', 'claimed')
    `).run(...tokens));
  }

  revokeDanglingPendingChoices(botKey: string): number {
    return withSqliteWriteRetry(() => this.db.prepare(`
      UPDATE telegram_choice_callbacks SET state = 'revoked'
      WHERE bot_key = ? AND state = 'pending'
    `).run(botKey).changes);
  }

  getChoiceCallback(token: string): ChoiceCallbackRecord | undefined {
    const row = this.db.prepare(`
      SELECT token, request_id, bot_key, context_key, user_id, chat_id, topic_id,
             thread_id, turn_id, prompt, option_key, option_label, expires_at,
             state, message_id, submission_key, claimed_at
      FROM telegram_choice_callbacks WHERE token = ?
    `).get(token) as ChoiceCallbackRow | undefined;
    return row ? mapChoiceCallback(row) : undefined;
  }

  claimChoiceCallback(
    token: string,
    target: {
      botKey: string;
      userId: number;
      chatId: number;
      topicId?: number;
      threadId: string;
    },
    submissionKey: string,
    now = Date.now(),
  ): ChoiceCallbackClaimResult {
    const claim = this.db.transaction((): ChoiceCallbackClaimResult => {
      const callback = this.getChoiceCallback(token);
      if (!callback) return { ok: false, reason: "unknown" };
      if (callback.expiresAt <= now) {
        this.db.prepare(`
          UPDATE telegram_choice_callbacks SET state = 'expired'
          WHERE token = ? AND state IN ('pending', 'active', 'claimed')
        `).run(token);
        return { ok: false, reason: "expired", callback: { ...callback, state: "expired" } };
      }
      if (callback.userId !== target.userId) return { ok: false, reason: "user_mismatch", callback };
      if (callback.botKey !== target.botKey || callback.chatId !== target.chatId) {
        return { ok: false, reason: "chat_mismatch", callback };
      }
      if (callback.topicId !== target.topicId) return { ok: false, reason: "thread_mismatch", callback };
      if (callback.threadId !== target.threadId) return { ok: false, reason: "thread_mismatch", callback };
      if (callback.state === "pending") return { ok: false, reason: "pending", callback };
      if (callback.state === "revoked") return { ok: false, reason: "revoked", callback };
      if (callback.state === "expired") return { ok: false, reason: "expired", callback };
      if (callback.state === "used") return { ok: false, reason: "replay", callback };

      if (callback.state === "claimed") {
        if (callback.submissionKey && this.hasTurnRequest(callback.submissionKey)) {
          this.finishChoiceClaim(callback, callback.submissionKey, now);
          return { ok: false, reason: "replay", callback: { ...callback, state: "used" } };
        }
        if ((callback.claimedAt ?? now) + CHOICE_CLAIM_LEASE_MS > now) {
          return { ok: false, reason: "pending", callback };
        }
        this.db.prepare(`
          UPDATE telegram_choice_callbacks
          SET state = 'active', submission_key = NULL, claimed_at = NULL
          WHERE token = ? AND state = 'claimed'
        `).run(token);
      }

      const sibling = this.getClaimedOrUsedChoiceSibling(callback);
      if (sibling?.state === "used") {
        return { ok: false, reason: "revoked", callback };
      }
      if (sibling?.state === "claimed") {
        if (sibling.submissionKey && this.hasTurnRequest(sibling.submissionKey)) {
          this.finishChoiceClaim(sibling, sibling.submissionKey, now);
          return { ok: false, reason: "revoked", callback };
        }
        if ((sibling.claimedAt ?? now) + CHOICE_CLAIM_LEASE_MS > now) {
          return { ok: false, reason: "pending", callback: sibling };
        }
        this.db.prepare(`
          UPDATE telegram_choice_callbacks
          SET state = 'active', submission_key = NULL, claimed_at = NULL
          WHERE token = ? AND state = 'claimed'
        `).run(sibling.token);
      }

      const result = this.db.prepare(`
        UPDATE telegram_choice_callbacks
        SET state = 'claimed', submission_key = ?, claimed_at = ?
        WHERE token = ? AND state = 'active'
      `).run(submissionKey, now, token);
      if (result.changes !== 1) return { ok: false, reason: "replay", callback };
      return {
        ok: true,
        callback: { ...callback, state: "claimed", submissionKey, claimedAt: now },
      };
    });
    return withSqliteWriteRetry(() => claim());
  }

  completeChoiceCallback(token: string, submissionKey: string, now = Date.now()): boolean {
    return withSqliteWriteRetry(() => this.db.transaction(() => {
      const callback = this.getChoiceCallback(token);
      if (!callback || callback.state !== "claimed" || callback.submissionKey !== submissionKey) {
        return false;
      }
      return this.finishChoiceClaim(callback, submissionKey, now);
    })());
  }

  releaseChoiceCallback(token: string, submissionKey: string): boolean {
    return withSqliteWriteRetry(() => this.db.transaction(() => {
      const callback = this.getChoiceCallback(token);
      if (!callback || callback.state !== "claimed" || callback.submissionKey !== submissionKey) {
        return false;
      }
      if (this.hasTurnRequest(submissionKey)) {
        this.finishChoiceClaim(callback, submissionKey, Date.now());
        return false;
      }
      return this.db.prepare(`
        UPDATE telegram_choice_callbacks
        SET state = 'active', submission_key = NULL, claimed_at = NULL
        WHERE token = ? AND state = 'claimed' AND submission_key = ?
      `).run(token, submissionKey).changes === 1;
    })());
  }

  markRichTurnDelivered(botKey: string, contextKey: string, turnId: string): void {
    withSqliteWriteRetry(() => this.db.prepare(`
      INSERT OR REPLACE INTO telegram_rich_turns (
        bot_key, context_key, turn_id, delivered_at
      ) VALUES (?, ?, ?, ?)
    `).run(botKey, contextKey, turnId, Date.now()));
  }

  hasDeliveredRichTurn(botKey: string, contextKey: string, turnId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM telegram_rich_turns
      WHERE bot_key = ? AND context_key = ? AND turn_id = ?
    `).get(botKey, contextKey, turnId));
  }

  private migrate(): void {
    this.db.exec(`
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
      CREATE TABLE IF NOT EXISTS telegram_choice_callbacks (
        token TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        bot_key TEXT NOT NULL,
        context_key TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        topic_id INTEGER,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        option_key TEXT NOT NULL,
        option_label TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        message_id INTEGER,
        submission_key TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS telegram_choice_callbacks_request
        ON telegram_choice_callbacks(request_id);
      CREATE TABLE IF NOT EXISTS telegram_rich_turns (
        bot_key TEXT NOT NULL,
        context_key TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY (bot_key, context_key, turn_id)
      );
    `);
    this.ensureColumn("telegram_choice_callbacks", "submission_key", "TEXT");
    this.ensureColumn("telegram_choice_callbacks", "claimed_at", "INTEGER");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      try {
        withSqliteWriteRetry(() => this.db.exec(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        ));
      } catch (error) {
        const refreshed = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!refreshed.some((entry) => entry.name === column)) throw error;
      }
    }
  }

  private hasTurnRequest(submissionKey: string): boolean {
    const table = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_requests'
    `).get();
    if (!table) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM turn_requests WHERE request_key = ?
    `).get(submissionKey));
  }

  private finishChoiceClaim(
    callback: ChoiceCallbackRecord,
    submissionKey: string,
    now: number,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE telegram_choice_callbacks
      SET state = 'used', used_at = ?
      WHERE token = ? AND state = 'claimed' AND submission_key = ?
    `).run(now, callback.token, submissionKey);
    if (result.changes !== 1) return false;
    this.db.prepare(`
      UPDATE telegram_choice_callbacks SET state = 'revoked'
      WHERE request_id = ? AND bot_key = ? AND context_key = ?
        AND thread_id = ? AND turn_id = ? AND token != ?
        AND state IN ('pending', 'active', 'claimed')
    `).run(
      callback.requestId,
      callback.botKey,
      callback.contextKey,
      callback.threadId,
      callback.turnId,
      callback.token,
    );
    return true;
  }

  private getClaimedOrUsedChoiceSibling(
    callback: ChoiceCallbackRecord,
  ): ChoiceCallbackRecord | undefined {
    const row = this.db.prepare(`
      SELECT token, request_id, bot_key, context_key, user_id, chat_id, topic_id,
             thread_id, turn_id, prompt, option_key, option_label, expires_at,
             state, message_id, submission_key, claimed_at
      FROM telegram_choice_callbacks
      WHERE request_id = ? AND bot_key = ? AND context_key = ?
        AND thread_id = ? AND turn_id = ? AND token != ?
        AND state IN ('claimed', 'used')
      LIMIT 1
    `).get(
      callback.requestId,
      callback.botKey,
      callback.contextKey,
      callback.threadId,
      callback.turnId,
      callback.token,
    ) as ChoiceCallbackRow | undefined;
    return row ? mapChoiceCallback(row) : undefined;
  }
}

export function withSqliteWriteRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isRetryableSqliteWrite(error) || attempt >= SQLITE_WRITE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      Atomics.wait(SQLITE_RETRY_BUFFER, 0, 0, SQLITE_WRITE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isRetryableSqliteWrite(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

type DeliveryRow = {
  delivery_id: string;
  bot_key: string;
  context_key: string;
  chat_id: string;
  topic_id: number | null;
  thread_id: string | null;
  turn_id: string | null;
  payload_json: string;
  state: TextDelivery["state"];
  attempts: number;
  last_error: string | null;
};

type PartRow = {
  part_index: number;
  text: string;
  fallback_text: string;
  parse_mode: string | null;
  state: DeliveryPart["state"];
  telegram_message_id: number | null;
  attempts: number;
  last_error: string | null;
};

type ChoiceCallbackRow = {
  token: string;
  request_id: string;
  bot_key: string;
  context_key: string;
  user_id: number;
  chat_id: number;
  topic_id: number | null;
  thread_id: string;
  turn_id: string;
  prompt: string;
  option_key: string;
  option_label: string;
  expires_at: number;
  state: ChoiceCallbackRecord["state"];
  message_id: number | null;
  submission_key: string | null;
  claimed_at: number | null;
};

function parsePayload(value: string): { historyItemId?: string; anchorMessageId?: number } {
  try {
    return JSON.parse(value) as { historyItemId?: string; anchorMessageId?: number };
  } catch {
    return {};
  }
}

function parseChatId(value: string): number | string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function mapChoiceCallback(row: ChoiceCallbackRow): ChoiceCallbackRecord {
  return {
    token: row.token,
    requestId: row.request_id,
    botKey: row.bot_key,
    contextKey: row.context_key,
    userId: row.user_id,
    chatId: row.chat_id,
    ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
    threadId: row.thread_id,
    turnId: row.turn_id,
    prompt: row.prompt,
    optionKey: row.option_key,
    optionLabel: row.option_label,
    expiresAt: row.expires_at,
    state: row.state,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    ...(row.submission_key === null ? {} : { submissionKey: row.submission_key }),
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
  };
}

function choiceGroupKey(callback: ChoiceCallbackInput): string {
  return [
    callback.requestId,
    callback.botKey,
    callback.contextKey,
    callback.threadId,
    callback.turnId,
  ].join("\u001f");
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function sameTextDelivery(existing: TextDelivery, input: TextDeliveryInput): boolean {
  return existing.botKey === input.botKey &&
    existing.contextKey === input.contextKey &&
    String(existing.chatId) === String(input.chatId) &&
    existing.topicId === input.topicId &&
    existing.threadId === input.threadId &&
    existing.turnId === input.turnId &&
    existing.historyItemId === input.historyItemId &&
    existing.anchorMessageId === input.anchorMessageId &&
    JSON.stringify(existing.chunks) === JSON.stringify(input.chunks);
}
