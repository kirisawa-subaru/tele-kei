import { describe, expect, it, vi } from "vitest";

import { AppServerConversationBackend } from "../src/app-server-backend.js";
import { AppServerRpcError, type AppServerNotification, type AppServerRpc } from "../src/app-server-rpc.js";

class FakeRpc implements AppServerRpc {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  responses: Array<unknown | Error> = [];
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as TResult;
  }

  notify(): void {}

  emit(method: string, params?: unknown): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

function createBackend(rpc: FakeRpc, idleTimeoutMs = 60 * 60 * 1_000) {
  return new AppServerConversationBackend(rpc, {
    workspace: "/workspace",
    idleTimeoutMs,
  });
}

describe("AppServerConversationBackend", () => {
  it("starts a profiled legacy thread so rollback remains available", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push({ thread: { id: "thread-1", status: { type: "idle" }, turns: [] } });
    const backend = new AppServerConversationBackend(rpc, {
      workspace: "/vault/Study",
      model: "gpt-5.6-sol",
      developerInstructions: "Manage the study system.",
      dynamicTools: [{
        type: "function",
        name: "send_file",
        description: "Send a file.",
        inputSchema: { type: "object" },
      }],
    });

    await backend.newThread();

    expect(rpc.requests[0]).toEqual({
      method: "thread/start",
      params: {
        cwd: "/vault/Study",
        historyMode: "legacy",
        model: "gpt-5.6-sol",
        developerInstructions: "Manage the study system.",
        dynamicTools: [{
          type: "function",
          name: "send_file",
          description: "Send a file.",
          inputSchema: { type: "object" },
        }],
      },
    });
  });

  it("archive-cycles a thread so another app-server can acquire its writer", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      {},
      { thread: { id: "thread-1", status: { type: "notLoaded" }, turns: [] } },
      { data: [], nextCursor: null },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await expect(backend.handback()).resolves.toEqual({
      threadId: "thread-1",
      workspace: "/workspace",
    });

    expect(rpc.requests.map((entry) => entry.method)).toEqual([
      "thread/resume",
      "thread/archive",
      "thread/unarchive",
      "thread/loaded/list",
    ]);
    expect(backend.getState()).toEqual({ threadId: null, phase: "cold", steerable: false });
  });

  it("keeps its binding when the archive cycle does not release the writer", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      {},
      { thread: { id: "thread-1", status: { type: "notLoaded" }, turns: [] } },
      { data: ["thread-1"], nextCursor: null },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await expect(backend.handback()).rejects.toThrow("still holds its writer lock");
    expect(backend.getState().threadId).toBe("thread-1");
  });

  it("lazily resumes a cold thread and starts a turn", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      { status: "unsubscribed" },
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      { turn: { id: "turn-1", status: "inProgress", items: [] } },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await backend.release();
    const accepted = await backend.submit("hello");

    expect(accepted).toEqual({ kind: "started", threadId: "thread-1", turnId: "turn-1" });
    expect(rpc.requests.map((entry) => entry.method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
      "thread/resume",
      "turn/start",
    ]);
    expect((rpc.requests[3]?.params as { input: unknown[] }).input).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("steers the current active turn without waiting for completion", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      {
        thread: {
          id: "thread-1",
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "turn-active", status: "inProgress", items: [] }],
        },
      },
      { turnId: "turn-active" },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    const accepted = await backend.submit("more context");

    expect(accepted.kind).toBe("steered");
    expect(rpc.requests[1]).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "more context", text_elements: [] }],
      },
    });
  });

  it("steers a Telegram photo into the active turn with provenance", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      {
        thread: {
          id: "thread-1",
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "turn-active", status: "inProgress", items: [] }],
        },
      },
      { turnId: "turn-active" },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await backend.submit({
      text: "read this image",
      imagePaths: ["/tmp/photo.png"],
      provenance: {
        transport: "telegram",
        senderTrust: "allowed-user-id",
        chatId: "123",
        messageId: 789,
        messageKind: "photo",
        forwarded: false,
      },
    });

    expect(rpc.requests[1]).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        input: [
          { type: "text", text: "read this image", text_elements: [] },
          { type: "localImage", path: "/tmp/photo.png" },
        ],
        additionalContext: {
          "telecodex.transport": {
            kind: "application",
            value: JSON.stringify({
              transport: "telegram",
              senderTrust: "allowed-user-id",
              chatId: "123",
              messageId: 789,
              messageKind: "photo",
              forwarded: false,
            }),
          },
        },
        clientUserMessageId: "telegram:123:789",
      },
    });
  });

  it("keeps Telegram provenance out of user text and sends it as app context", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      { turn: { id: "turn-1", status: "inProgress", items: [] } },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await backend.submit({
      text: "hello from Telegram",
      provenance: {
        transport: "telegram",
        senderTrust: "allowed-user-id",
        chatId: "123",
        messageId: 456,
        messageKind: "text",
        forwarded: false,
      },
    });

    expect(rpc.requests[1]).toEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello from Telegram", text_elements: [] }],
        additionalContext: {
          "telecodex.transport": {
            kind: "application",
            value: JSON.stringify({
              transport: "telegram",
              senderTrust: "allowed-user-id",
              chatId: "123",
              messageId: 456,
              messageKind: "text",
              forwarded: false,
            }),
          },
        },
        clientUserMessageId: "telegram:123:456",
      },
    });
  });

  it("sends a selected skill and its arguments as first-class input in one turn", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      { turn: { id: "turn-1", status: "inProgress", items: [] } },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await backend.submit({
      skill: { name: "daily", path: "/tmp/codex-home/skills/daily/SKILL.md" },
      text: "last seven days",
    });

    expect(rpc.requests[1]).toEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [
          { type: "skill", name: "daily", path: "/tmp/codex-home/skills/daily/SKILL.md" },
          { type: "text", text: "last seven days", text_elements: [] },
        ],
      },
    });
  });

  it("waits for the compaction turn to complete after the start acknowledgement", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      {},
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    let settled = false;
    const compact = backend.compact().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(rpc.requests[1]).toEqual({
        method: "thread/compact/start",
        params: { threadId: "thread-1" },
      });
    });
    expect(settled).toBe(false);

    rpc.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress", items: [] },
    });
    rpc.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-compact",
      item: { type: "contextCompaction", id: "compact-1" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(backend.getState()).toMatchObject({ phase: "active", steerable: false });

    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-compact",
        status: "completed",
        items: [{ type: "contextCompaction", id: "compact-1" }],
      },
    });
    await compact;
    expect(settled).toBe(true);
  });

  it("times out if a compaction item starts but its turn never completes", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpc();
      rpc.responses.push(
        { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
        {},
      );
      const backend = createBackend(rpc);
      await backend.attach("thread-1");

      const compact = backend.compact();
      const rejection = expect(compact).rejects.toThrow(
        "Timed out waiting for Codex thread compaction to finish",
      );
      await Promise.resolve();
      await Promise.resolve();
      rpc.emit("turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-compact", status: "inProgress", items: [] },
      });
      rpc.emit("item/started", {
        threadId: "thread-1",
        turnId: "turn-compact",
        item: { type: "contextCompaction", id: "compact-1" },
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      await rejection;
      expect(backend.getState()).toMatchObject({ phase: "active", steerable: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a compaction turn non-steerable when timeout happens before its item starts", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpc();
      rpc.responses.push(
        { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
        {},
      );
      const backend = createBackend(rpc);
      await backend.attach("thread-1");

      const compact = backend.compact();
      const rejection = expect(compact).rejects.toThrow(
        "Timed out waiting for Codex thread compaction to finish",
      );
      await Promise.resolve();
      await Promise.resolve();
      rpc.emit("turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-compact", status: "inProgress", items: [] },
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      await rejection;
      expect(backend.getState()).toMatchObject({ phase: "active", steerable: false });
      await expect(backend.submit("must not steer")).rejects.toThrow(
        "Cannot submit input while thread compaction is in progress",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects compaction if the thread closes after its compaction item starts", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      {},
    );
    const backend = createBackend(rpc);
    await backend.attach("thread-1");

    const compact = backend.compact();
    await vi.waitFor(() => expect(rpc.requests.at(-1)?.method).toBe("thread/compact/start"));
    rpc.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress", items: [] },
    });
    rpc.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-compact",
      item: { type: "contextCompaction", id: "compact-1" },
    });
    const rejection = expect(compact).rejects.toThrow("Codex thread closed during compaction");
    rpc.emit("thread/closed", { threadId: "thread-1" });

    await rejection;
  });

  it("rejects compaction if the backend is disposed after its item starts", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      {},
    );
    const backend = createBackend(rpc);
    await backend.attach("thread-1");

    const compact = backend.compact();
    await vi.waitFor(() => expect(rpc.requests.at(-1)?.method).toBe("thread/compact/start"));
    rpc.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress", items: [] },
    });
    rpc.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-compact",
      item: { type: "contextCompaction", id: "compact-1" },
    });
    const rejection = expect(compact).rejects.toThrow("Codex app-server backend disposed");
    backend.dispose();

    await rejection;
  });

  it("refuses compaction while a turn is active", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push({
      thread: {
        id: "thread-1",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-active", status: "inProgress", items: [] }],
      },
    });
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    await expect(backend.compact()).rejects.toThrow("Cannot compact while a turn is in progress");
    expect(rpc.requests).toHaveLength(1);
  });

  it("reconciles a start/steer race once", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      new AppServerRpcError("thread already has an active turn", -32600),
      {
        thread: {
          id: "thread-1",
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "turn-desktop", status: "inProgress", items: [] }],
        },
      },
      { turnId: "turn-desktop" },
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    const accepted = await backend.submit("race");

    expect(accepted).toEqual({ kind: "steered", threadId: "thread-1", turnId: "turn-desktop" });
    expect(rpc.requests.map((entry) => entry.method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/read",
      "turn/steer",
    ]);
  });

  it("fans out events and resolves completion waiters", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      { turn: { id: "turn-1", status: "inProgress", items: [] } },
    );
    const backend = createBackend(rpc);
    const events: string[] = [];
    backend.subscribe((event) => events.push(event.type));

    await backend.attach("thread-1");
    const accepted = await backend.submit("hello");
    const completion = backend.waitForTurn(accepted.turnId);
    rpc.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello",
    });
    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [], error: null },
    });

    await completion;
    expect(events).toEqual(["agentMessageDelta", "turnCompleted"]);
    expect(backend.getState().phase).toBe("idle");
  });

  it("treats a terminal notification racing an interrupt error as settled", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      { turn: { id: "turn-1", status: "inProgress", items: [] } },
      new AppServerRpcError("no active turn to interrupt", -32600),
    );
    const backend = createBackend(rpc);

    await backend.attach("thread-1");
    const accepted = await backend.submit("hello");
    const completed = backend.waitForTurn(accepted.turnId);
    const interrupted = backend.interrupt(accepted.turnId);
    rpc.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });

    await expect(interrupted).resolves.toBeUndefined();
    await completed;
    expect(rpc.requests.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("rolls back exactly the requested completed turns", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push(
      {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
          turns: [
            { id: "turn-1", status: "completed", items: [] },
            { id: "turn-2", status: "completed", items: [] },
            { id: "turn-3", status: "interrupted", items: [] },
          ],
        },
      },
      {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
          turns: [{ id: "turn-1", status: "completed", items: [] }],
        },
      },
    );
    const backend = createBackend(rpc);
    backend.bindThread("thread-1");

    await expect(backend.rollback(2)).resolves.toMatchObject({
      rolledBackTurnIds: ["turn-2", "turn-3"],
    });
    expect(rpc.requests).toEqual([
      { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
      { method: "thread/rollback", params: { threadId: "thread-1", numTurns: 2 } },
    ]);
  });

  it("does not call rollback when fewer turns are available", async () => {
    const rpc = new FakeRpc();
    rpc.responses.push({
      thread: {
        id: "thread-1",
        status: { type: "idle" },
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    });
    const backend = createBackend(rpc);
    backend.bindThread("thread-1");

    await expect(backend.rollback(2)).rejects.toThrow("only 1 available");
    expect(rpc.requests.map((entry) => entry.method)).toEqual(["thread/read"]);
  });

  it("releases only after the idle lease and never extends it for deltas", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpc();
      rpc.responses.push(
        { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
        { status: "unsubscribed" },
      );
      const backend = createBackend(rpc, 60_000);

      await backend.attach("thread-1");
      rpc.emit("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-ignored",
        itemId: "item-1",
        delta: "delta",
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(rpc.requests.at(-1)?.method).toBe("thread/unsubscribe");
      expect(backend.getState().phase).toBe("cold");
    } finally {
      vi.useRealTimers();
    }
  });
});
