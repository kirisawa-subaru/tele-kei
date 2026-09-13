import assert from "node:assert/strict";
import test from "node:test";

import {
  accountFingerprint,
  calculateDateRange,
  fetchUsageWithAuthRetry,
  mergeArchive,
  normalizeUsageResponse,
  parseArgs,
  renderTable,
} from "./codex_daily_workspace_usage.mjs";

const settledTotals = {
  users: 1,
  threads: 12,
  turns: 34,
  credits: 56.75,
  uncached_text_input_tokens: 100,
  cached_text_input_tokens: 200,
  text_output_tokens: 30,
  text_total_tokens: 330,
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("default range refreshes seven UTC dates including today", () => {
  const options = parseArgs([]);
  assert.deepEqual(
    calculateDateRange(options, new Date("2026-08-21T12:00:00Z")),
    {
      startDate: "2026-08-15",
      endDateExclusive: "2026-08-22",
      today: "2026-08-21",
    },
  );
});

test("explicit CLI ranges are inclusive and converted to an exclusive request boundary", () => {
  const options = parseArgs(["--start", "2026-08-19", "--end", "2026-08-21"]);
  assert.deepEqual(
    calculateDateRange(options, new Date("2026-08-21T12:00:00Z")),
    {
      startDate: "2026-08-19",
      endDateExclusive: "2026-08-22",
      today: "2026-08-21",
    },
  );
});

test("normalization preserves unsettled token counters as null instead of zero", () => {
  const response = normalizeUsageResponse({
    group_by: "day",
    data: [
      {
        date: "2026-08-21",
        totals: { users: 1, threads: 2, turns: 3, credits: 4.5 },
        clients: [{ client_id: "CODEX_CLI", turns: 3, credits: 4.5 }],
      },
    ],
  });
  assert.equal(response.data[0].totals.cached_text_input_tokens, null);
  assert.equal(response.data[0].totals.uncached_text_input_tokens, null);
  assert.equal(response.data[0].clients[0].text_total_tokens, null);
});

test("display marks lagging zero counts as unsettled when credits and tokens exist", () => {
  const response = normalizeUsageResponse({
    group_by: "day",
    data: [
      {
        date: "2026-08-20",
        totals: { ...settledTotals, users: 0, threads: 0, turns: 0 },
        clients: [],
        models: [],
      },
    ],
  });
  assert.match(renderTable(response, "2026-08-21"), /2026-08-20\s+unsettled/);
});

test("archive merge replaces a date instead of appending a duplicate", () => {
  const workspaceFingerprint = accountFingerprint("workspace-a");
  const previous = {
    schema_version: 1,
    workspace_fingerprint: workspaceFingerprint,
    days: [
      {
        date: "2026-08-20",
        totals: { ...settledTotals, credits: 1 },
        clients: [],
        models: [],
        last_observed_at: "2026-08-20T01:00:00Z",
      },
    ],
  };
  const response = normalizeUsageResponse({
    group_by: "day",
    data: [
      {
        date: "2026-08-20",
        totals: settledTotals,
        clients: [],
        models: [],
      },
    ],
  });
  const { archive, changes } = mergeArchive({
    previous,
    response,
    fetchedAt: "2026-08-21T01:00:00Z",
    endpoint: "https://example.test/usage",
    startDate: "2026-08-20",
    endDateExclusive: "2026-08-21",
    workspaceFingerprint,
  });
  assert.equal(archive.days.length, 1);
  assert.equal(archive.days[0].totals.credits, 56.75);
  assert.deepEqual(changes.updated, ["2026-08-20"]);
});

test("HTTP request uses the local Codex bearer/account headers and retries once after 401", async () => {
  const requests = [];
  const authReads = [];
  let refreshed = false;
  const responseBody = {
    group_by: "day",
    data: [
      { date: "2026-08-20", totals: settledTotals, clients: [], models: [] },
    ],
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    return requests.length === 1
      ? jsonResponse(401, { detail: "expired" })
      : jsonResponse(200, responseBody);
  };
  const readAuth = async () => {
    const auth =
      authReads.length === 0
        ? { accessToken: "expired-token", accountId: "account-a" }
        : { accessToken: "fresh-token", accountId: "account-a" };
    authReads.push(auth);
    return auth;
  };

  const result = await fetchUsageWithAuthRetry({
    endpoint: "https://example.test/usage",
    authFile: "/not-read-by-the-fixture",
    startDate: "2026-08-20",
    endDateExclusive: "2026-08-21",
    readAuth,
    refreshAuth: async () => {
      refreshed = true;
    },
    fetchImpl,
  });

  assert.equal(refreshed, true);
  assert.equal(result.refreshedAuth, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.Authorization, "Bearer fresh-token");
  assert.equal(requests[1].headers["ChatGPT-Account-ID"], "account-a");
  const url = new URL(requests[1].url);
  assert.equal(url.searchParams.get("workspace_user"), "true");
  assert.equal(url.searchParams.get("end_date"), "2026-08-21");
});
