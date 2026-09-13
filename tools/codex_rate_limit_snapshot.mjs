#!/usr/bin/env node

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import {
  UsageMonitorError,
  accountFingerprint,
  readCodexAuth,
  writeArchiveAtomic,
} from "./codex_daily_workspace_usage.mjs";

const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  ".telecodex/analytics/codex-rate-limit-history.json",
);
const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const DEFAULT_RETENTION_DAYS = 180;
const RPC_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 4_096;

function helpText() {
  return `Usage: node tools/codex_rate_limit_snapshot.mjs [options]

Reads the current Codex quota percentage from the local Codex app-server
interface and atomically appends a timestamped snapshot.

Options:
  --output PATH          history path (default: ${DEFAULT_OUTPUT})
  --auth-file PATH       Codex auth.json path (default: ${DEFAULT_AUTH_FILE})
  --codex-bin PATH       Codex executable (default: $CODEX_BIN or codex)
  --retention-days N     history retention in days (default: ${DEFAULT_RETENTION_DAYS})
  --json                 print the normalized snapshot as JSON
  --no-write             read and print without updating history
  -h, --help             show this help
`;
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new UsageMonitorError(`${option} requires a value`);
  }
  return value;
}

export function parseRateLimitArgs(args) {
  const options = {
    output: DEFAULT_OUTPUT,
    authFile: DEFAULT_AUTH_FILE,
    codexBin: process.env.CODEX_BIN || "codex",
    retentionDays: DEFAULT_RETENTION_DAYS,
    json: false,
    write: true,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--output":
        options.output = path.resolve(takeValue(args, index, arg));
        index += 1;
        break;
      case "--auth-file":
        options.authFile = path.resolve(takeValue(args, index, arg));
        index += 1;
        break;
      case "--codex-bin":
        options.codexBin = takeValue(args, index, arg);
        index += 1;
        break;
      case "--retention-days":
        options.retentionDays = Number(takeValue(args, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-write":
        options.write = false;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new UsageMonitorError(`unknown option: ${arg}`);
    }
  }

  if (
    !Number.isInteger(options.retentionDays) ||
    options.retentionDays < 1 ||
    options.retentionDays > 3650
  ) {
    throw new UsageMonitorError(
      "--retention-days must be an integer from 1 to 3650",
    );
  }
  return options;
}

function windowError(context, detail) {
  return new UsageMonitorError(`${context}${detail}`);
}

export function normalizeRateLimitWindow(window, context) {
  if (window == null) return null;
  if (typeof window !== "object" || Array.isArray(window)) {
    throw windowError(context, " must be an object or null");
  }
  if (
    !Number.isInteger(window.usedPercent) ||
    window.usedPercent < 0 ||
    window.usedPercent > 100
  ) {
    throw windowError(context, ".usedPercent must be an integer from 0 to 100");
  }
  for (const key of ["windowDurationMins", "resetsAt"]) {
    if (
      window[key] != null &&
      (!Number.isInteger(window[key]) || window[key] < 0)
    ) {
      throw windowError(
        context,
        `.${key} must be a non-negative integer or null`,
      );
    }
  }
  return { ...window };
}

export function normalizeRateLimitSnapshot(snapshot, context) {
  if (
    snapshot == null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new UsageMonitorError(`${context} must be an object`);
  }
  return {
    ...snapshot,
    primary: normalizeRateLimitWindow(snapshot.primary, `${context}.primary`),
    secondary: normalizeRateLimitWindow(
      snapshot.secondary,
      `${context}.secondary`,
    ),
  };
}

export function normalizeRateLimitResponse(result) {
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    throw new UsageMonitorError(
      "account/rateLimits/read result must be an object",
    );
  }
  const rateLimits = normalizeRateLimitSnapshot(
    result.rateLimits,
    "rateLimits",
  );
  let rateLimitsByLimitId = result.rateLimitsByLimitId;
  if (rateLimitsByLimitId == null) {
    rateLimitsByLimitId = { [rateLimits.limitId ?? "default"]: rateLimits };
  }
  if (
    typeof rateLimitsByLimitId !== "object" ||
    Array.isArray(rateLimitsByLimitId)
  ) {
    throw new UsageMonitorError(
      "rateLimitsByLimitId must be an object or null",
    );
  }
  const normalizedById = Object.fromEntries(
    Object.entries(rateLimitsByLimitId).map(([limitId, snapshot]) => [
      limitId,
      normalizeRateLimitSnapshot(snapshot, `rateLimitsByLimitId.${limitId}`),
    ]),
  );
  return {
    ...result,
    rateLimits,
    rateLimitsByLimitId: normalizedById,
  };
}

function rpcErrorMessage(error) {
  if (error == null || typeof error !== "object")
    return "unknown app-server error";
  return typeof error.message === "string"
    ? error.message.slice(0, 500)
    : JSON.stringify(error);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null)
        child.kill("SIGTERM");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function readRateLimitsViaAppServer({
  codexBin,
  timeoutMs = RPC_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  const child = spawnImpl(codexBin, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });

  const rejectPending = (error) => {
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(error);
    }
    pending.clear();
  };

  child.stderr.on("data", (chunk) => {
    if (stderr.length < STDERR_LIMIT)
      stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
  });
  child.once("error", (error) => {
    rejectPending(
      new UsageMonitorError(`cannot start Codex app-server: ${error.message}`, {
        cause: error,
      }),
    );
  });
  child.once("exit", (code, signal) => {
    if (pending.size === 0) return;
    const detail = stderr.trim();
    rejectPending(
      new UsageMonitorError(
        `Codex app-server exited before replying (code=${String(code)} signal=${String(signal)})${
          detail === "" ? "" : `: ${detail}`
        }`,
      ),
    );
  });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.id == null) return;
    const pendingRequest = pending.get(String(message.id));
    if (pendingRequest == null) return;
    pending.delete(String(message.id));
    clearTimeout(pendingRequest.timer);
    if (message.error != null) {
      pendingRequest.reject(
        new UsageMonitorError(
          `Codex app-server RPC failed: ${rpcErrorMessage(message.error)}`,
        ),
      );
    } else {
      pendingRequest.resolve(message.result);
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(
          new UsageMonitorError(`Codex app-server RPC timed out: ${method}`),
        );
      }, timeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (error == null) return;
          const pendingRequest = pending.get(String(id));
          if (pendingRequest == null) return;
          pending.delete(String(id));
          clearTimeout(pendingRequest.timer);
          reject(
            new UsageMonitorError(
              `cannot write Codex app-server RPC: ${error.message}`,
              {
                cause: error,
              },
            ),
          );
        },
      );
    });

  try {
    await request("initialize", {
      clientInfo: { name: "codex-usage-monitor", version: "1" },
      capabilities: null,
    });
    const result = await request("account/rateLimits/read", null);
    return normalizeRateLimitResponse(result);
  } finally {
    lines.close();
    rejectPending(new UsageMonitorError("Codex app-server connection closed"));
    await stopChild(child);
  }
}

export async function readRateLimitHistory(output) {
  try {
    const history = JSON.parse(await fsp.readFile(output, "utf8"));
    if (history?.schema_version !== 1 || !Array.isArray(history.snapshots)) {
      throw new UsageMonitorError(
        `unsupported rate-limit history schema: ${output}`,
      );
    }
    return history;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof UsageMonitorError) throw error;
    throw new UsageMonitorError(`cannot read rate-limit history: ${output}`, {
      cause: error,
    });
  }
}

export function mergeRateLimitHistory({
  previous,
  rateLimits,
  sampledAt,
  workspaceFingerprint,
  retentionDays,
}) {
  if (
    previous?.workspace_fingerprint != null &&
    previous.workspace_fingerprint !== workspaceFingerprint
  ) {
    throw new UsageMonitorError(
      "the rate-limit history belongs to a different ChatGPT account; choose another --output path",
    );
  }
  const cutoff = new Date(sampledAt).getTime() - retentionDays * 86_400_000;
  const snapshots = [
    ...(previous?.snapshots ?? []),
    { sampled_at: sampledAt, ...rateLimits },
  ]
    .filter((snapshot) => new Date(snapshot.sampled_at).getTime() >= cutoff)
    .sort((left, right) => left.sampled_at.localeCompare(right.sampled_at));
  return {
    schema_version: 1,
    workspace_fingerprint: workspaceFingerprint,
    retention_days: retentionDays,
    updated_at: sampledAt,
    snapshots,
  };
}

function formatReset(epochSeconds) {
  return epochSeconds == null
    ? "unknown"
    : new Date(epochSeconds * 1000).toISOString();
}

export function renderRateLimitSnapshot(rateLimits, sampledAt) {
  const limits = Object.entries(rateLimits.rateLimitsByLimitId);
  const parts = limits.map(([key, snapshot]) => {
    const primary = snapshot.primary;
    const secondary = snapshot.secondary;
    const primaryText =
      primary == null
        ? "primary=unavailable"
        : `primary=${primary.usedPercent}%/${String(primary.windowDurationMins ?? "?")}m reset=${formatReset(primary.resetsAt)}`;
    const secondaryText =
      secondary == null
        ? ""
        : ` secondary=${secondary.usedPercent}%/${String(secondary.windowDurationMins ?? "?")}m reset=${formatReset(secondary.resetsAt)}`;
    return `${key}: ${primaryText}${secondaryText}`;
  });
  return [`sampled_at=${sampledAt}`, ...parts].join("\n");
}

export async function main(args = process.argv.slice(2)) {
  const options = parseRateLimitArgs(args);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const sampledAt = new Date().toISOString();
  const auth = await readCodexAuth(options.authFile);
  const rateLimits = await readRateLimitsViaAppServer({
    codexBin: options.codexBin,
  });
  if (options.write) {
    const previous = await readRateLimitHistory(options.output);
    const history = mergeRateLimitHistory({
      previous,
      rateLimits,
      sampledAt,
      workspaceFingerprint: accountFingerprint(auth.accountId),
      retentionDays: options.retentionDays,
    });
    await writeArchiveAtomic(options.output, history);
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ sampled_at: sampledAt, ...rateLimits }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${renderRateLimitSnapshot(rateLimits, sampledAt)}\n`);
    if (options.write) process.stdout.write(`History: ${options.output}\n`);
  }
}

const invokedPath =
  process.argv[1] == null
    ? null
    : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codex-rate-limit-snapshot: ${message}\n`);
    process.exitCode = 1;
  });
}
