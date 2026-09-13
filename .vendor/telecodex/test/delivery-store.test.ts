import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TelegramDeliveryStore, withSqliteWriteRetry } from "../src/delivery-store.js";
import { deliverStoredText } from "../src/bot.js";
import { CoreStateStore } from "../src/state-store.js";
import type { Bot, Context } from "grammy";

describe("TelegramDeliveryStore", () => {
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-delivery-"));
    dbPath = path.join(directory, "state.sqlite");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("resumes a partially delivered multi-chunk response after reopen", () => {
    const store = new TelegramDeliveryStore(dbPath);
    store.stageText({
      deliveryId: "delivery-1",
      botKey: "main",
      contextKey: "-100:7",
      chatId: -100,
      topicId: 7,
      threadId: "thread-1",
      turnId: "turn-1",
      historyItemId: "item-1",
      anchorMessageId: 50,
      chunks: [
        { text: "one", fallbackText: "one", parseMode: "HTML" },
        { text: "two", fallbackText: "two" },
      ],
    });
    store.markPartDelivered("delivery-1", 0, 50);
    store.close();

    const reopened = new TelegramDeliveryStore(dbPath);
    const [delivery] = reopened.listPending("main");
    expect(delivery).toMatchObject({
      deliveryId: "delivery-1",
      contextKey: "-100:7",
      topicId: 7,
      historyItemId: "item-1",
      anchorMessageId: 50,
    });
    expect(reopened.listParts("delivery-1")).toEqual([
      expect.objectContaining({ partIndex: 0, state: "delivered", telegramMessageId: 50 }),
      expect.objectContaining({ partIndex: 1, state: "pending", text: "two" }),
    ]);
    reopened.close();
  });

  it("stages the same delivery idempotently", () => {
    const store = new TelegramDeliveryStore(dbPath);
    const input = {
      deliveryId: "delivery-1",
      botKey: "main",
      contextKey: "123",
      chatId: 123,
      chunks: [{ text: "hello", fallbackText: "hello" }],
    };
    store.stageText(input);
    store.stageText(input);
    expect(store.listParts("delivery-1")).toHaveLength(1);
    store.markDelivered("delivery-1");
    expect(store.listPending("main")).toEqual([]);
    store.close();
  });

  it("rejects reuse of a delivery id with different immutable content", () => {
    const store = new TelegramDeliveryStore(dbPath);
    store.stageText({
      deliveryId: "delivery-1",
      botKey: "main",
      contextKey: "123",
      chatId: 123,
      chunks: [{ text: "first", fallbackText: "first" }],
    });

    expect(() => store.stageText({
      deliveryId: "delivery-1",
      botKey: "main",
      contextKey: "123",
      chatId: 123,
      chunks: [{ text: "different", fallbackText: "different" }],
    })).toThrow("reused with a different immutable payload");
    store.close();
  });

  it("continues from the first undelivered chunk instead of resending completed chunks", async () => {
    const store = new TelegramDeliveryStore(dbPath);
    const delivery = store.stageText({
      deliveryId: "delivery-recovery",
      botKey: "main",
      contextKey: "123",
      chatId: 123,
      anchorMessageId: 50,
      chunks: [
        { text: "one", fallbackText: "one" },
        { text: "two", fallbackText: "two" },
      ],
    });
    store.markPartDelivered(delivery.deliveryId, 0, 50);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 51 });
    const editMessageText = vi.fn();
    const bot = { api: { sendMessage, editMessageText } } as unknown as Bot<Context>;

    await deliverStoredText(bot, store, delivery);

    expect(editMessageText).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(123, "two", expect.any(Object));
    expect(store.listPending("main")).toEqual([]);
    store.close();
  });

  it("retries transient SQLite writer contention", () => {
    const operation = vi.fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      })
      .mockImplementationOnce(() => "written");

    expect(withSqliteWriteRetry(operation)).toBe("written");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-contention SQLite errors", () => {
    const error = Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" });
    const operation = vi.fn(() => { throw error; });

    expect(() => withSqliteWriteRetry(operation)).toThrow(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("activates choices only after delivery and completes exactly once across reopen", () => {
    const store = new TelegramDeliveryStore(dbPath);
    const expiresAt = Date.now() + 60_000;
    const tokens = ["a".repeat(32), "b".repeat(32)];
    store.stageChoiceCallbacks([
      choice(tokens[0], "yes", "Yes", expiresAt),
      choice(tokens[1], "no", "No", expiresAt),
    ]);
    expect(store.claimChoiceCallback(tokens[0], target(), "submission-1")).toMatchObject({
      ok: false,
      reason: "pending",
    });
    store.activateChoiceCallbacks(tokens, 77);
    store.close();

    const reopened = new TelegramDeliveryStore(dbPath);
    expect(reopened.claimChoiceCallback(tokens[0], target(), "submission-1")).toMatchObject({
      ok: true,
      callback: { optionKey: "yes", state: "claimed", messageId: 77 },
    });
    expect(reopened.completeChoiceCallback(tokens[0], "submission-1")).toBe(true);
    expect(reopened.claimChoiceCallback(tokens[0], target(), "submission-1")).toMatchObject({
      ok: false,
      reason: "replay",
    });
    expect(reopened.claimChoiceCallback(tokens[1], target(), "submission-1")).toMatchObject({
      ok: false,
      reason: "revoked",
    });
    reopened.close();
  });

  it("keeps a choice active after a mismatched user and expires it at the deadline", () => {
    const store = new TelegramDeliveryStore(dbPath);
    const expiresAt = Date.now() + 1_000;
    store.stageChoiceCallbacks([
      choice("c".repeat(32), "left", "Left", expiresAt),
      choice("d".repeat(32), "right", "Right", expiresAt),
    ]);
    const tokens = ["c".repeat(32), "d".repeat(32)];
    store.activateChoiceCallbacks(tokens, 88);

    expect(store.claimChoiceCallback(tokens[0], { ...target(), userId: 999 }, "submission-2")).toMatchObject({
      ok: false,
      reason: "user_mismatch",
      callback: { state: "active" },
    });
    expect(store.claimChoiceCallback(tokens[0], {
      ...target(),
      threadId: "thread-new",
    }, "submission-2")).toMatchObject({
      ok: false,
      reason: "thread_mismatch",
      callback: { state: "active" },
    });
    expect(store.claimChoiceCallback(tokens[0], target(), "submission-2", expiresAt)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    store.close();
  });

  it("releases an unaccepted claim but commits one already journaled by Core", () => {
    const core = new CoreStateStore(dbPath);
    const store = new TelegramDeliveryStore(dbPath);
    const expiresAt = Date.now() + 60_000;
    const tokens = ["e".repeat(32), "f".repeat(32)];
    store.stageChoiceCallbacks([
      choice(tokens[0], "left", "Left", expiresAt),
      choice(tokens[1], "right", "Right", expiresAt),
    ]);
    store.activateChoiceCallbacks(tokens, 99);

    expect(store.claimChoiceCallback(tokens[0], target(), "submission-retry")).toMatchObject({ ok: true });
    expect(store.releaseChoiceCallback(tokens[0], "submission-retry")).toBe(true);
    expect(store.getChoiceCallback(tokens[0])).toMatchObject({ state: "active" });

    expect(store.claimChoiceCallback(tokens[0], target(), "submission-durable")).toMatchObject({ ok: true });
    core.beginTurnRequest("submission-durable", "main", "main\u001f123:7", "thread-1");
    expect(store.releaseChoiceCallback(tokens[0], "submission-durable")).toBe(false);
    expect(store.getChoiceCallback(tokens[0])).toMatchObject({ state: "used" });
    expect(store.getChoiceCallback(tokens[1])).toMatchObject({ state: "revoked" });
    store.close();
    core.close();
  });

  it("allows only one in-flight selection in an exact choice group", () => {
    const store = new TelegramDeliveryStore(dbPath);
    const expiresAt = Date.now() + 60_000;
    const tokens = ["7".repeat(32), "8".repeat(32)];
    store.stageChoiceCallbacks([
      choice(tokens[0], "left", "Left", expiresAt),
      choice(tokens[1], "right", "Right", expiresAt),
    ]);
    store.activateChoiceCallbacks(tokens, 101);

    expect(store.claimChoiceCallback(tokens[0], target(), "submission-left")).toMatchObject({
      ok: true,
    });
    expect(store.claimChoiceCallback(tokens[1], target(), "submission-right")).toMatchObject({
      ok: false,
      reason: "pending",
      callback: { optionKey: "left", state: "claimed" },
    });
    expect(store.completeChoiceCallback(tokens[0], "submission-left")).toBe(true);
    expect(store.getChoiceCallback(tokens[1])).toMatchObject({ state: "revoked" });
    store.close();
  });

  it("scopes activation and revocation to exact callback tokens", () => {
    const store = new TelegramDeliveryStore(dbPath);
    const expiresAt = Date.now() + 60_000;
    const first = ["1".repeat(32), "2".repeat(32)];
    const second = ["3".repeat(32), "4".repeat(32)];
    store.stageChoiceCallbacks(first.map((token, index) => choice(
      token,
      `first-${index}`,
      `First ${index}`,
      expiresAt,
    )));
    store.stageChoiceCallbacks(second.map((token, index) => choice(
      token,
      `second-${index}`,
      `Second ${index}`,
      expiresAt,
      { contextKey: "456:7", chatId: 456 },
    )));

    store.activateChoiceCallbacks(first, 100);
    store.revokeChoiceCallbacks(first);
    expect(store.getChoiceCallback(first[0])).toMatchObject({ state: "revoked" });
    expect(store.getChoiceCallback(second[0])).toMatchObject({ state: "pending" });
    store.close();
  });

  it("revokes callbacks left pending by a worker restart", () => {
    const store = new TelegramDeliveryStore(dbPath);
    const expiresAt = Date.now() + 60_000;
    const tokens = ["5".repeat(32), "6".repeat(32)];
    store.stageChoiceCallbacks([
      choice(tokens[0], "yes", "Yes", expiresAt),
      choice(tokens[1], "no", "No", expiresAt),
    ]);
    expect(store.revokeDanglingPendingChoices("main")).toBe(2);
    expect(store.getChoiceCallback(tokens[0])).toMatchObject({ state: "revoked" });
    store.close();
  });

  it("persists visible rich-turn completion for final replay suppression", () => {
    const store = new TelegramDeliveryStore(dbPath);
    store.markRichTurnDelivered("main", "123", "turn-rich");
    store.close();

    const reopened = new TelegramDeliveryStore(dbPath);
    expect(reopened.hasDeliveredRichTurn("main", "123", "turn-rich")).toBe(true);
    expect(reopened.hasDeliveredRichTurn("main", "123", "turn-other")).toBe(false);
    reopened.close();
  });
});

function choice(
  token: string,
  optionKey: string,
  optionLabel: string,
  expiresAt: number,
  overrides: Partial<ReturnType<typeof baseChoice>> = {},
) {
  return { ...baseChoice(), token, optionKey, optionLabel, expiresAt, ...overrides };
}

function baseChoice() {
  return {
    requestId: "call-1:0",
    botKey: "main",
    contextKey: "123:7",
    userId: 123,
    chatId: 123,
    topicId: 7,
    threadId: "thread-1",
    turnId: "turn-1",
    prompt: "Pick",
    optionKey: "yes",
    optionLabel: "Yes",
    expiresAt: Date.now() + 60_000,
  };
}

function target() {
  return { botKey: "main", userId: 123, chatId: 123, topicId: 7, threadId: "thread-1" };
}
