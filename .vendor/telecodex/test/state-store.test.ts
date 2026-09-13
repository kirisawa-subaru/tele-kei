import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scopeContextKey } from "../src/core-protocol.js";
import { CoreStateStore } from "../src/state-store.js";

describe("CoreStateStore", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "telecodex-state-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists bot-scoped bindings and reply routes across reopen", () => {
    const dbPath = path.join(directory, "state.sqlite");
    const store = new CoreStateStore(dbPath);
    const contextKey = scopeContextKey("main", "-100:7");
    store.replaceBindings([{
      contextKey,
      threadId: "thread-1",
      workspace: "/workspace",
      model: "gpt-test",
      pastWatermark: "item-1",
      updatedAt: 123,
    }]);
    store.replaceReplyRoutes([{
      contextKey,
      messageId: 42,
      threadId: "thread-1",
      createdAt: 456,
    }]);
    store.close();

    const reopened = new CoreStateStore(dbPath);
    expect(reopened.loadBindings()).toEqual([{
      contextKey,
      threadId: "thread-1",
      workspace: "/workspace",
      model: "gpt-test",
      pastWatermark: "item-1",
      updatedAt: 123,
    }]);
    expect(reopened.loadReplyRoutes()).toEqual([{
      contextKey,
      messageId: 42,
      threadId: "thread-1",
      createdAt: 456,
    }]);
    expect(reopened.getThreadOwner("thread-1")).toEqual({ botKey: "main", contextKey: "-100:7" });
    reopened.close();
  });

  it("rejects two Telegram contexts owning the same Codex thread", () => {
    const store = new CoreStateStore(path.join(directory, "state.sqlite"));
    expect(() => store.replaceBindings([
      {
        contextKey: scopeContextKey("main", "100"),
        threadId: "thread-shared",
        workspace: "/workspace",
        updatedAt: 1,
      },
      {
        contextKey: scopeContextKey("work", "200"),
        threadId: "thread-shared",
        workspace: "/workspace",
        updatedAt: 2,
      },
    ])).toThrow("only be owned by one Telegram context");
    expect(store.loadBindings()).toEqual([]);
    store.close();
  });
});
