import { describe, expect, it, vi } from "vitest";

import type { AppServerNotification, AppServerRpc } from "../src/app-server-rpc.js";
import { CodexSessionService, RewindTerminalTimeoutError } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

class FakeRpc implements AppServerRpc {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly desktopRelayOperations: string[] = [];
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  threadTurns: Array<{ id: string; status: string; items: unknown[] }> = [];
  readonly failures = new Map<string, Error>();

  async connect(): Promise<void> {}
  isConnected(): boolean { return true; }
  notify(): void {}
  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    const failure = this.failures.get(method);
    if (failure) throw failure;
    if (method === "thread/resume") {
      return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } } as TResult;
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1", status: "inProgress", items: [] } } as TResult;
    }
    if (method === "turn/steer") return { turnId: "turn-1" } as TResult;
    if (method === "thread/read") {
      return {
        thread: { id: "thread-1", status: { type: "idle" }, turns: this.threadTurns },
      } as TResult;
    }
    if (method === "thread/rollback") {
      const numTurns = (params as { numTurns: number }).numTurns;
      this.threadTurns = this.threadTurns.slice(0, -numTurns);
      return {
        thread: { id: "thread-1", status: { type: "idle" }, turns: this.threadTurns },
      } as TResult;
    }
    if (method === "thread/loaded/list") return { data: [], nextCursor: null } as TResult;
    if (method === "skills/list") {
      return {
        data: [{
          cwd: "/workspace/base",
          skills: [
            {
              name: "user-enabled",
              description: "available on the phone",
              path: "/skills/user-enabled/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "repo-skill",
              description: "not a user skill",
              path: "/workspace/base/.codex/skills/repo-skill/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            {
              name: "user-disabled",
              description: "disabled",
              path: "/skills/user-disabled/SKILL.md",
              scope: "user",
              enabled: false,
            },
          ],
          errors: [],
        }],
      } as TResult;
    }
    if (method === "command/exec") {
      const command = (params as { command: string[] }).command;
      const request = JSON.parse(Buffer.from(command[2]!, "base64").toString("utf8")) as {
        operation: string;
        afterCursor?: string;
      };
      this.desktopRelayOperations.push(request.operation);
      let result: unknown;
      if (request.operation === "snapshot") {
        result = request.afterCursor
          ? {
              wake: { reason: "turnCompleted", threadId: "thread-1", turnId: "turn-desktop" },
              polls: [{
                cursor: "cursor-2",
                changed: true,
                thread: { id: "thread-1", status: { type: "idle" } },
                latestTurn: { id: "turn-desktop", status: "completed" },
                latestAssistantMessageId: "agent-desktop",
                latestAssistantMessage: { text: "relayed answer" },
              }],
            }
          : {
              polls: [{
                cursor: "cursor-1",
                thread: { id: "thread-1", status: { type: "idle" } },
                latestTurn: { id: "turn-old", status: "completed" },
              }],
            };
      } else if (request.operation === "readLatestTurn") {
        result = {
          turns: [{
            id: "turn-desktop",
            items: [{
              type: "agentMessage",
              id: "agent-desktop",
              phase: "final_answer",
              text: "relayed answer",
            }],
          }],
        };
      }
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, result })}\n`,
        stderr: "",
      } as TResult;
    }
    return {} as TResult;
  }
  emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

function createConfig(): TeleCodexConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexModel: "gpt-5.4",
    codexBackend: "app-server",
    codexAppServerSocket: "/tmp/app-server.sock",
    codexThreadIdleTimeoutMs: 60 * 60 * 1_000,
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    toolVerbosity: "none",
    showTurnTokenUsage: false,
    enableTelegramReactions: false,
  };
}

describe("CodexSessionService app-server route", () => {
  it("routes a cold prompt through Desktop when direct resume finds its writer", async () => {
    const rpc = new FakeRpc();
    const conflict = Object.assign(
      new Error("thread thread-1 already has an active writer"),
      { code: -32600 },
    );
    rpc.failures.set("thread/resume", conflict);
    const resolver = vi.fn(async () => ({
      pipePath: "/tmp/codex-browser-use/desktop.sock",
      callerThreadId: "thread-caller",
    }));
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1", desktopRelayResolver: resolver },
      rpc,
    );
    const callbacks = {
      onTurnAccepted: vi.fn(),
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
      onHistoryWatermark: vi.fn(),
    };

    await service.prompt("continue from Telegram", callbacks);

    expect(resolver).toHaveBeenCalledWith("thread-1", undefined);
    expect(service.getInfo()).toMatchObject({
      threadId: "thread-1",
      bindingMode: "desktop-relay",
      desktopRelay: {
        pipePath: "/tmp/codex-browser-use/desktop.sock",
        callerThreadId: "thread-caller",
      },
    });
    expect(rpc.desktopRelayOperations).toEqual([
      "probe",
      "snapshot",
      "snapshot",
      "sendMessage",
      "snapshot",
      "readLatestTurn",
    ]);
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("relayed answer");
    expect(callbacks.onAgentEnd).toHaveBeenCalledOnce();
  });

  it("uses the previous thread as caller when a switch finds a Desktop writer", async () => {
    const rpc = new FakeRpc();
    const conflict = Object.assign(
      new Error("thread thread-1 already has an active writer"),
      { code: -32600 },
    );
    rpc.failures.set("thread/resume", conflict);
    const resolver = vi.fn(async (_threadId: string, callerThreadId?: string | null) => ({
      pipePath: "/tmp/codex-browser-use/desktop.sock",
      callerThreadId: callerThreadId!,
    }));
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-old", desktopRelayResolver: resolver },
      rpc,
    );

    await expect(service.switchSession("thread-1")).resolves.toMatchObject({
      threadId: "thread-1",
      bindingMode: "desktop-relay",
    });

    expect(resolver).toHaveBeenCalledWith("thread-1", "thread-old");
    expect(rpc.desktopRelayOperations).toEqual(["probe", "snapshot"]);
  });

  it("preserves the active-writer error when Desktop does not own the thread", async () => {
    const rpc = new FakeRpc();
    const conflict = Object.assign(
      new Error("thread thread-1 already has an active writer"),
      { code: -32600 },
    );
    rpc.failures.set("thread/resume", conflict);
    const resolver = vi.fn(async () => null);
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1", desktopRelayResolver: resolver },
      rpc,
    );

    await expect(service.prompt("do not misroute", {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    })).rejects.toBe(conflict);

    expect(resolver).toHaveBeenCalledWith("thread-1", undefined);
    expect(rpc.desktopRelayOperations).toEqual([]);
  });

  it("clears a direct binding only after the writer is verifiably released", async () => {
    const rpc = new FakeRpc();
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1" },
      rpc,
    );

    await expect(service.handback()).resolves.toEqual({
      threadId: "thread-1",
      workspace: "/workspace/base",
    });
    expect(rpc.requests.map((entry) => entry.method)).toEqual([
      "thread/archive",
      "thread/unarchive",
      "thread/loaded/list",
    ]);
    expect(service.hasActiveThread()).toBe(false);
  });

  it("preserves the direct binding when writer release fails", async () => {
    const rpc = new FakeRpc();
    rpc.failures.set("thread/archive", new Error("archive failed"));
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1" },
      rpc,
    );

    await expect(service.handback()).rejects.toThrow("archive failed");
    expect(service.getInfo().threadId).toBe("thread-1");
    expect(service.hasActiveThread()).toBe(true);
  });

  it("lists only enabled user-scoped skills with a forced fresh read", async () => {
    const rpc = new FakeRpc();
    const service = await CodexSessionService.create(
      createConfig(),
      { deferThreadStart: true },
      rpc,
    );

    await expect(service.listSkills()).resolves.toEqual([
      {
        name: "user-enabled",
        description: "available on the phone",
        path: "/skills/user-enabled/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
    expect(rpc.requests).toEqual([{
      method: "skills/list",
      params: { cwds: ["/workspace/base"], forceReload: true },
    }]);
  });

  it("delegates compact and resolves only after the compaction turn completes", async () => {
    const rpc = new FakeRpc();
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1" },
      rpc,
    );

    const compact = service.compactThread();
    await vi.waitFor(() => {
      expect(rpc.requests.map((entry) => entry.method)).toEqual([
        "thread/resume",
        "thread/compact/start",
      ]);
    });
    rpc.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress", items: [] },
    });
    rpc.emit("item/completed", {
      threadId: "thread-1",
      turnId: "turn-compact",
      item: { type: "contextCompaction", id: "compact-1" },
    });
    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-compact",
        status: "completed",
        items: [{ type: "contextCompaction", id: "compact-1" }],
      },
    });

    await compact;
  });

  it("lazily resumes, starts once, and steers later text into the active turn", async () => {
    const rpc = new FakeRpc();
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1" },
      rpc,
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    };

    expect(rpc.requests).toEqual([]);
    const prompt = service.prompt("first", callbacks);
    await vi.waitFor(() => expect(rpc.requests.some((entry) => entry.method === "turn/start")).toBe(true));
    expect(service.canSteer()).toBe(true);
    await expect(service.steer("follow-up")).resolves.toBe("turn-1");

    rpc.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      delta: "answer",
    });
    rpc.emit("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "agent-1", text: "answer plus final tail" },
    });
    rpc.emit("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "agent-1", text: "answer plus final tail" },
    });
    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await prompt;

    expect(rpc.requests.map((entry) => entry.method)).toEqual([
      "thread/resume",
      "turn/start",
      "turn/steer",
    ]);
    expect(callbacks.onTextDelta.mock.calls).toEqual([["answer"], [" plus final tail"]]);
    expect(callbacks.onAgentEnd).toHaveBeenCalledOnce();
  });

  it("interrupts, awaits terminal state, then rolls back the in-flight turn", async () => {
    const rpc = new FakeRpc();
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1" },
      rpc,
    );
    const callbacks = {
      onTurnAccepted: vi.fn(),
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    };
    const prompt = service.prompt("slow turn", callbacks);
    await vi.waitFor(() => expect(callbacks.onTurnAccepted).toHaveBeenCalledWith("turn-1"));

    const rewind = service.rewind(1, 250);
    await vi.waitFor(() => expect(rpc.requests.some((entry) => entry.method === "turn/interrupt")).toBe(true));
    expect(rpc.requests.some((entry) => entry.method === "thread/rollback")).toBe(false);

    rpc.threadTurns = [{ id: "turn-1", status: "interrupted", items: [] }];
    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });

    await expect(rewind).resolves.toEqual({ rolledBackTurnIds: ["turn-1"] });
    await prompt;
    expect(rpc.requests.map((entry) => entry.method)).toEqual([
      "thread/resume",
      "turn/start",
      "turn/interrupt",
      "thread/read",
      "thread/rollback",
    ]);
  });

  it("reports a terminal timeout and never rolls back blindly", async () => {
    const rpc = new FakeRpc();
    const service = await CodexSessionService.create(
      createConfig(),
      { resumeThreadId: "thread-1" },
      rpc,
    );
    const callbacks = {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    };
    const prompt = service.prompt("slow turn", callbacks);
    await vi.waitFor(() => expect(rpc.requests.some((entry) => entry.method === "turn/start")).toBe(true));

    await expect(service.rewind(1, 10)).rejects.toBeInstanceOf(RewindTerminalTimeoutError);
    expect(rpc.requests.some((entry) => entry.method === "thread/rollback")).toBe(false);

    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });
    await prompt;
  });
});
