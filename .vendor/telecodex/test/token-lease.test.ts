import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TelegramTokenLease } from "../src/token-lease.js";

describe("TelegramTokenLease", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "telecodex-token-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("rejects a second live owner for the same token", () => {
    const first = TelegramTokenLease.acquire(directory, "main", "same-token");
    expect(() => TelegramTokenLease.acquire(directory, "work", "same-token"))
      .toThrow("already owned by worker main");
    first.release();
    const second = TelegramTokenLease.acquire(directory, "work", "same-token");
    second.release();
  });

  it("reclaims a stale process lease", () => {
    const fingerprint = createHash("sha256").update("stale-token").digest("hex").slice(0, 20);
    const leaseDir = path.join(directory, "token-leases");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(path.join(leaseDir, `${fingerprint}.json`), JSON.stringify({ botKey: "old", pid: 99999999 }));
    const lease = TelegramTokenLease.acquire(directory, "main", "stale-token");
    lease.release();
  });
});
