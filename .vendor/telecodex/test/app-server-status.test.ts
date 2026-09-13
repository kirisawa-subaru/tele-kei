import { describe, expect, it, vi } from "vitest";

import { AppServerStatusTracker, parseAccountRateLimits } from "../src/app-server-status.js";
import type { AppServerNotification, AppServerRpc } from "../src/app-server-rpc.js";

class FakeRpc implements AppServerRpc {
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  response: unknown = {};
  error: Error | undefined;
  connect = vi.fn(async () => {});
  request = vi.fn(async <TResult>() => {
    if (this.error) throw this.error;
    return this.response as TResult;
  });

  isConnected(): boolean {
    return true;
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {}

  emit(method: string, params?: unknown): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

describe("AppServerStatusTracker", () => {
  it("caches token usage notifications by thread and fresh-reads rate limits", async () => {
    const rpc = new FakeRpc();
    rpc.response = {
      rateLimits: {
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 27, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
    };
    const tracker = new AppServerStatusTracker(rpc, () => 123_456);
    rpc.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 952_000,
          inputTokens: 9_000,
          cachedInputTokens: 2_000,
          cacheWriteInputTokens: 0,
          outputTokens: 1_000,
          reasoningOutputTokens: 500,
        },
        last: {
          totalTokens: 10_000,
          inputTokens: 9_000,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 0,
          outputTokens: 100,
          reasoningOutputTokens: 50,
        },
        modelContextWindow: 456_000,
      },
    });

    await expect(tracker.readSnapshot("thread-1")).resolves.toEqual({
      weeklyUsage: { usedPercent: 27, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      fiveHourUsage: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      contextUsage: { contextTokens: 10_000, modelContextWindow: 456_000, observedAt: 123_456 },
    });
    expect(rpc.request).toHaveBeenCalledWith("account/rateLimits/read");
  });

  it("maps a primary 10080-minute window to weekly usage", () => {
    expect(parseAccountRateLimits({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_788_462_327 },
        secondary: null,
      },
    })).toEqual({
      weeklyUsage: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_788_462_327 },
    });
  });

  it("degrades without throwing when rate limits or token usage are unavailable", async () => {
    const rpc = new FakeRpc();
    rpc.error = new Error("app-server down");
    const tracker = new AppServerStatusTracker(rpc);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(tracker.readSnapshot("thread-missing")).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith("Failed to read Codex account rate limits:", "app-server down");
  });

  it("clears cached context when the thread closes", async () => {
    const rpc = new FakeRpc();
    const tracker = new AppServerStatusTracker(rpc, () => 42);
    rpc.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 110 },
        last: { totalTokens: 110 },
        modelContextWindow: 243_200,
      },
    });
    rpc.emit("thread/closed", { threadId: "thread-1" });

    await expect(tracker.readSnapshot("thread-1")).resolves.toEqual({});
  });

  it("replaces cached occupancy with the lower post-compact last total", async () => {
    const rpc = new FakeRpc();
    const tracker = new AppServerStatusTracker(rpc, () => 42);
    rpc.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 30_703 },
        last: { totalTokens: 8_318 },
        modelContextWindow: 243_200,
      },
    });
    rpc.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 30_703 },
        last: {
          totalTokens: 6_469,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 243_200,
      },
    });

    await expect(tracker.readSnapshot("thread-1")).resolves.toMatchObject({
      contextUsage: { contextTokens: 6_469, modelContextWindow: 243_200 },
    });
  });

  it("ignores missing last usage instead of falling back to lifetime total", async () => {
    const rpc = new FakeRpc();
    const tracker = new AppServerStatusTracker(rpc, () => 42);
    rpc.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 22_385 },
        last: { totalTokens: 8_093 },
        modelContextWindow: 243_200,
      },
    });
    rpc.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 30_703 },
        modelContextWindow: 243_200,
      },
    });

    await expect(tracker.readSnapshot("thread-1")).resolves.toMatchObject({
      contextUsage: { contextTokens: 8_093, modelContextWindow: 243_200 },
    });
  });
});
