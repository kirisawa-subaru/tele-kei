import type { AppServerNotification, AppServerRpc } from "./app-server-rpc.js";

const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;

export interface RateLimitWindowUsage {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt?: number;
}

export interface ThreadContextUsage {
  contextTokens: number;
  modelContextWindow: number;
  observedAt: number;
}

export interface AppServerStatusSnapshot {
  weeklyUsage?: RateLimitWindowUsage;
  fiveHourUsage?: RateLimitWindowUsage;
  contextUsage?: ThreadContextUsage;
}

export class AppServerStatusTracker {
  private readonly threadContextUsage = new Map<string, ThreadContextUsage>();
  private readonly removeNotificationListener: () => void;

  constructor(
    private readonly rpc: AppServerRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.removeNotificationListener = rpc.onNotification((notification) =>
      this.handleNotification(notification),
    );
  }

  async readSnapshot(threadId: string | null): Promise<AppServerStatusSnapshot> {
    const contextUsage = threadId ? this.threadContextUsage.get(threadId) : undefined;

    try {
      await this.rpc.connect();
      const response = await this.rpc.request<unknown>("account/rateLimits/read");
      return {
        ...parseAccountRateLimits(response),
        ...(contextUsage ? { contextUsage: { ...contextUsage } } : {}),
      };
    } catch (error) {
      console.warn(
        "Failed to read Codex account rate limits:",
        error instanceof Error ? error.message : String(error),
      );
      return contextUsage ? { contextUsage: { ...contextUsage } } : {};
    }
  }

  dispose(): void {
    this.removeNotificationListener();
    this.threadContextUsage.clear();
  }

  private handleNotification(notification: AppServerNotification): void {
    const params = asRecord(notification.params);
    const threadId = stringValue(params.threadId);
    if (!threadId) return;

    if (notification.method === "thread/closed") {
      this.threadContextUsage.delete(threadId);
      return;
    }
    if (notification.method !== "thread/tokenUsage/updated") return;

    const tokenUsage = asRecord(params.tokenUsage);
    const contextTokens = nonNegativeNumber(asRecord(tokenUsage.last).totalTokens);
    const modelContextWindow = positiveNumber(tokenUsage.modelContextWindow);
    if (contextTokens === undefined || modelContextWindow === undefined) return;

    this.threadContextUsage.set(threadId, {
      contextTokens,
      modelContextWindow,
      observedAt: this.now(),
    });
  }
}

export function parseAccountRateLimits(value: unknown): Pick<
  AppServerStatusSnapshot,
  "weeklyUsage" | "fiveHourUsage"
> {
  const rateLimits = asRecord(asRecord(value).rateLimits);
  const windows = [rateLimits.primary, rateLimits.secondary]
    .map(parseRateLimitWindow)
    .filter((window): window is RateLimitWindowUsage => Boolean(window));
  const weeklyUsage = windows.find((window) => window.windowDurationMins === WEEKLY_WINDOW_MINS);
  const fiveHourUsage = windows.find((window) => window.windowDurationMins === FIVE_HOUR_WINDOW_MINS);

  return {
    ...(weeklyUsage ? { weeklyUsage } : {}),
    ...(fiveHourUsage ? { fiveHourUsage } : {}),
  };
}

function parseRateLimitWindow(value: unknown): RateLimitWindowUsage | undefined {
  const window = asRecord(value);
  const usedPercent = nonNegativeNumber(window.usedPercent);
  const windowDurationMins = positiveNumber(window.windowDurationMins);
  if (usedPercent === undefined || windowDurationMins === undefined) return undefined;

  const resetsAt = positiveNumber(window.resetsAt);
  return {
    usedPercent,
    windowDurationMins,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
