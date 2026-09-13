import { describe, expect, it } from "vitest";

import { TurnMessageLedger } from "../src/turn-message-ledger.js";

describe("TurnMessageLedger", () => {
  it("deduplicates and returns user and bot messages for rolled-back turns", () => {
    const ledger = new TurnMessageLedger();
    ledger.record("123", "turn-1", 123, "user", 10, 1_000);
    ledger.record("123", "turn-1", 123, "bot", 20, 1_000);
    ledger.record("123", "turn-1", 123, "bot", 20, 1_000);
    ledger.record("123", "turn-2", 123, "user", 11, 2_000);

    expect(ledger.markRolledBack("123", ["turn-1"], 3_000)).toEqual([
      { chatId: 123, messageId: 10 },
      { chatId: 123, messageId: 20 },
    ]);
    expect(ledger.markRolledBack("123", ["turn-2"], 3_000)).toEqual([
      { chatId: 123, messageId: 11 },
    ]);
  });

  it("tombstones rolled-back turns so late response messages are deleted immediately", () => {
    const ledger = new TurnMessageLedger();
    ledger.markRolledBack("123", ["turn-1"], 1_000);

    expect(ledger.record("123", "turn-1", 123, "bot", 30, 2_000)).toBe(true);
    expect(ledger.record("123", "turn-2", 123, "bot", 31, 2_000)).toBe(false);
  });

  it("evicts old turns without changing rollback semantics", () => {
    const ledger = new TurnMessageLedger({ ttlMs: 100, maxTurnsPerContext: 2 });
    ledger.record("123", "turn-1", 123, "user", 1, 1_000);
    ledger.record("123", "turn-2", 123, "user", 2, 1_010);
    ledger.record("123", "turn-3", 123, "user", 3, 1_020);

    expect(ledger.markRolledBack("123", ["turn-1", "turn-2", "turn-3"], 1_030)).toEqual([
      { chatId: 123, messageId: 2 },
      { chatId: 123, messageId: 3 },
    ]);
    expect(ledger.markRolledBack("123", ["missing"], 1_200)).toEqual([]);
  });
});
