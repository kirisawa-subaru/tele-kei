import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeRateLimitHistory,
  normalizeRateLimitResponse,
  renderRateLimitSnapshot,
} from "./codex_rate_limit_snapshot.mjs";

const fixture = {
  rateLimits: {
    limitId: "codex",
    primary: {
      usedPercent: 6,
      windowDurationMins: 10080,
      resetsAt: 1787813190,
    },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: {
        usedPercent: 6,
        windowDurationMins: 10080,
        resetsAt: 1787813190,
      },
      secondary: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: 1787306688,
      },
      secondary: {
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: 1787893488,
      },
    },
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
};

test("normalizes every rate-limit bucket and preserves reset metadata", () => {
  const normalized = normalizeRateLimitResponse(fixture);
  assert.equal(normalized.rateLimits.primary.usedPercent, 6);
  assert.equal(
    normalized.rateLimitsByLimitId.codex.primary.windowDurationMins,
    10080,
  );
  assert.equal(
    normalized.rateLimitsByLimitId.codex_bengalfox.secondary.usedPercent,
    0,
  );
});

test("render includes primary and secondary percentages", () => {
  const output = renderRateLimitSnapshot(
    normalizeRateLimitResponse(fixture),
    "2026-08-21T05:00:00.000Z",
  );
  assert.match(output, /codex: primary=6%\/10080m/);
  assert.match(output, /codex_bengalfox: primary=0%\/300m/);
  assert.match(output, /secondary=0%\/10080m/);
});

test("history appends samples and removes entries outside retention", () => {
  const previous = {
    schema_version: 1,
    workspace_fingerprint: "workspace-a",
    snapshots: [
      { sampled_at: "2026-01-01T00:00:00.000Z", ...fixture },
      { sampled_at: "2026-08-20T05:00:00.000Z", ...fixture },
    ],
  };
  const history = mergeRateLimitHistory({
    previous,
    rateLimits: normalizeRateLimitResponse(fixture),
    sampledAt: "2026-08-21T05:00:00.000Z",
    workspaceFingerprint: "workspace-a",
    retentionDays: 180,
  });
  assert.deepEqual(
    history.snapshots.map((snapshot) => snapshot.sampled_at),
    ["2026-08-20T05:00:00.000Z", "2026-08-21T05:00:00.000Z"],
  );
});
