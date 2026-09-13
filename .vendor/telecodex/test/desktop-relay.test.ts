import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AppServerDesktopRelayClient,
  DesktopAppToolsClient,
  DesktopRelayDeliveryError,
  DesktopRelaySession,
  DesktopRelayUnavailableBeforeSubmitError,
  isActiveWriterError,
  type DesktopRelayClient,
  type DesktopWaitResult,
} from "../src/desktop-relay.js";
import type { AppServerRpc } from "../src/app-server-rpc.js";

function createClient(overrides: Partial<DesktopRelayClient> = {}): DesktopRelayClient {
  return {
    probe: vi.fn(async () => {}),
    snapshot: vi.fn(async (_threadId: string, afterCursor?: string): Promise<DesktopWaitResult> =>
      afterCursor
        ? {
            timedOut: false,
            wake: { reason: "turnCompleted", threadId: "thread-desktop", turnId: "turn-new" },
            polls: [{
              cursor: "cursor-2",
              changed: true,
              thread: { id: "thread-desktop", status: { type: "idle" } },
              latestTurn: { id: "turn-new", status: "completed" },
              latestAssistantMessageId: "agent-new",
              latestAssistantMessage: { id: "agent-new", turnId: "turn-new", text: "fallback" },
            }],
          }
        : {
            timedOut: false,
            polls: [{
              cursor: "cursor-1",
              changed: true,
              thread: { id: "thread-desktop", status: { type: "idle" } },
              latestTurn: { id: "turn-old", status: "completed" },
            }],
          }),
    sendMessage: vi.fn(async () => ({ threadId: "thread-desktop" })),
    readLatestTurn: vi.fn(async () => ({
      thread: { id: "thread-desktop", status: { type: "idle" } },
      turns: [{
        id: "turn-new",
        status: "completed",
        items: [{ type: "agentMessage", id: "agent-new", phase: "final_answer", text: "final answer" }],
      }],
    })),
    close: vi.fn(),
    ...overrides,
  };
}

function createCallbacks() {
  return {
    onTurnAccepted: vi.fn(),
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    onHistoryWatermark: vi.fn(),
  };
}

describe("DesktopRelaySession", () => {
  it.each(["idle", "active"])("attests a Desktop-owned target in %s state", async (status) => {
    const client = createClient({
      snapshot: vi.fn(async () => ({
        polls: [{
          cursor: "cursor-live",
          thread: { id: "thread-desktop", status: { type: status } },
        }],
      })),
    });
    const relay = new DesktopRelaySession(
      "thread-desktop",
      { pipePath: "/tmp/desktop.sock", callerThreadId: "thread-phone" },
      client,
    );

    await expect(relay.probe()).resolves.toBeUndefined();
  });

  it.each(["notLoaded", "systemError"])(
    "rejects a target that Desktop reports as %s",
    async (status) => {
      const client = createClient({
        snapshot: vi.fn(async () => ({
          polls: [{
            cursor: "cursor-live",
            thread: { id: "thread-desktop", status: { type: status } },
          }],
        })),
      });
      const relay = new DesktopRelaySession(
        "thread-desktop",
        { pipePath: "/tmp/desktop.sock", callerThreadId: "thread-phone" },
        client,
      );

      await expect(relay.probe()).rejects.toThrow(`status: ${status}`);
      expect(client.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects a snapshot for the wrong target", async () => {
    const client = createClient({
      snapshot: vi.fn(async () => ({
        polls: [{
          cursor: "cursor-live",
          thread: { id: "thread-other", status: { type: "idle" } },
        }],
      })),
    });
    const relay = new DesktopRelaySession(
      "thread-desktop",
      { pipePath: "/tmp/desktop.sock", callerThreadId: "thread-phone" },
      client,
    );

    await expect(relay.probe()).rejects.toThrow("does not own thread thread-desktop");
  });

  it("sends through the Desktop owner and projects its completed answer", async () => {
    const client = createClient();
    const relay = new DesktopRelaySession(
      "thread-desktop",
      { pipePath: "/tmp/desktop.sock", callerThreadId: "thread-phone" },
      client,
    );
    const callbacks = createCallbacks();

    await relay.prompt({
      text: "continue here",
      provenance: {
        transport: "telegram",
        senderTrust: "allowed-user-id",
        chatId: "123",
        messageKind: "text",
        forwarded: false,
      },
    }, callbacks);

    expect(client.snapshot).toHaveBeenNthCalledWith(1, "thread-desktop");
    expect(client.sendMessage).toHaveBeenCalledWith("thread-desktop", "continue here");
    expect(client.snapshot).toHaveBeenNthCalledWith(2, "thread-desktop", "cursor-1");
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("final answer");
    expect(callbacks.onHistoryWatermark).toHaveBeenCalledWith("agent-new");
    expect(callbacks.onAgentEnd).toHaveBeenCalledOnce();
    expect(relay.isProcessing()).toBe(false);
  });

  it("fails before submission when the Desktop capability socket is gone", async () => {
    const client = createClient({
      snapshot: vi.fn(async () => { throw new Error("ENOENT"); }),
    });
    const relay = new DesktopRelaySession(
      "thread-desktop",
      { pipePath: "/tmp/missing.sock", callerThreadId: "thread-phone" },
      client,
    );

    await expect(relay.prompt("hello", createCallbacks())).rejects.toBeInstanceOf(
      DesktopRelayUnavailableBeforeSubmitError,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("does not retry an unconfirmed Desktop submission", async () => {
    const client = createClient({
      sendMessage: vi.fn(async () => { throw new Error("socket closed"); }),
    });
    const relay = new DesktopRelaySession(
      "thread-desktop",
      { pipePath: "/tmp/desktop.sock", callerThreadId: "thread-phone" },
      client,
    );

    await expect(relay.prompt("hello", createCallbacks())).rejects.toBeInstanceOf(
      DesktopRelayDeliveryError,
    );
    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it("recognizes only the writer-conflict form of app-server invalid requests", () => {
    expect(isActiveWriterError(Object.assign(
      new Error("thread abc already has an active writer"),
      { code: -32600 },
    ))).toBe(true);
    expect(isActiveWriterError(Object.assign(
      new Error("another invalid request"),
      { code: -32600 },
    ))).toBe(false);
    expect(isActiveWriterError(Object.assign(
      new Error("thread abc already has an active writer"),
      { code: -32603 },
    ))).toBe(false);
  });
});

describe("DesktopAppToolsClient", () => {
  it("uses the installed Desktop MCP adapter and feature-detects its tools", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "desktop-relay-test-"));
    const serverPath = path.join(tempDir, "fake-app-tools.mjs");
    writeFileSync(serverPath, `
      process.stdin.setEncoding("utf8");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          let result = {};
          if (request.method === "initialize") {
            result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
          } else if (request.method === "tools/list") {
            result = { tools: [
              { name: "read_thread", inputSchema: { type: "object" } },
              { name: "send_message_to_thread", inputSchema: { type: "object" } },
              { name: "wait_threads", inputSchema: { type: "object" } },
            ] };
          } else if (request.method === "tools/call") {
            result = { isError: false, content: [{ type: "text", text: JSON.stringify({
              polls: [{ cursor: "cursor-live" }],
              received: request.params,
            }) }] };
          }
          process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", result }) + "\\n");
        }
      });
    `, "utf8");

    try {
      const client = new DesktopAppToolsClient(
        "/tmp/fake-capability.sock",
        "thread-caller",
        { nodePath: process.execPath, serverPath },
      );

      await client.probe();
      const snapshot = await client.snapshot("thread-target") as DesktopWaitResult & {
        received: {
          name: string;
          arguments: Record<string, unknown>;
          _meta: { threadId: string };
        };
      };
      client.close();

      expect(snapshot.polls).toEqual([{ cursor: "cursor-live" }]);
      expect(snapshot.received).toEqual({
        name: "wait_threads",
        arguments: {
          targets: [{ threadId: "thread-target" }],
          timeoutMs: 0,
        },
        _meta: { threadId: "thread-caller" },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("AppServerDesktopRelayClient", () => {
  it("runs the CUA helper through the signed app-server command surface", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const rpc: AppServerRpc = {
      connect: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      onNotification: vi.fn(() => () => {}),
      notify: vi.fn(),
      request: vi.fn(async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            result: { polls: [{ cursor: "cursor-via-app-server" }] },
          })}\n`,
          stderr: "",
        };
      }),
    };
    const descriptor = {
      pipePath: "/tmp/codex-browser-use/desktop.sock",
      callerThreadId: "thread-caller",
      nodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    };
    const client = new AppServerDesktopRelayClient(descriptor, rpc, {
      helperPath: "/workspace/dist/desktop-relay-command.js",
    });

    await expect(client.snapshot("thread-target")).resolves.toEqual({
      polls: [{ cursor: "cursor-via-app-server" }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("command/exec");
    const params = requests[0]?.params as {
      command: string[];
      cwd: string;
      timeoutMs: number;
      outputBytesCap: number;
    };
    expect(params.command.slice(0, 2)).toEqual([
      descriptor.nodePath,
      "/workspace/dist/desktop-relay-command.js",
    ]);
    expect(params.cwd).toBe("/workspace/dist");
    const decoded = JSON.parse(Buffer.from(params.command[2]!, "base64").toString("utf8"));
    expect(decoded).toEqual({
      operation: "snapshot",
      descriptor,
      threadId: "thread-target",
    });
  });
});
