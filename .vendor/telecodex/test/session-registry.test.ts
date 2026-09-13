import path from "node:path";

import { vi } from "vitest";

import type { TeleCodexConfig } from "../src/config.js";
import { scopeContextKey } from "../src/core-protocol.js";

const mockFsState = vi.hoisted(() => {
  const files = new Map<string, string>();
  const directories = new Set<string>();

  return {
    files,
    directories,
    reset: () => {
      files.clear();
      directories.clear();
    },
  };
});

const mockSessionState = vi.hoisted(() => {
  const create = vi.fn();
  const sessions: Array<{
    getInfo: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    isProcessing: ReturnType<typeof vi.fn>;
    isThreadAttached: ReturnType<typeof vi.fn>;
    resumeThread: ReturnType<typeof vi.fn>;
    switchSession: ReturnType<typeof vi.fn>;
    useDesktopRelay: ReturnType<typeof vi.fn>;
    setInfo: (next: Partial<{
      threadId: string | null;
      workspace: string;
      model?: string;
      bindingMode?: "desktop-relay";
      desktopRelay?: { pipePath: string; callerThreadId: string };
    }>) => void;
  }> = [];

  const reset = () => {
    create.mockReset();
    sessions.length = 0;
  };

  return {
    create,
    sessions,
    reset,
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn((targetPath: string) => mockFsState.files.has(targetPath) || mockFsState.directories.has(targetPath)),
  mkdirSync: vi.fn((targetPath: string) => {
    mockFsState.directories.add(targetPath);
  }),
  readFileSync: vi.fn((targetPath: string) => {
    const content = mockFsState.files.get(targetPath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${targetPath}`);
    }
    return content;
  }),
  writeFileSync: vi.fn((targetPath: string, content: string) => {
    mockFsState.files.set(targetPath, content);
    mockFsState.directories.add(path.dirname(targetPath));
  }),
}));

vi.mock("../src/codex-session.js", () => ({
  CodexSessionService: {
    create: mockSessionState.create,
  },
}));

import { SessionRegistry } from "../src/session-registry.js";

describe("SessionRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createConfig = (overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "o3",
    codexAppServerSocket: "/tmp/telecodex-test-app-server.sock",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    toolVerbosity: "summary",
    showTurnTokenUsage: false,
    enableTelegramReactions: false,
    ...overrides,
  });

  const createMockSession = (info: {
    threadId: string | null;
    workspace: string;
    model?: string;
    bindingMode?: "desktop-relay";
    desktopRelay?: { pipePath: string; callerThreadId: string };
  }) => {
    let currentInfo = { ...info };
    let attached = false;
    const session = {
      getInfo: vi.fn(() => ({ ...currentInfo })),
      dispose: vi.fn(),
      isProcessing: vi.fn(() => false),
      isThreadAttached: vi.fn(() => attached),
      resumeThread: vi.fn(async (threadId: string) => {
        attached = true;
        currentInfo = { ...currentInfo, threadId };
        return { ...currentInfo };
      }),
      switchSession: vi.fn(async (threadId: string) => {
        attached = true;
        currentInfo = { ...currentInfo, threadId };
        return { ...currentInfo };
      }),
      useDesktopRelay: vi.fn(async (
        threadId: string,
        desktopRelay: { pipePath: string; callerThreadId: string },
      ) => {
        attached = true;
        currentInfo = {
          ...currentInfo,
          threadId,
          bindingMode: "desktop-relay",
          desktopRelay,
        };
        return { ...currentInfo };
      }),
      setInfo: (next: Partial<typeof currentInfo>) => {
        currentInfo = { ...currentInfo, ...next };
      },
    };
    mockSessionState.sessions.push(session);
    return session;
  };

  beforeEach(() => {
    mockFsState.reset();
    mockSessionState.reset();
    mockSessionState.create.mockImplementation(async (config: TeleCodexConfig, options?: {
      workspace?: string;
      model?: string;
      resumeThreadId?: string;
    }) =>
      createMockSession({
        threadId: options?.resumeThreadId ?? null,
        workspace: options?.workspace ?? config.workspace,
        model: options?.model ?? config.codexModel,
      }),
    );
  });

  it("returns the same session instance for the same context key", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123");

    expect(first).toBe(second);
    expect(mockSessionState.create).toHaveBeenCalledTimes(1);
  });

  it("returns different session instances for different context keys", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123:42");

    expect(first).not.toBe(second);
    expect(mockSessionState.create).toHaveBeenCalledTimes(2);
  });

  it("applies bot profile defaults to a new scoped context", async () => {
    const profileDirectory = path.join("/workspace/base", "profiles", "study");
    mockFsState.files.set(
      path.join(profileDirectory, "profile.json"),
      JSON.stringify({
        default_workspace: "/vault/Study",
        default_model: "gpt-5.6-sol",
        system_instructions: "SYSTEM.md",
        dynamic_tools: ["telegram.send_file"],
      }),
    );
    mockFsState.files.set(path.join(profileDirectory, "SYSTEM.md"), "Manage the study system.");
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate(scopeContextKey("study", "123"));

    expect(mockSessionState.create).toHaveBeenCalledWith(createConfig(), {
      workspace: "/vault/Study",
      model: "gpt-5.6-sol",
      deferThreadStart: undefined,
      resumeThreadId: undefined,
      desktopRelay: undefined,
      developerInstructions: "Manage the study system.",
      dynamicTools: [{
        type: "namespace",
        name: "telegram",
        description: "Actions on the Telegram conversation that owns this Codex thread.",
        tools: [{
          type: "function",
          name: "send_file",
          description: "Send an existing local file to the Telegram conversation that owns this thread. Use only when the user explicitly asks to receive the file.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                description: "Absolute path of the local file to send.",
              },
              caption: {
                type: "string",
                description: "Optional Telegram caption, at most 1024 characters.",
              },
              mode: {
                type: "string",
                enum: ["document", "photo"],
                description: "Use document by default. Use photo only when an image should preview inline.",
              },
            },
            required: ["path"],
          },
        }],
      }],
    });
  });

  it("two topic contexts in the same chat maintain independent sessions", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("67890:1");
    const second = await registry.getOrCreate("67890:2");

    expect(first).not.toBe(second);
    expect(registry.has("67890:1")).toBe(true);
    expect(registry.has("67890:2")).toBe(true);
  });

  it("removing one topic context does not affect another in the same chat", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("67890:1");
    await registry.getOrCreate("67890:2");
    registry.remove("67890:1");

    expect(registry.has("67890:1")).toBe(false);
    expect(registry.has("67890:2")).toBe(true);
  });

  it("restores distinct per-context workspace, model, and thread ids", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/a",
          model: "o4-mini",
          updatedAt: 10,
        },
        {
          contextKey: "123:42",
          threadId: "thread-b",
          workspace: "/workspace/b",
          model: "gpt-5.4",
          updatedAt: 20,
        },
      ]),
    );

    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123:42");

    expect(mockSessionState.create).toHaveBeenNthCalledWith(1, createConfig(), {
      workspace: "/workspace/a",
      model: "o4-mini",
      resumeThreadId: "thread-a",
    });
    expect(mockSessionState.create).toHaveBeenNthCalledWith(2, createConfig(), {
      workspace: "/workspace/b",
      model: "gpt-5.4",
      resumeThreadId: "thread-b",
    });
    expect(first.getInfo()).toEqual({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
    });
    expect(second.getInfo()).toEqual({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
    });
  });

  it("restores a persisted Desktop relay binding without attempting direct attach", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([{
        contextKey: "123",
        threadId: "thread-desktop",
        workspace: "/workspace/base",
        bindingMode: "desktop-relay",
        desktopRelay: {
          pipePath: "/tmp/codex-browser-use/desktop.sock",
          callerThreadId: "thread-phone",
        },
        updatedAt: 10,
      }]),
    );
    const config = createConfig({ codexBackend: "app-server" });
    const registry = new SessionRegistry(config);

    await registry.getOrCreate("123");

    expect(mockSessionState.create).toHaveBeenCalledWith(
      config,
      {
        workspace: "/workspace/base",
        model: undefined,
        deferThreadStart: undefined,
        resumeThreadId: "thread-desktop",
        desktopRelay: {
          pipePath: "/tmp/codex-browser-use/desktop.sock",
          callerThreadId: "thread-phone",
        },
      },
      expect.anything(),
    );
  });

  it("updates metadata and lists contexts sorted by newest first", async () => {
    const registry = new SessionRegistry(createConfig());
    const first = (await registry.getOrCreate("123")) as any;
    const second = (await registry.getOrCreate("123:42")) as any;
    const dateNowSpy = vi.spyOn(Date, "now");

    first.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
    });
    dateNowSpy.mockReturnValueOnce(1000);
    registry.updateMetadata("123", first as any);

    second.setInfo({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
    });
    dateNowSpy.mockReturnValueOnce(2000);
    registry.updateMetadata("123:42", second as any);

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123:42",
        threadId: "thread-b",
        workspace: "/workspace/b",
        model: "gpt-5.4",
        updatedAt: 2000,
      },
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        updatedAt: 1000,
      },
    ]);
  });

  it("binds a CLI thread to the most recent Telegram context and clears the old watermark", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-old",
          workspace: "/workspace/base",
          pastWatermark: "item-old",
          updatedAt: 20,
        },
        {
          contextKey: "123:42",
          threadId: "thread-topic",
          workspace: "/workspace/base",
          updatedAt: 10,
        },
      ]),
    );
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));

    const result = await registry.bindActiveThread("thread-cli");

    expect(result).toEqual({
      contextKey: "123",
      threadId: "thread-cli",
      previousThreadId: "thread-old",
      workspace: "/workspace/base",
      mode: "direct",
    });
    expect(mockSessionState.sessions[0]?.switchSession).toHaveBeenCalledWith("thread-cli");
    expect(JSON.parse(mockFsState.files.get(persistPath) ?? "[]")[0]).not.toHaveProperty(
      "pastWatermark",
    );
  });

  it("attaches a cold persisted thread without switching it", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-cli",
          workspace: "/workspace/base",
          updatedAt: 10,
        },
      ]),
    );
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));

    await registry.bindActiveThread("thread-cli");

    expect(mockSessionState.sessions[0]?.resumeThread).toHaveBeenCalledWith("thread-cli");
    expect(mockSessionState.sessions[0]?.switchSession).not.toHaveBeenCalled();
  });

  it("switches an active Desktop writer to Desktop relay by default", async () => {
    const persistPath = path.join("/workspace/base", ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([{
        contextKey: "123",
        threadId: "thread-old",
        workspace: "/workspace/base",
        updatedAt: 10,
      }]),
    );
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));
    const session = await registry.getOrCreate("123");
    const conflict = Object.assign(
      new Error("thread thread-desktop already has an active writer"),
      { code: -32600 },
    );
    session.switchSession.mockRejectedValueOnce(conflict);

    const result = await registry.bindActiveThread(
      "thread-desktop",
      undefined,
      { pipePath: "/tmp/codex-browser-use/desktop.sock" },
    );

    expect(session.useDesktopRelay).toHaveBeenCalledWith("thread-desktop", {
      pipePath: "/tmp/codex-browser-use/desktop.sock",
      callerThreadId: "thread-old",
    });
    expect(result).toEqual({
      contextKey: "123",
      threadId: "thread-desktop",
      previousThreadId: "thread-old",
      workspace: "/workspace/base",
      mode: "desktop-relay",
    });
    expect(JSON.parse(mockFsState.files.get(persistPath) ?? "[]")[0]).toMatchObject({
      threadId: "thread-desktop",
      bindingMode: "desktop-relay",
      desktopRelay: {
        pipePath: "/tmp/codex-browser-use/desktop.sock",
        callerThreadId: "thread-old",
      },
    });
  });

  it("keeps the active-writer error when no Desktop relay capability is present", async () => {
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));
    const session = await registry.getOrCreate("123");
    const conflict = Object.assign(
      new Error("thread thread-desktop already has an active writer"),
      { code: -32600 },
    );
    session.switchSession.mockRejectedValueOnce(conflict);

    await expect(registry.bindActiveThread("thread-desktop")).rejects.toBe(conflict);
    expect(session.useDesktopRelay).not.toHaveBeenCalled();
  });

  it("does not replace a different Telegram thread while it is active", async () => {
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));
    const session = await registry.getOrCreate("123");
    registry.updateMetadata("123", session as any);
    (session.isProcessing as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await expect(registry.bindActiveThread("thread-cli")).rejects.toThrow(
      "Cannot replace the Telegram thread while its current turn is active",
    );
  });

  it("persists and resolves an alert-specific reply route without replacing the context thread", async () => {
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));
    const session = await registry.getOrCreate("123");
    registry.updateMetadata("123", session as any);
    const originalThreadId = session.getInfo().threadId;

    const route = registry.registerReplyRoute(
      "thread-automation",
      "123",
      456,
      "card-hygiene",
    );

    expect(route).toMatchObject({
      contextKey: "123",
      messageId: 456,
      threadId: "thread-automation",
      automationId: "card-hygiene",
    });
    expect(registry.resolveReplyRoute("123", 456)).toEqual(route);
    expect(registry.resolveReplyRoute("123", 999)).toBeUndefined();
    expect(session.getInfo().threadId).toBe(originalThreadId);
    const persisted = JSON.parse(
      mockFsState.files.get(path.join("/workspace/base", ".telecodex", "reply-routes.json")) ?? "[]",
    );
    expect(persisted).toEqual([route]);
  });

  it("rejects an explicit Telegram context that has never been seen", async () => {
    const registry = new SessionRegistry(createConfig({ codexBackend: "app-server" }));

    await expect(registry.bindActiveThread("thread-cli", "999")).rejects.toThrow(
      "Unknown Telegram context: 999",
    );
  });

  it("removes a context and disposes its session", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = await registry.getOrCreate("123");

    registry.updateMetadata("123", session as any);
    registry.remove("123");

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(registry.has("123")).toBe(false);
    expect(registry.listContexts()).toEqual([]);
  });

  it("persists metadata and reloads it in a new registry", async () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    const registry = new SessionRegistry(config);
    const session = (await registry.getOrCreate("123")) as any;

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
    });
    registry.updateMetadata("123", session as any);

    expect(mockFsState.files.get(persistPath)).toContain("thread-a");

    const reloaded = new SessionRegistry(config);
    expect(reloaded.listContexts()).toEqual([
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("resets and persists the /past watermark after rollback", () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/base",
          pastWatermark: "agent-deleted",
          updatedAt: 10,
        },
      ]),
    );
    const registry = new SessionRegistry(config);

    registry.resetPastDelivered("123");

    expect(JSON.parse(mockFsState.files.get(persistPath) ?? "[]")[0]).toEqual({
      contextKey: "123",
      threadId: "thread-a",
      workspace: "/workspace/base",
      updatedAt: expect.any(Number),
    });
  });

  it("disposeAll disposes all sessions and clears the map", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("100");
    await registry.getOrCreate("200");

    expect(registry.has("100")).toBe(true);
    expect(registry.has("200")).toBe(true);

    registry.disposeAll();

    expect(registry.has("100")).toBe(false);
    expect(registry.has("200")).toBe(false);
  });

  it("remove fires onRemove callback", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("100");
    const removed: string[] = [];
    registry.onRemove((key) => removed.push(key));

    registry.remove("100");

    expect(removed).toEqual(["100"]);
    expect(registry.has("100")).toBe(false);
  });
});
