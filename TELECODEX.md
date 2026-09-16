# tele-kei deployment

This repo directly tracks the TeleCodex source used by the deployed bridge at
`.vendor/telecodex/`. That tree is the source authority: edit it directly and
review its source and tests as part of this repository.

This is a hard fork, not a vendored copy. Merging from upstream was abandoned
on 2026-08-21; the provenance pointers below are retained for archaeology only
and are not an update or reconstruction path:

- original upstream remote: `https://github.com/benedict2310/telecodex`
- original base commit: `fd2a24134f0459e15df877bd5c8c7fc7455253fd`

Why this shape:

- keep the deployed bridge source and its history in one repository
- pin the service-side Codex CLI to an explicit frozen snapshot instead of PATH resolution
- let an external process supervisor supervise a stable wrapper script

## Files

- `telecodex-bin/codex` — repo-local shim that always launches the pinned Codex snapshot
- `telecodex-bin/telecodex-remote` — desktop entry: joins the shared app-server as a remote frontend (see "Desktop entry")
- `telecodex.runtime.sh` — sourced by every entrypoint; resolves Node and the pinned Codex without hardcoding a host layout (`docs/platforms.md`)
- `telecodex.pin-codex.sh` — refresh only the frozen Codex snapshot used by services
- `telecodex.setup.sh` — install dependencies, build tracked source, refresh the Codex pin
- `telecodex.app-server.start.sh` — start the single shared Codex writer
- `telecodex.core.start.sh` — start the only process allowed to own Codex sessions
- `telecodex.worker.start.sh <botKey>` — start one Telegram polling/delivery worker per token
- `telecodex.start.sh` — legacy single-process entrypoint; not used by the supported three-process deployment
- `.telecodex.env.example` — env template
- `.vendor/telecodex/` — tracked TeleCodex source; dependencies, build output, and runtime state stay ignored
- `.vendor/codex/` — ignored frozen Codex snapshot used by services
- `.telecodex/state.sqlite` — WAL state ledger, durable turn journal, and Telegram outbox (gitignored)
- `.telecodex/instances/<botKey>/bot.env` — per-bot untracked token/config override
- `telegram-active/` — explicit Codex CLI trigger for handing the current thread to Telegram
- `profiles/<botKey>/` — per-bot workspace, model, developer instructions, dynamic tools (`profiles/example/`)
- `deploy/` — parameterised systemd and launchd templates

## Setup

1. Create the repo-local env file and fill in the Telegram token and the
   allowlist. Read `SECURITY.md` first — the allowlist is the only
   authentication boundary in the system.

   ```bash
   cp .telecodex.env.example .telecodex.env
   chmod 600 .telecodex.env
   ```

   Add any Node/Codex path overrides here before setup; all runtime shell
   entrypoints and CLI wrappers read this file before resolving executables.
   Only `CODEX_APPROVAL_POLICY=never` is supported. Approval interaction must
   be implemented before another policy can be used.

2. Install dependencies, build the tracked source, and refresh the frozen Codex
   snapshot:

   ```bash
   ./telecodex.setup.sh
   ```

   Setup does not clone, fetch, check out, or replay patches. Source changes go
   directly into `.vendor/telecodex/`; build output is reproducible and remains
   untracked.

   Block LaTeX rendering also requires `rsvg-convert` (librsvg) on the host.
   TeleCodex uses MathJax to collect `$$...$$`, `\[...\]`, and fenced `latex`
   blocks from each final answer, then appends one 1x white-background PNG
   containing every block formula. The Telegram text keeps the original TeX;
   inline TeX is never added to the image. A render failure is logged and does
   not block text delivery. Override the converter path with
   `RSVG_CONVERT_PATH` when it is not installed in the standard Homebrew path.

   The setup step also installs the stable Codex CLI (pinned at `0.153.4`) into
   `.vendor/codex/`, from npm by default. The supervised services never resolve
   `codex` from a mutable PATH; every entrypoint prepends `telecodex-bin/`, so a
   background upgrade of a globally installed CLI cannot change the protocol the
   bridge speaks. Two alternatives to the download:
   `TELECODEX_PINNED_CODEX_SOURCE_PACKAGE` copies an existing local install, and
   `TELECODEX_CODEX_BIN` skips the pin entirely — put that one in
   `.telecodex.env` so every process sees it.

   The `/rewind` implementation uses deprecated `thread/rollback`. Codex
   0.153.4 creates paginated threads by default, which reject that method, so
   the bridge explicitly requests `historyMode: "legacy"` for new threads.
   The successor is `thread/revert({threadId, beforeTurnId})` for paginated
   durable threads; it returns an empty `thread.turns` and requires
   `thread/turns/list` to hydrate history. Supporting it needs a separate
   pagination-aware change, including for Desktop-created threads attached
   to the bot. Re-verify these contracts before future Codex re-pins.

   Upgrade verification on 2026-09-07: 0.153.4 completed a real end-to-end
   turn. Durable scratch threads passed namespaced dynamic-tool calls,
   two-turn rollback and readback, unsubscribe/resume with the model and
   tools retained, compaction, and archive-cycle writer release. The existing
   rate-limit parser still read the weekly window. Context usage remained
   `last.totalTokens` (16181 before compact, 526 afterward), while cumulative
   `total.totalTokens` stayed 80589.

   To refresh only the frozen Codex binary without installing or building the
   tracked TeleCodex source, run:

   ```bash
   ./telecodex.pin-codex.sh
   ```

3. Start the shared app-server, Core Router, then a Telegram worker:

   ```bash
   ./telecodex.app-server.start.sh
   ./telecodex.core.start.sh
   ./telecodex.worker.start.sh main
   ```

4. A computer-side Codex CLI can join the same server without acquiring a
   second writer:

   ```bash
   ./telecodex-bin/codex --remote "unix://$PWD/.telecodex/run/app-server.sock"
   ```

   The everyday entry for this is `telecodex-remote` (see "Desktop entry").

## Desktop entry (`telecodex-remote`)

The installation agent follows [SETUP.md](SETUP.md) to configure a `tele-kei`
shortcut around this entry with native tmux. The bot remains supervised in the
background; the shortcut opens or reattaches the CLI when needed. Detaching
tmux leaves both the CLI session and the bot running. A host reboot ends the
tmux process; start a new CLI and select the saved Codex conversation afterward.

`telecodex-bin/telecodex-remote` is the desktop-side counterpart of the
Telegram bridge: a frontend to the shared app-server, symlinked onto PATH. It
pins the frozen Codex snapshot and the remote socket, so no path, socket, or
thread UUID needs to be typed:

```bash
telecodex-remote resume          # official picker over the shared store; search any session
telecodex-remote resume --last   # continue the most recent session, no picker
telecodex-remote resume --all    # include sessions outside the canonical workspace
telecodex-remote                 # new session in the canonical workspace
```

Facts this relies on (rechecked 2026-09-07 on pinned 0.153.4; original probe:
`docs/20260823-remote-resume-picker-probe.md`; re-verify after re-pinning):
the resume picker works in `--remote` mode and lists the shared
`~/.codex` store, so phone-side threads are selectable by search. In the
picker, the footer labels Esc as new; Ctrl-C was verified to exit cleanly.

Opening a session with `telecodex-remote` does not rebind Telegram; the bridge keeps
streaming only turns it submitted, and `/past` catches the phone up on
desktop-side messages. Use `!telegram-active` inside the session when the
phone should follow it.

## Auth

TeleCodex can use your existing local Codex login.

Current host status can be checked with:

```bash
./telecodex-bin/codex login status
```

`CODEX_API_KEY` is optional and only needed if you want API-key auth instead of
the existing `codex login` session.

## Core Router and bot workers

Production uses three process roles:

```text
Telegram worker main ─┐
Telegram worker work ─┼─ .telecodex/run/core.sock ─ Core Router ─ app-server.sock
Telegram worker lab  ─┘                         │
                                         state.sqlite
```

Workers own Telegram tokens, polling, group-addressing policy, attachments,
and actual Telegram API calls. They never connect to the Codex app-server.
Core owns every `CodexSessionService`, direct/Desktop-relay selection, the
control socket, and the global `(botKey, chat/topic) -> thread` ledger.

The database enforces one writer address per Codex thread. A reply route to an
already-bound thread reuses the same Core session rather than creating a
second app-server frontend. Turn events are journaled before they are emitted
to a worker. Final Telegram chunks are written to the outbox before the first
send/edit; a worker restart resumes at the first incomplete chunk. Delivery is
therefore at-least-once: Telegram has no idempotency key for `sendMessage`, so
a process death after Telegram accepts a send but before the message id is
committed can still create one duplicate, but it must not silently lose the
final answer. Outbox mutations retry transient SQLite writer contention, and a
rejected final-projection promise is cleared so the prompt completion path can
stage the response again instead of permanently caching the first failure.

The full Telegram address is `(botKey, chatId, topicId?)`. `topicId` is used
only for real forum topics; an incidental `message_thread_id` in a private chat
does not split continuity. Group messages default to command, mention, or
reply-to-bot addressing. Set `TELEGRAM_GROUP_TRIGGER_MODE=all-authorized` for
a private group where every allowed-user message should enter the bound
thread. Unauthorized group traffic is ignored silently.

Bot profiles may expose fixed app-server dynamic tools to newly created
threads with `dynamic_tools`. The supported `telegram.send_file` tool accepts
only an absolute local path plus an optional caption/mode. Core derives the
destination from the calling thread's durable owner, verifies that the owning
bot profile enables the tool, and forwards the request to that bot's private
worker socket. The worker then rechecks the active thread/context binding and
uses its own Telegram token. Existing threads are unchanged; the declaration
is applied by `thread/start` on the next `/new` or scheduled rollover.

A profile may also expose `telegram.send_interaction`, a TypeScript host
implementation of the MIT-licensed
[`telemood.plan.v1`](https://github.com/beniedev/telemood) contract. Codex may
send an ordered plan containing bubbles, a reaction on the triggering message,
and one-shot choices. Core supplies trusted chat/topic/message/user provenance;
model arguments cannot choose a destination or callback recipient. The worker
executes actions in plan order and stops on the first non-verified receipt.
Choice callbacks are staged in `.telecodex/state.sqlite`, activated only after
Telegram accepts the keyboard, expire after 30 minutes, and use a durable
claim before becoming one-shot only when Core accepts the selected value.
A completed interaction with visible output
suppresses the ordinary final projection so Telegram does not receive a second
copy or a stray `✅ Done`. Sticker actions remain disabled until a bot-scoped
trusted sticker catalog exists.

Additional bots use an explicit lowercase key and an untracked env file:

```text
.telecodex/instances/work/bot.env
```

At minimum it contains `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_USER_IDS`. The worker holds a token-fingerprint process lease
and refuses to start if another live worker owns the same token.

## Process supervision

Supervise the app-server, Core Router, and each worker separately. The
app-server starts first; Core must be reachable before a worker starts. Three
long-lived units, all running from the repo root:

```text
<repo>/telecodex.app-server.start.sh        # the single shared Codex writer
<repo>/telecodex.core.start.sh              # Core Router
<repo>/telecodex.worker.start.sh main       # one unit per bot key
```

Any supervisor works. `deploy/` ships parameterised templates for both — three
launchd agents on macOS, three systemd user units on Linux and WSL2 — plus
`deploy/render.sh`, which substitutes this checkout's path and prints the
install commands without running them. `deploy/README.md` covers lingering,
WSL2's `[boot] systemd=true` requirement, and the restart semantics.

A supervisor's own `status` verb can lag. Ask the platform for liveness
instead:

```bash
# macOS
launchctl print "gui/$(id -u)/<your-label-prefix>.app-server"
# Linux
systemctl --user status telecodex-app-server
```

### Keep one Node across setup and runtime

Every entrypoint resolves Node through `telecodex.runtime.sh`, so setup and the
services agree by construction; `docs/platforms.md` documents the search order
and the `TELECODEX_NODE_*` overrides. This matters because of native addons.

History (2026-08-29): the scripts used to prepend a fixed PATH with a Homebrew
directory ahead of the intended pin, so the pin was dead and the services
silently ran a different Node for months. A deploy then rebuilt
`better-sqlite3` for the intended version and broke the live bridge. Any
`npm install` / `npm ci` / `npm rebuild` run under a different Node than the
services use recompiles native addons for the wrong NODE_MODULE_VERSION.
(`better-sqlite3` now ships prebuilt binaries for every supported platform, so
this is a smaller trap than it was, but it is still a trap.)

`codex-state.ts` logs a database open failure once to
stderr and keeps compatibility callers on their existing empty/null fallback;
the explicit `/view` and `/attach` commands use checked queries and reply
`会话列表暂不可用，请稍后重试。` when the database is unavailable, rather than
presenting the failure as a legitimate empty list or unknown thread. No message
is pushed unless the user invokes one of those commands.
After touching `.vendor/telecodex/node_modules` in any way, rebuild and
verify under the pinned runtime before restarting the services:

```bash
# Resolve the same Node the services will use, then stay on it.
eval "$(bash -c 'TELECODEX_ROOT=$PWD . ./telecodex.runtime.sh; telecodex_prepare_runtime; \
  printf "PATH=%q\n" "$PATH"')"
cd .vendor/telecodex && npm rebuild better-sqlite3 && npm run build
node --input-type=module -e \
  'const m = await import("./dist/codex-state.js"); console.log(m.listThreads(3).length);' \
  # must print > 0 once the host has Codex history
```

## Make the current CLI thread active on Telegram

From the Codex CLI conversation that should receive future Telegram messages,
run the local shell trigger:

```text
!telegram-active
```

Codex CLI executes `!` commands locally under the current permission profile,
so this path does not ask the model to interpret a Telegram-visible command.
The installed client reads the CLI-provided
`CODEX_THREAD_ID` and asks the live bridge to bind the most recently used
Telegram context to that thread. No UUID copy, bridge restart, or direct edit
of `.telecodex/contexts.json` is required. To target a known Telegram topic
instead, the client also accepts `--context <chat-or-topic-key>`.

`$telegram-active` remains available as an explicit-only skill for convenience,
but it is model-mediated and therefore is not the injection-resistant control
boundary. Its instructions reject requests carrying TeleCodex provenance.

The bridge exposes the bind operation only through
`.telecodex/run/control.sock`, a local Unix socket created with mode `0600`.
It refuses to replace a different Telegram thread while that thread still has
an active turn.

When `thread/resume` reports that Codex Desktop already owns the requested
thread, `telegram-active` now passes Desktop's local app-tools capability to
the bridge and the binding automatically enters `desktop-relay` mode. Telegram
text is then submitted through the existing Desktop writer; TeleCodex waits on
that same thread and projects its final assistant message back to Telegram.
The relay cursor is captured before submission, and an unconfirmed submission
is never replayed automatically. If the Desktop capability disappears before a
message is submitted, TeleCodex first retries a normal direct attach.

Desktop relay deliberately ships as a final-answer compatibility path. It does
not currently expose token streaming, tool-progress projection, inline Abort,
`/compact`, `/rewind`, or structured `/skill` invocation. `/status` reports
`Route: Desktop relay` while the compatibility path is active.

## Bind an automation alert for Telegram follow-up

An external alerting client can use the same control socket when
`CODEX_THREAD_ID` is available. After Telegram accepts the alert,
the client registers its `message_id`, Telegram context, and originating Codex
thread. A direct reply to that alert opens a separate lazy app-server session
for the routed thread, so an active conversational turn in the same chat is
neither replaced nor interrupted. The client should exit nonzero on
registration failure even when Telegram already accepted the notification.

The inbound Codex prompt contains only the user's reply text after
leading/trailing whitespace is trimmed. The alert text, automation id, cwd, and
a synthetic “automation follow-up” wrapper are not prepended. Source metadata
stays out of the text and travels in app-server `additionalContext` under
`telecodex.transport`, with a `telegram:<botKey>:<chat>:<message>` client
message id for deduplication.

## Notes

- The configured Telegram token must have only one polling consumer. Any other
  process polling the same token must be stopped first.
- TeleCodex uses this repo root as its workspace by default, so Codex sees this
  repository directly. Point it elsewhere with a bot profile.
- The shared app-server inherits whatever sandbox and approval policy it was
  started with. The Telegram bridge does not override the shared thread's
  policy on each turn, so the app-server's own settings are the effective
  ceiling for everything that arrives from Telegram. See `SECURITY.md`.
- Legacy `.telecodex/contexts.json` and `reply-routes.json` are transactionally
  imported into `.telecodex/state.sqlite` under the primary bot key on the
  first Core start. Workers never write the legacy JSON files.
- The local CLI control socket can atomically rebind the most recently active
  Telegram context to the invoking Codex thread. A successful rebind clears
  the old thread's `/past` watermark while a same-thread rebind preserves it.
- An active Desktop writer is treated as a routing signal on bind, switch,
  resume, and ordinary cold Telegram prompts. TeleCodex resolves the exact
  holder of `~/.codex/thread-writer-locks/<thread-id>.lock`; it enters Desktop
  relay only when that PID is Desktop's bundled app-server and the matching
  app-tools socket reports the exact target as `idle` or `active`. CLI and the
  shared TeleCodex app-server fail closed instead of being misrouted. The bridge
  keeps its normal Node runtime and asks its signed app-server to launch a
  short-lived helper with Desktop's bundled CUA Node for each relay operation;
  this satisfies the capability socket's process-lineage check without forcing
  TeleCodex's native dependencies into Desktop's code-signing restrictions.
- `/handback` has stronger semantics than an ordinary unsubscribe. Pinned Codex
  `0.147.0` keeps an unsubscribed resident thread loaded and retains the writer
  lock. For a direct app-server binding, TeleCodex therefore calls
  `thread/archive` followed immediately by `thread/unarchive`, verifies the
  same thread id is absent from `thread/loaded/list`, and only then clears the
  Telegram binding. The restored thread is `notLoaded`, so Codex Desktop or a
  separate CLI app-server can resume it immediately. A Desktop-relay binding
  already belongs to Desktop and only drops the Telegram projection. Any
  release failure leaves the local binding intact and is reported as failure.
- Text sent while a turn is running is injected with `turn/steer`; idle text
  starts a turn. After 60 idle minutes the bridge unsubscribes and lazily
  resumes its subscription on the next message. Unsubscribe alone is not a
  cross-process writer handoff and must never be described as one.
- `/new` always creates the phone-side thread in this deployment's configured
  canonical workspace. Historical thread worktrees and clone paths are not
  offered as phone picker targets.
- `/past` cold-reads completed desktop messages after the last successfully sent
  watermark and sends the latest five messages in full. Telegram-sized chunks
  are split as plain text without resuming the thread or truncating content.
- `/view` keeps its compact switcher labels; the per-page `显示` button sends
  timestamp, full folder path, name, and full latest input for the six sessions
  visible on that page. Its database query is a whitelist: `source` must be
  `vscode` or `cli`, while `thread_source` must be `user`, `automation`, or
  legacy `NULL`; exec workers and subagents never enter the phone list.
- `/status` reads `account/rateLimits/read` on demand and identifies the weekly
  and optional five-hour windows by `windowDurationMins`, not by whether Codex
  labels a window `primary` or `secondary`. Current context occupancy is the
  latest `thread/tokenUsage/updated` notification's
  `tokenUsage.last.totalTokens`; `tokenUsage.total.totalTokens` is the thread's
  lifetime cumulative model usage and can exceed `modelContextWindow`.
  `cachedInputTokens` is already a subset of input and must not be added again.
  Scratch verification against pinned Codex `0.147.0` separated the fields over
  three turns: cumulative total grew `6897 -> 14292 -> 22385`, while last tracked
  each call at `6897 -> 7395 -> 8093`; compact left cumulative total at `30703`
  but recomputed last from `8318` down to `6469` (with the last breakdown fields
  zeroed). The bridge therefore caches `last.totalTokens` verbatim for the
  thread. After a bridge restart, before the first observed usage event, or
  while that Telegram session is unsubscribed it reports an honest unavailable
  value instead of a potentially stale cache entry. Re-verify both protocol
  shapes whenever the pinned Codex snapshot moves off `0.147.0`.
- Typing communicates activity until at least 100 Unicode characters are
  buffered. Streaming previews then update only after another 100 characters;
  turn completion reconciles any suffix present only in the app-server's
  completed item, and the final edit is serialized after any in-flight preview
  edit. Telegram-requested flood-control delays up to 60 seconds are honored
  instead of being rejected by the retry ceiling. Tool summaries and token
  footers are hidden by default for the companion-chat deployment.
- Telegram prompts carry transport provenance through app-server
  `additionalContext` plus a `telegram:<chat>:<message>` client message id.
  Direct CLI input has neither marker, so shared-thread consumers can distinguish
  the two sources without inserting labels into the user's message text. The
  bridge advertises the app-server `experimentalApi` capability because
  `additionalContext` is capability-gated.
- Photo and document downloads use the same Telegram API root and proxy as
  grammY API calls; file downloads must not bypass the configured route with a
  bare global `fetch`. Voice and audio inputs are not downloaded or transcribed;
  the bridge replies `语音未启用，请发送文字。`.
- Photos sent while a turn is active are downloaded and injected with
  `turn/steer` as `localImage` input. They are not rejected by the bridge's
  ordinary busy guard.
