import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_API_BASE;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_GROUP_TRIGGER_MODE;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_BACKEND;
    delete process.env.CODEX_APP_SERVER_SOCKET;
    delete process.env.CODEX_THREAD_IDLE_TIMEOUT_MS;
    delete process.env.CODEX_SANDBOX_MODE;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.SHOW_TURN_TOKEN_USAGE;
    delete process.env.MAX_FILE_SIZE;
    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    delete process.env.container;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    expect(() => loadConfig()).toThrow("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_ALLOWED_USER_IDS is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    expect(() => loadConfig()).toThrow(
      "Missing required environment variable: TELEGRAM_ALLOWED_USER_IDS",
    );
  });

  it("parses a valid config correctly", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.CODEX_API_KEY = "secret-key";
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "never";
    process.env.TOOL_VERBOSITY = "all";

    const config = loadConfig();

    expect(config).toEqual({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123, 456],
      telegramAllowedUserIdSet: new Set([123, 456]),
      telegramGroupTriggerMode: "mention-or-reply",
      workspace: process.cwd(),
      maxFileSize: 20 * 1024 * 1024,
      codexApiKey: "secret-key",
      codexModel: "o3",
      codexBackend: "sdk",
      codexAppServerSocket: path.join(originalEnv.HOME ?? process.cwd(), ".codex", "app-server-control", "app-server-control.sock"),
      codexThreadIdleTimeoutMs: 60 * 60 * 1_000,
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "never",
      toolVerbosity: "all",
      showTurnTokenUsage: false,
      enableTelegramReactions: false,
    });
  });

  it.each(["on-request", "on-failure", "untrusted", "sometimes"])(
    "rejects unsupported approval policy %s before starting a turn",
    (policy) => {
      process.env.TELEGRAM_BOT_TOKEN = "bot-token";
      process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
      process.env.CODEX_APPROVAL_POLICY = policy;
      expect(() => loadConfig()).toThrow("CODEX_APPROVAL_POLICY must be never");
    },
  );

  it("applies default values for optional fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const config = loadConfig();

    expect(config.codexApiKey).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
    expect(config.codexBackend).toBe("sdk");
    expect(config.codexThreadIdleTimeoutMs).toBe(60 * 60 * 1_000);
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.toolVerbosity).toBe("summary");
    expect(config.showTurnTokenUsage).toBe(false);
    expect(config.enableTelegramReactions).toBe(false);
    expect(config.telegramGroupTriggerMode).toBe("mention-or-reply");
    expect(config.workspace).toBe(process.cwd());
  });

  it("uses a custom Telegram Bot API root without a trailing slash", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_API_BASE = "https://telegram.example.test/";

    expect(loadConfig().telegramApiRoot).toBe("https://telegram.example.test");
  });

  it("allows an explicit all-authorized group trigger mode", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_GROUP_TRIGGER_MODE = "all-authorized";
    expect(loadConfig().telegramGroupTriggerMode).toBe("all-authorized");
  });

  it("configures the shared app-server backend", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_BACKEND = "app-server";
    process.env.CODEX_APP_SERVER_SOCKET = "/tmp/codex-app-server.sock";
    process.env.CODEX_THREAD_IDLE_TIMEOUT_MS = "12345";

    const config = loadConfig();
    expect(config.codexBackend).toBe("app-server");
    expect(config.codexAppServerSocket).toBe("/tmp/codex-app-server.sock");
    expect(config.codexThreadIdleTimeoutMs).toBe(12345);
  });

  it("uses the HTTPS proxy for Telegram requests", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";

    expect(loadConfig().telegramProxyUrl).toBe("http://127.0.0.1:7897");
  });

  it("throws when a user id is invalid", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,nope";

    expect(() => loadConfig()).toThrow(
      "Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: nope",
    );
  });

  it("rejects an allowed-user list that becomes empty after parsing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " , , ";

    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_ALLOWED_USER_IDS=123,456",
        "CODEX_API_KEY='from-dotenv'",
        'CODEX_MODEL="gpt-4.1"',
        "CODEX_SANDBOX_MODE=read-only",
        "CODEX_APPROVAL_POLICY=never",
        'EXTRA_MULTILINE="hello\\nworld"',
      ].join("\n"),
    );
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.codexApiKey).toBe("from-dotenv");
    expect(config.codexModel).toBe("gpt-4.1");
    expect(config.codexSandboxMode).toBe("read-only");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("resolves workspace to /workspace when running in Docker", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });

  it("parses MAX_FILE_SIZE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.MAX_FILE_SIZE = String(5 * 1024 * 1024);

    const config = loadConfig();

    expect(config.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it("parses ENABLE_TELEGRAM_REACTIONS boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    const config = loadConfig();
    expect(config.enableTelegramReactions).toBe(false);
  });

  it("parses SHOW_TURN_TOKEN_USAGE boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(false);
    }

    delete process.env.SHOW_TURN_TOKEN_USAGE;
    const config = loadConfig();
    expect(config.showTurnTokenUsage).toBe(false);
  });

  it("falls back to defaults for invalid optional enum values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_SANDBOX_MODE = "unsafe";
    process.env.TOOL_VERBOSITY = "loud";
    process.env.MAX_FILE_SIZE = "nope";

    const config = loadConfig();

    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.toolVerbosity).toBe("summary");
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

});
