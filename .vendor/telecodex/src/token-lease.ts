import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export class TelegramTokenLease {
  private released = false;

  private constructor(readonly leasePath: string) {}

  static acquire(runDir: string, botKey: string, token: string): TelegramTokenLease {
    const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 20);
    const directory = path.join(runDir, "token-leases");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const leasePath = path.join(directory, `${fingerprint}.json`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(leasePath, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ botKey, pid: process.pid, startedAt: Date.now() }));
        closeSync(fd);
        return new TelegramTokenLease(leasePath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const owner = readOwner(leasePath);
        if (owner?.pid && isProcessAlive(owner.pid)) {
          throw new Error(
            `Telegram token is already owned by worker ${owner.botKey ?? "unknown"} (pid ${owner.pid})`,
          );
        }
        try { unlinkSync(leasePath); } catch { /* retry reports a live race */ }
      }
    }
    throw new Error("Could not acquire Telegram token polling lease");
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try { unlinkSync(this.leasePath); } catch { /* stale leases are reclaimed on startup */ }
  }
}

function readOwner(leasePath: string): { botKey?: string; pid?: number } | undefined {
  try {
    return JSON.parse(readFileSync(leasePath, "utf8")) as { botKey?: string; pid?: number };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
