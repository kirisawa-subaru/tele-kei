# Codex daily workspace usage monitor

`tools/codex_daily_workspace_usage.mjs` queries the same private ChatGPT backend
route used by the installed Codex app:

```text
GET https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts
```

It reuses the local `~/.codex/auth.json` ChatGPT login. Tokens and account IDs
are never copied into the archive or printed. The archive stores only a short
SHA-256 account fingerprint so data from two accounts cannot be merged silently.
The production request uses the system `curl` network path; authentication
headers are supplied over stdin, so the bearer token does not appear in process
arguments.

`tools/codex_rate_limit_snapshot.mjs` separately calls the local app-server
method `account/rateLimits/read`. It records the server-provided `usedPercent`,
window duration, and reset timestamp for every limit ID. This percentage is
stored directly; it is not inferred from credits.

## Run

```bash
./codex-analytics.daily.sh
./codex-analytics.sample.sh
```

The default run refreshes the last seven UTC dates, including the current date,
prints credits/threads/turns/cached and uncached tokens, and atomically merges by
date into:

```text
.telecodex/analytics/codex-daily-workspace-usage.json
.telecodex/analytics/codex-rate-limit-history.json
```

Examples:

```bash
# Inspect without writing
./codex-analytics.daily.sh --no-write

# One date
./codex-analytics.daily.sh --date 2026-08-20

# Inclusive range and machine-readable stdout
./codex-analytics.daily.sh --start 2026-08-15 --end 2026-08-20 --json
```

The endpoint's `end_date` is exclusive; the CLI converts its inclusive date
arguments. Current-day token counters can be absent while usage is still being
settled. Missing counters are stored as `null` and shown as `unsettled`, then
replaced on a later rolling refresh. A row is also shown as `unsettled` when it
has credits/tokens but its users, threads, or turns are still zero. The reported
zero is preserved; the label only warns that the counters are internally
inconsistent and may be backfilled. Values are never fabricated.

If the request returns HTTP 401, the collector runs `codex debug models` once to
let the installed Codex CLI refresh its own login, reloads `auth.json`, and
retries. Other HTTP failures stop the run without changing the archive.

The installed schedule samples rate-limit percentages hourly and refreshes
daily usage at 09:15 Asia/Shanghai. Both one-shot scripts also run once when
their LaunchAgents are loaded.

## Source evidence (code only)

- Installed app `26.814.41407`, extracted bundle
  `webview/assets/usage-billing-queries-CKcXKjMY.js`: exact route, query, and
  one-minute refresh behavior.
- Installed Codex CLI `0.147.0`: `codex login status`, `codex debug models`, and
  the local `auth.json` shape.
- OpenAI Codex source: [local ChatGPT auth loading](https://github.com/openai/codex/blob/2151d3a5b78ca93128496b26333bc30187385a5f/codex-rs/tui/src/local_chatgpt_auth.rs#L17-L58)
  and [Bearer/account request headers](https://github.com/openai/codex/blob/2151d3a5b78ca93128496b26333bc30187385a5f/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L45).
- Independent executable implementation and response types:
  [james-6-23/codex2api](https://github.com/james-6-23/codex2api/blob/489a1e474f4007eb220827c70a17c9524491aeca/proxy/usage_wham_daily.go#L15-L172).
- Settlement/backfill fixture:
  [codex2api test](https://github.com/james-6-23/codex2api/blob/489a1e474f4007eb220827c70a17c9524491aeca/proxy/usage_wham_daily_test.go#L9-L63).

No product/API documentation was used to discover or implement this monitor.
