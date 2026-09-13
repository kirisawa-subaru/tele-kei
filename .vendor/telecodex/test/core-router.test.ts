import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CoreRpcClient, RemoteCodexSession, RemoteSessionRegistry } from "../src/core-client.js";
import { startCoreRouterServer, type CoreRouterServer } from "../src/core-server.js";
import type {
  CodexPromptInput,
  CodexSessionCallbacks,
  CodexSessionInfo,
} from "../src/codex-session.js";
import type { CodexSessionApi } from "../src/session-api.js";
import type { SessionRegistry } from "../src/session-registry.js";
import { CoreStateStore } from "../src/state-store.js";
import { DurableTurnJournal } from "../src/turn-journal.js";

class FakeSession implements CodexSessionApi {
  info: CodexSessionInfo = { threadId: null, workspace: "/workspace", model: "gpt-test" };
  processing = false;
  promptCount = 0;

  getInfo(): CodexSessionInfo { return { ...this.info }; }
  isProcessing(): boolean { return this.processing; }
  hasActiveThread(): boolean { return this.info.threadId !== null; }
  isThreadAttached(): boolean { return this.info.threadId !== null; }
  canSteer(): boolean { return this.processing; }
  supportsAbort(): boolean { return true; }
  getCurrentWorkspace(): string { return this.info.workspace; }
  listModels() { return []; }
  listSkills() { return Promise.resolve([]); }
  compactThread() { return Promise.resolve(); }
  abort() { this.processing = false; return Promise.resolve(); }
  steer() { return Promise.resolve(this.processing ? "turn-steered" : null); }
  rewind() { return Promise.resolve({ rolledBackTurnIds: ["old-turn"] }); }
  setModel(slug: string) { this.info.model = slug; return slug; }
  handback() {
    const result = { threadId: this.info.threadId, workspace: this.info.workspace };
    this.info.threadId = null;
    return Promise.resolve(result);
  }
  newThread(workspace?: string, model?: string) {
    this.info = {
      threadId: "thread-new",
      workspace: workspace ?? this.info.workspace,
      model: model ?? this.info.model,
    };
    return Promise.resolve(this.getInfo());
  }
  switchSession(threadId: string) {
    this.info.threadId = threadId;
    return Promise.resolve(this.getInfo());
  }
  async prompt(_input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    this.promptCount += 1;
    this.processing = true;
    callbacks.onTurnAccepted?.("turn-1");
    callbacks.onTextDelta("hello ");
    callbacks.onTextDelta("world");
    callbacks.onHistoryWatermark?.("item-1");
    callbacks.onTurnComplete?.({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 });
    callbacks.onAgentEnd();
    this.processing = false;
  }
}

class FakeRegistry {
  readonly sessions = new Map<string, FakeSession>();
  readonly persisted: string[] = [];
  profileDefaults: { workspace?: string; model?: string } = {};
  readonly turnProvenance = new Map<string, unknown>();
  readonly registeredProvenance: unknown[] = [];

  hasMetadata(key: string): boolean { return this.sessions.has(key); }
  async getOrCreate(key: string): Promise<FakeSession> {
    let session = this.sessions.get(key);
    if (!session) {
      session = new FakeSession();
      this.sessions.set(key, session);
    }
    return session;
  }
  async getReplySession(threadId: string): Promise<FakeSession> {
    const session = new FakeSession();
    session.info.threadId = threadId;
    return session;
  }
  updateMetadata(key: string): void { this.persisted.push(key); }
  resolveReplyRoute() { return undefined; }
  readPast() { return Promise.resolve({ text: "past", shownMessages: 1, omittedMessages: 0 }); }
  readPastTail() { return Promise.resolve({ text: "tail", shownMessages: 1, omittedMessages: 0 }); }
  readLastInput() { return Promise.resolve("last input"); }
  markPastDelivered() {}
  resetPastDelivered() {}
  readProtocolStatus() { return Promise.resolve({}); }
  getProfileDefaults() { return this.profileDefaults; }
  registerTurnProvenance(threadId: string, turnId: string, provenance: unknown) {
    this.turnProvenance.set(`${threadId}:${turnId}`, provenance);
    this.registeredProvenance.push(provenance);
  }
  clearTurnProvenance(threadId: string, turnId: string) {
    this.turnProvenance.delete(`${threadId}:${turnId}`);
  }
}

describe("Core Router worker protocol", () => {
  let directory: string;
  let server: CoreRouterServer;
  let registry: FakeRegistry;
  let stateStore: CoreStateStore;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-core-"));
    registry = new FakeRegistry();
    stateStore = new CoreStateStore(path.join(directory, "state.sqlite"));
    server = await startCoreRouterServer(
      path.join(directory, "core.sock"),
      registry as unknown as SessionRegistry,
      new DurableTurnJournal(stateStore),
    );
  });

  afterEach(async () => {
    await server.close();
    stateStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("namespaces contexts by bot key and keeps synchronous worker snapshots", async () => {
    const main = new RemoteSessionRegistry(server.socketPath, "main");
    const work = new RemoteSessionRegistry(server.socketPath, "work");
    await Promise.all([main.initialize(), work.initialize()]);

    const mainSession = await main.getOrCreate("-100:7", { deferThreadStart: true });
    const workSession = await work.getOrCreate("-100:7", { deferThreadStart: true });
    await mainSession.newThread("/main", "gpt-main");
    await workSession.newThread("/work", "gpt-work");

    expect(mainSession.getInfo()).toMatchObject({ threadId: "thread-new", workspace: "/main" });
    expect(workSession.getInfo()).toMatchObject({ threadId: "thread-new", workspace: "/work" });
    expect(registry.sessions.size).toBe(2);
    expect([...registry.sessions.keys()].every((key) => key.includes("\u001f-100:7"))).toBe(true);
    main.close();
    work.close();
  });

  it("streams ordered turn events while Core owns the session", async () => {
    const remote = new RemoteSessionRegistry(server.socketPath, "main");
    await remote.initialize();
    const session = await remote.getOrCreate("123", { deferThreadStart: true });
    await session.newThread();
    const events: string[] = [];

    await session.prompt("hi", {
      onTurnAccepted: (turnId) => events.push(`accepted:${turnId}`),
      onTextDelta: (delta) => events.push(`text:${delta}`),
      onToolStart: () => {},
      onToolUpdate: () => {},
      onToolEnd: () => {},
      onHistoryWatermark: (itemId) => events.push(`watermark:${itemId}`),
      onTurnComplete: (usage) => events.push(`usage:${usage.outputTokens}`),
      onAgentEnd: () => events.push("end"),
    });

    expect(events).toEqual([
      "accepted:turn-1",
      "text:hello ",
      "text:world",
      "watermark:item-1",
      "usage:2",
      "end",
    ]);
    expect(session.isProcessing()).toBe(false);
    remote.close();
  });

  it("binds trusted Telegram provenance only while its turn is active", async () => {
    const remote = new RemoteSessionRegistry(server.socketPath, "main");
    await remote.initialize();
    const session = await remote.getOrCreate("123:7", { deferThreadStart: true });
    await session.newThread();

    await session.prompt({
      text: "hi",
      provenance: {
        transport: "telegram",
        botKey: "main",
        senderTrust: "allowed-user-id",
        senderUserId: 123,
        chatId: "123",
        messageId: 44,
        messageThreadId: 7,
        messageKind: "text",
        forwarded: false,
      },
    }, callbacksFor([]));

    expect(registry.registeredProvenance).toContainEqual({
      senderUserId: 123,
      chatId: "123",
      messageId: 44,
      messageThreadId: 7,
    });
    expect(registry.turnProvenance.size).toBe(0);
    remote.close();
  });

  it("uses profile workspace and model defaults for a new thread", async () => {
    registry.profileDefaults = { workspace: "/vault/Study", model: "gpt-5.6-sol" };
    const remote = new RemoteSessionRegistry(server.socketPath, "study");
    await remote.initialize();
    const session = await remote.getOrCreate("123", { deferThreadStart: true });

    await session.newThread();

    expect(session.getInfo()).toMatchObject({
      workspace: "/vault/Study",
      model: "gpt-5.6-sol",
    });
    remote.close();
  });

  it("refreshes the worker snapshot after a failed turn and a replayed failure", async () => {
    const remote = new RemoteSessionRegistry(server.socketPath, "main");
    await remote.initialize();
    const session = await remote.getOrCreate("123", { deferThreadStart: true });
    await session.newThread();
    const coreSession = [...registry.sessions.values()][0]!;
    const failure = "The 'gpt-6-astra' model requires a newer version of Codex.";
    const prompt = vi.spyOn(coreSession, "prompt").mockImplementation(async (_input, callbacks) => {
      coreSession.processing = true;
      try {
        callbacks.onTurnAccepted?.("failed-turn");
        throw new Error(failure);
      } finally {
        coreSession.processing = false;
      }
    });
    const input = {
      text: "hello",
      provenance: {
        transport: "telegram" as const,
        botKey: "main",
        senderTrust: "allowed-user-id" as const,
        chatId: "123",
        messageId: 100,
        messageKind: "text" as const,
        forwarded: false,
      },
    };

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(session.prompt(input, callbacksFor([]))).rejects.toThrow(failure);
        expect(session.isProcessing()).toBe(false);
        expect(session.canSteer()).toBe(false);
        expect(session.getInfo().threadId).toBe("thread-new");
      }
      expect(prompt).toHaveBeenCalledTimes(1);
      await expect(session.setModel("gpt-5.6-sol")).resolves.toBe("gpt-5.6-sol");
      prompt.mockRestore();
      await expect(session.prompt("try again", callbacksFor([]))).resolves.toBeUndefined();
    } finally {
      remote.close();
    }
  });

  it("keeps the worker busy when Core still has an active turn after rejecting input", async () => {
    const remote = new RemoteSessionRegistry(server.socketPath, "main");
    await remote.initialize();
    const session = await remote.getOrCreate("123", { deferThreadStart: true });
    await session.newThread();
    const coreSession = [...registry.sessions.values()][0]!;
    coreSession.processing = true;
    vi.spyOn(coreSession, "prompt").mockRejectedValue(new Error("Already processing a prompt"));

    try {
      await expect(session.prompt("hello", callbacksFor([]))).rejects.toThrow("Already processing");
      expect(session.isProcessing()).toBe(true);
      expect(session.canSteer()).toBe(true);
    } finally {
      remote.close();
    }
  });

  it("preserves the prompt error and busy state when snapshot recovery fails", async () => {
    const rpc = new CoreRpcClient(server.socketPath, "main");
    const state = {
      info: { threadId: "thread-1", workspace: "/workspace" },
      processing: true,
      activeThread: true,
      attached: true,
      steerable: true,
      abortable: true,
    };
    const session = new RemoteCodexSession(rpc, { kind: "context", contextKey: "123" }, state);
    const failure = new Error("Prompt connection lost");
    vi.spyOn(rpc, "request")
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error("Core unreachable"));

    await expect(session.prompt("hello", callbacksFor([]))).rejects.toBe(failure);

    expect(session.isProcessing()).toBe(true);
    expect(rpc.request).toHaveBeenLastCalledWith("session.snapshot", {
      target: { kind: "context", contextKey: "123" },
    });
    rpc.close();
  });

  it("replays a completed Telegram update without starting a second Codex turn", async () => {
    const input = {
      text: "same update",
      provenance: {
        transport: "telegram" as const,
        botKey: "main",
        senderTrust: "allowed-user-id" as const,
        chatId: "123",
        messageId: 99,
        messageKind: "text" as const,
        forwarded: false,
      },
    };
    const first = new RemoteSessionRegistry(server.socketPath, "main");
    await first.initialize();
    const firstSession = await first.getOrCreate("123", { deferThreadStart: true });
    await firstSession.newThread();
    const firstText: string[] = [];
    await firstSession.prompt(input, callbacksFor(firstText));
    first.close();

    const second = new RemoteSessionRegistry(server.socketPath, "main");
    await second.initialize();
    const secondSession = await second.getOrCreate("123", { deferThreadStart: true });
    const replayedText: string[] = [];
    await secondSession.prompt(input, callbacksFor(replayedText));

    expect(firstText).toEqual(["hello ", "world"]);
    expect(replayedText).toEqual(firstText);
    expect([...registry.sessions.values()][0]?.promptCount).toBe(1);
    second.close();
  });
});

function callbacksFor(text: string[]): CodexSessionCallbacks {
  return {
    onTextDelta: (delta) => text.push(delta),
    onToolStart: () => {},
    onToolUpdate: () => {},
    onToolEnd: () => {},
    onAgentEnd: () => {},
  };
}
