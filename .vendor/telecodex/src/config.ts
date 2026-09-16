import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";
export type CodexBackend = "sdk" | "app-server";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never";
export type TelegramGroupTriggerMode = "mention-or-reply" | "all-authorized";

export interface TeleCodexConfig {
  telegramBotToken: string;
  telegramApiRoot?: string;
  telegramProxyUrl?: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  telegramGroupTriggerMode: TelegramGroupTriggerMode;
  workspace: string;
  maxFileSize: number;
  codexApiKey?: string;
  codexModel?: string;
  codexBackend?: CodexBackend;
  codexAppServerSocket?: string;
  codexThreadIdleTimeoutMs?: number;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  toolVerbosity: ToolVerbosity;
  showTurnTokenUsage: boolean;
  enableTelegramReactions: boolean;
}

export function loadCoreConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));
  const common = loadCommonConfig();
  return {
    telegramBotToken: "",
    telegramAllowedUserIds: [],
    telegramAllowedUserIdSet: new Set<number>(),
    telegramGroupTriggerMode: "mention-or-reply",
    ...common,
  };
}

export function loadConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramApiRoot = optionalString(process.env.TELEGRAM_API_BASE)?.replace(/\/+$/, "");
  const telegramProxyUrl =
    optionalString(process.env.HTTPS_PROXY) ?? optionalString(process.env.HTTP_PROXY);
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const common = loadCommonConfig();

  return {
    telegramBotToken,
    ...(telegramApiRoot ? { telegramApiRoot } : {}),
    ...(telegramProxyUrl ? { telegramProxyUrl } : {}),
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    telegramGroupTriggerMode: parseTelegramGroupTriggerMode(
      optionalString(process.env.TELEGRAM_GROUP_TRIGGER_MODE),
    ),
    ...common,
  };
}

function loadCommonConfig(): Omit<
  TeleCodexConfig,
  "telegramBotToken" | "telegramApiRoot" | "telegramProxyUrl" |
  "telegramAllowedUserIds" | "telegramAllowedUserIdSet" | "telegramGroupTriggerMode"
> {
  return {
    workspace: resolveWorkspace(),
    maxFileSize: parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE)),
    codexApiKey: optionalString(process.env.CODEX_API_KEY),
    codexModel: optionalString(process.env.CODEX_MODEL),
    codexBackend: parseCodexBackend(optionalString(process.env.CODEX_BACKEND)),
    codexAppServerSocket:
      optionalString(process.env.CODEX_APP_SERVER_SOCKET) ?? defaultAppServerSocket(),
    codexThreadIdleTimeoutMs: parsePositiveInteger(
      optionalString(process.env.CODEX_THREAD_IDLE_TIMEOUT_MS),
      60 * 60 * 1_000,
      "CODEX_THREAD_IDLE_TIMEOUT_MS",
    ),
    codexSandboxMode: parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE)),
    codexApprovalPolicy: parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY)),
    toolVerbosity: parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY)),
    showTurnTokenUsage: parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false),
    enableTelegramReactions: parseBooleanEnv(
      optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
      false,
    ),
  };
}

function parseTelegramGroupTriggerMode(raw: string | undefined): TelegramGroupTriggerMode {
  if (!raw || raw === "mention-or-reply") return "mention-or-reply";
  if (raw === "all-authorized") return raw;
  throw new Error(
    `Invalid TELEGRAM_GROUP_TRIGGER_MODE: ${raw}. Expected mention-or-reply or all-authorized.`,
  );
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveWorkspace(): string {
  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parseCodexBackend(raw: string | undefined): CodexBackend {
  if (!raw) return "sdk";
  if (raw === "sdk" || raw === "app-server") return raw;
  throw new Error(`Invalid CODEX_BACKEND: ${raw}. Expected sdk or app-server.`);
}

function defaultAppServerSocket(): string {
  const codexHome = optionalString(process.env.CODEX_HOME);
  if (codexHome) return path.join(codexHome, "app-server-control", "app-server-control.sock");
  const home = optionalString(process.env.HOME);
  return path.join(home ?? process.cwd(), ".codex", "app-server-control", "app-server-control.sock");
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}. Expected a positive integer.`);
  }
  return value;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (raw && raw !== "never") {
    throw new Error(
      "CODEX_APPROVAL_POLICY must be never: TeleCodex has no approval interaction. " +
      "Other policies require an implementation of approval handling.",
    );
  }
  return "never";
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}
