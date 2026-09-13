#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT =
  "https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts";
const DEFAULT_DAYS = 7;
const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  ".telecodex/analytics/codex-daily-workspace-usage.json",
);
const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const COUNTER_KEYS = [
  "users",
  "threads",
  "turns",
  "credits",
  "uncached_text_input_tokens",
  "cached_text_input_tokens",
  "text_output_tokens",
  "text_total_tokens",
];
const TOKEN_COUNTER_KEYS = [
  "uncached_text_input_tokens",
  "cached_text_input_tokens",
  "text_output_tokens",
  "text_total_tokens",
];

export class UsageMonitorError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message, cause == null ? undefined : { cause });
    this.name = "UsageMonitorError";
    this.status = status;
  }
}

function helpText() {
  return `Usage: node tools/codex_daily_workspace_usage.mjs [options]

Fetches Codex Analytics daily workspace usage with the local Codex ChatGPT login.
The default run refreshes the last 7 UTC dates, including today, and merges them
by date into .telecodex/analytics/codex-daily-workspace-usage.json.

Options:
  --days N             trailing UTC dates to refresh, including today (default: 7)
  --date YYYY-MM-DD    fetch one UTC date
  --start YYYY-MM-DD   first UTC date in an explicit inclusive range
  --end YYYY-MM-DD     last UTC date in an explicit inclusive range
  --output PATH        archive path (default: ${DEFAULT_OUTPUT})
  --auth-file PATH     Codex auth.json path (default: ${DEFAULT_AUTH_FILE})
  --endpoint URL       override the endpoint (primarily for testing)
  --json               print the fetched normalized payload as JSON
  --no-write           fetch and print without updating the archive
  --no-auth-refresh    do not ask the local Codex CLI to refresh after HTTP 401
  -h, --help           show this help

The upstream end_date is exclusive. This CLI keeps --date/--start/--end
inclusive and converts the boundary before making the request.
`;
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new UsageMonitorError(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(args) {
  const options = {
    days: DEFAULT_DAYS,
    date: null,
    start: null,
    end: null,
    output: DEFAULT_OUTPUT,
    authFile: DEFAULT_AUTH_FILE,
    endpoint: DEFAULT_ENDPOINT,
    json: false,
    write: true,
    refreshAuth: true,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--days": {
        const value = takeValue(args, index, arg);
        options.days = Number(value);
        index += 1;
        break;
      }
      case "--date":
        options.date = takeValue(args, index, arg);
        index += 1;
        break;
      case "--start":
        options.start = takeValue(args, index, arg);
        index += 1;
        break;
      case "--end":
        options.end = takeValue(args, index, arg);
        index += 1;
        break;
      case "--output":
        options.output = path.resolve(takeValue(args, index, arg));
        index += 1;
        break;
      case "--auth-file":
        options.authFile = path.resolve(takeValue(args, index, arg));
        index += 1;
        break;
      case "--endpoint":
        options.endpoint = takeValue(args, index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-write":
        options.write = false;
        break;
      case "--no-auth-refresh":
        options.refreshAuth = false;
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
    !Number.isInteger(options.days) ||
    options.days < 1 ||
    options.days > 31
  ) {
    throw new UsageMonitorError("--days must be an integer from 1 to 31");
  }
  if (options.date != null && (options.start != null || options.end != null)) {
    throw new UsageMonitorError(
      "--date cannot be combined with --start or --end",
    );
  }
  if ((options.start == null) !== (options.end == null)) {
    throw new UsageMonitorError("--start and --end must be provided together");
  }
  for (const [label, value] of [
    ["--date", options.date],
    ["--start", options.start],
    ["--end", options.end],
  ]) {
    if (value != null) validateDate(value, label);
  }
  if (options.start != null && options.start > options.end) {
    throw new UsageMonitorError("--start must not be later than --end");
  }
  try {
    const endpoint = new URL(options.endpoint);
    if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch (error) {
    throw new UsageMonitorError("--endpoint must be an HTTP(S) URL", {
      cause: error,
    });
  }

  return options;
}

export function validateDate(value, label = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new UsageMonitorError(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new UsageMonitorError(`${label} is not a valid calendar date`);
  }
  return value;
}

export function addUtcDays(date, amount) {
  validateDate(date);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

export function calculateDateRange(options, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (options.date != null) {
    return {
      startDate: options.date,
      endDateExclusive: addUtcDays(options.date, 1),
      today,
    };
  }
  if (options.start != null) {
    return {
      startDate: options.start,
      endDateExclusive: addUtcDays(options.end, 1),
      today,
    };
  }
  return {
    startDate: addUtcDays(today, -(options.days - 1)),
    endDateExclusive: addUtcDays(today, 1),
    today,
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const pieces = token.split(".");
  if (pieces.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function readCodexAuth(authFile) {
  let stat;
  try {
    stat = await fsp.stat(authFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UsageMonitorError(`Codex auth file not found: ${authFile}`);
    }
    throw new UsageMonitorError(`cannot stat Codex auth file: ${authFile}`, {
      cause: error,
    });
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new UsageMonitorError(
      `refusing to read group/world-accessible Codex auth file: ${authFile}`,
    );
  }

  let document;
  try {
    document = JSON.parse(await fsp.readFile(authFile, "utf8"));
  } catch (error) {
    throw new UsageMonitorError(`cannot parse Codex auth file: ${authFile}`, {
      cause: error,
    });
  }

  const accessToken = document?.tokens?.access_token;
  const jwtPayload = decodeJwtPayload(
    document?.tokens?.id_token ?? accessToken,
  );
  const accountId =
    document?.tokens?.account_id ??
    jwtPayload?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
    null;
  if (document?.auth_mode !== "chatgpt") {
    throw new UsageMonitorError(
      "Codex must be logged in with ChatGPT for this endpoint",
    );
  }
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new UsageMonitorError(
      "Codex auth.json does not contain tokens.access_token",
    );
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new UsageMonitorError(
      "Codex auth.json does not contain a ChatGPT account id",
    );
  }
  return { accessToken, accountId };
}

function responseDetail(body) {
  if (body == null || typeof body !== "object") return null;
  const detail = body.detail ?? body.error?.message ?? body.message;
  return typeof detail === "string" ? detail.slice(0, 500) : null;
}

export function normalizeCounters(value, context) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageMonitorError(`${context} must be an object`);
  }
  const normalized = { ...value };
  for (const key of COUNTER_KEYS) {
    const counter = value[key];
    if (counter == null) {
      normalized[key] = null;
    } else if (
      typeof counter !== "number" ||
      !Number.isFinite(counter) ||
      counter < 0
    ) {
      throw new UsageMonitorError(
        `${context}.${key} must be a non-negative number or null`,
      );
    } else {
      normalized[key] = counter;
    }
  }
  return normalized;
}

export function normalizeUsageResponse(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new UsageMonitorError("usage response must be a JSON object");
  }
  if (body.group_by !== "day") {
    throw new UsageMonitorError(
      `unexpected group_by: ${JSON.stringify(body.group_by)}`,
    );
  }
  if (!Array.isArray(body.data)) {
    throw new UsageMonitorError("usage response data must be an array");
  }

  const seenDates = new Set();
  const data = body.data.map((entry, index) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new UsageMonitorError(`data[${index}] must be an object`);
    }
    validateDate(entry.date, `data[${index}].date`);
    if (seenDates.has(entry.date)) {
      throw new UsageMonitorError(`duplicate date in response: ${entry.date}`);
    }
    seenDates.add(entry.date);

    const clients = entry.clients ?? [];
    const models = entry.models ?? [];
    if (!Array.isArray(clients)) {
      throw new UsageMonitorError(`data[${index}].clients must be an array`);
    }
    if (!Array.isArray(models)) {
      throw new UsageMonitorError(`data[${index}].models must be an array`);
    }
    return {
      ...entry,
      totals: normalizeCounters(entry.totals, `data[${index}].totals`),
      clients: clients.map((client, clientIndex) => ({
        ...client,
        ...normalizeCounters(client, `data[${index}].clients[${clientIndex}]`),
      })),
      models: models.map((model, modelIndex) => ({
        ...model,
        ...normalizeCounters(model, `data[${index}].models[${modelIndex}]`),
      })),
    };
  });

  data.sort((left, right) => left.date.localeCompare(right.date));
  return { ...body, group_by: "day", data };
}

export function curlUsageRequest(
  url,
  { headers, timeoutMs = REQUEST_TIMEOUT_MS },
) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const headerInput = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      "--header",
      "@-",
      "--write-out",
      "\n%{http_code}",
      String(url),
    ],
    {
      encoding: "utf8",
      input: `${headerInput}\n`,
      maxBuffer: MAX_RESPONSE_BYTES + 1024,
    },
  );
  if (result.error != null) {
    throw new UsageMonitorError(
      `curl request failed: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "")
      .trim()
      .slice(0, 500);
    throw new UsageMonitorError(
      `curl request exited ${String(result.status)}${detail === "" ? "" : `: ${detail}`}`,
    );
  }

  const separator = result.stdout.lastIndexOf("\n");
  const statusText = separator === -1 ? "" : result.stdout.slice(separator + 1);
  const status = Number(statusText);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new UsageMonitorError(
      "curl response did not contain a valid HTTP status",
    );
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    text: result.stdout.slice(0, separator),
  };
}

export async function fetchUsageOnce({
  endpoint,
  auth,
  startDate,
  endDateExclusive,
  fetchImpl = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const url = new URL(endpoint);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDateExclusive);
  url.searchParams.set("group_by", "day");
  url.searchParams.set("workspace_user", "true");

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
  };
  let response;
  let text;
  try {
    if (fetchImpl == null) {
      response = curlUsageRequest(url, { headers, timeoutMs });
      text = response.text;
    } else {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    }
  } catch (error) {
    if (error instanceof UsageMonitorError) throw error;
    throw new UsageMonitorError(`usage request failed: ${error.message}`, {
      cause: error,
    });
  }

  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new UsageMonitorError(
      `usage response exceeded ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new UsageMonitorError(
      `usage endpoint returned non-JSON (HTTP ${response.status})`,
      {
        status: response.status,
        cause: error,
      },
    );
  }
  if (!response.ok) {
    const detail = responseDetail(body);
    throw new UsageMonitorError(
      `usage endpoint returned HTTP ${response.status}${detail == null ? "" : `: ${detail}`}`,
      { status: response.status },
    );
  }
  return normalizeUsageResponse(body);
}

export async function fetchUsageWithAuthRetry({
  endpoint,
  authFile,
  startDate,
  endDateExclusive,
  allowRefresh = true,
  readAuth = readCodexAuth,
  refreshAuth = refreshCodexAuth,
  fetchImpl = null,
}) {
  let auth = await readAuth(authFile);
  try {
    const response = await fetchUsageOnce({
      endpoint,
      auth,
      startDate,
      endDateExclusive,
      fetchImpl,
    });
    return { response, auth, refreshedAuth: false };
  } catch (error) {
    if (
      !(error instanceof UsageMonitorError) ||
      error.status !== 401 ||
      !allowRefresh
    ) {
      throw error;
    }
  }

  await refreshAuth();
  auth = await readAuth(authFile);
  const response = await fetchUsageOnce({
    endpoint,
    auth,
    startDate,
    endDateExclusive,
    fetchImpl,
  });
  return { response, auth, refreshedAuth: true };
}

export async function refreshCodexAuth() {
  const command = process.env.CODEX_BIN || "codex";
  const result = spawnSync(command, ["debug", "models"], {
    stdio: "ignore",
    timeout: 60_000,
  });
  if (result.error != null) {
    throw new UsageMonitorError(
      `Codex auth refresh command failed: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    throw new UsageMonitorError(
      `Codex auth refresh command exited ${String(result.status)}; run codex login again`,
    );
  }
}

export function accountFingerprint(accountId) {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 16);
}

export async function readArchive(output) {
  try {
    const archive = JSON.parse(await fsp.readFile(output, "utf8"));
    if (archive?.schema_version !== 1 || !Array.isArray(archive.days)) {
      throw new UsageMonitorError(
        `unsupported usage archive schema: ${output}`,
      );
    }
    return archive;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof UsageMonitorError) throw error;
    throw new UsageMonitorError(`cannot read usage archive: ${output}`, {
      cause: error,
    });
  }
}

function comparableDay(day) {
  const { last_observed_at: _lastObservedAt, ...metrics } = day;
  return metrics;
}

export function mergeArchive({
  previous,
  response,
  fetchedAt,
  endpoint,
  startDate,
  endDateExclusive,
  workspaceFingerprint,
}) {
  if (
    previous?.workspace_fingerprint != null &&
    previous.workspace_fingerprint !== workspaceFingerprint
  ) {
    throw new UsageMonitorError(
      "the output archive belongs to a different ChatGPT account; choose another --output path",
    );
  }

  const merged = new Map((previous?.days ?? []).map((day) => [day.date, day]));
  const changes = { added: [], updated: [], unchanged: [] };
  for (const entry of response.data) {
    const prior = merged.get(entry.date);
    const next = { ...entry, last_observed_at: fetchedAt };
    if (prior == null) {
      changes.added.push(entry.date);
    } else if (
      JSON.stringify(comparableDay(prior)) ===
      JSON.stringify(comparableDay(next))
    ) {
      changes.unchanged.push(entry.date);
    } else {
      changes.updated.push(entry.date);
    }
    merged.set(entry.date, next);
  }

  return {
    archive: {
      schema_version: 1,
      workspace_fingerprint: workspaceFingerprint,
      source: {
        endpoint,
        group_by: "day",
        workspace_user: true,
      },
      updated_at: fetchedAt,
      last_request: {
        start_date: startDate,
        end_date_exclusive: endDateExclusive,
        returned_days: response.data.length,
      },
      days: [...merged.values()].sort((left, right) =>
        left.date.localeCompare(right.date),
      ),
    },
    changes,
  };
}

export async function writeArchiveAtomic(output, archive) {
  const outputDir = path.dirname(output);
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    outputDir,
    `.${path.basename(output)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fsp.rename(temporary, output);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw new UsageMonitorError(
      `cannot atomically write usage archive: ${output}`,
      {
        cause: error,
      },
    );
  }
}

function formatNumber(value, maximumFractionDigits = 0) {
  if (value == null) return "pending";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

function dataState(entry, today) {
  if (TOKEN_COUNTER_KEYS.some((key) => entry.totals[key] == null))
    return "unsettled";
  const hasMeasuredUsage =
    (entry.totals.credits ?? 0) > 0 ||
    (entry.totals.text_total_tokens ?? 0) > 0;
  const countMetricsLag =
    hasMeasuredUsage &&
    [entry.totals.users, entry.totals.threads, entry.totals.turns].some(
      (value) => value === 0,
    );
  if (countMetricsLag) return "unsettled";
  if (entry.date === today) return "live";
  return "reported";
}

export function renderTable(response, today) {
  const rows = response.data.map((entry) => {
    const totals = entry.totals;
    return [
      entry.date,
      dataState(entry, today),
      formatNumber(totals.credits, 3),
      formatNumber(totals.threads),
      formatNumber(totals.turns),
      formatNumber(totals.uncached_text_input_tokens),
      formatNumber(totals.cached_text_input_tokens),
      formatNumber(totals.text_output_tokens),
      formatNumber(totals.text_total_tokens),
    ];
  });
  const headers = [
    "date",
    "state",
    "credits",
    "threads",
    "turns",
    "input_uncached",
    "input_cached",
    "output",
    "tokens_total",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const renderRow = (row) =>
    row
      .map((cell, index) =>
        index < 2
          ? String(cell).padEnd(widths[index])
          : String(cell).padStart(widths[index]),
      )
      .join("  ");
  return [
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(renderRow),
  ].join("\n");
}

function changeSummary(changes) {
  return `added=${changes.added.length} updated=${changes.updated.length} unchanged=${changes.unchanged.length}`;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const { startDate, endDateExclusive, today } = calculateDateRange(options);
  const fetchedAt = new Date().toISOString();
  const { response, auth, refreshedAuth } = await fetchUsageWithAuthRetry({
    endpoint: options.endpoint,
    authFile: options.authFile,
    startDate,
    endDateExclusive,
    allowRefresh: options.refreshAuth,
  });

  let changes = null;
  if (options.write) {
    const previous = await readArchive(options.output);
    const merged = mergeArchive({
      previous,
      response,
      fetchedAt,
      endpoint: options.endpoint,
      startDate,
      endDateExclusive,
      workspaceFingerprint: accountFingerprint(auth.accountId),
    });
    await writeArchiveAtomic(options.output, merged.archive);
    changes = merged.changes;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          fetched_at: fetchedAt,
          request: {
            start_date: startDate,
            end_date_exclusive: endDateExclusive,
          },
          refreshed_auth: refreshedAuth,
          data: response.data,
          ...(changes == null
            ? {}
            : { archive_changes: changes, archive_path: options.output }),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (response.data.length === 0) {
    process.stdout.write(
      `No usage rows returned for ${startDate} through ${addUtcDays(endDateExclusive, -1)}.\n`,
    );
  } else {
    process.stdout.write(`${renderTable(response, today)}\n`);
  }
  if (changes != null) {
    process.stdout.write(
      `Archive: ${options.output} (${changeSummary(changes)})\n`,
    );
  }
  if (refreshedAuth)
    process.stdout.write(
      "Auth: refreshed through the local Codex CLI after HTTP 401\n",
    );
}

const invokedPath =
  process.argv[1] == null
    ? null
    : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codex-daily-workspace-usage: ${message}\n`);
    process.exitCode = 1;
  });
}
