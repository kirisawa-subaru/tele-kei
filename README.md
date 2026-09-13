# TeleCodex

A Telegram chat that is a front end to the [Codex](https://openai.com/codex/)
CLI running on your own computer. Send a message from your phone, a Codex thread
on your desktop picks it up, and the answer comes back in the chat — the same
thread you can attach to from the terminal, and the same session history.

This is a hard fork of [`benedict2310/telecodex`](https://github.com/benedict2310/telecodex)
(MIT), rebuilt around a single shared Codex writer, a process split, and a
durable delivery ledger. See [Relationship to upstream](#relationship-to-upstream).

> **Read [`SECURITY.md`](SECURITY.md) before you run this.** A message in the
> allowlisted chat is a prompt, and a prompt can read files, write files and run
> commands on the host. A single list of numeric Telegram user ids is the only
> authentication in the system.

## What it does

- **One thread across phone and desktop.** `!telegram-active` in a Codex CLI
  session binds that thread to the chat. `/past` catches the phone up on what
  you did at the keyboard.
- **Streams a turn as it happens** — typing indicator, incremental previews,
  reconciled final message, with Telegram's flood control respected instead of
  fought.
- **Survives a restart.** Turn events are journaled before they are emitted;
  final messages go through an outbox, so a crash mid-delivery resumes at the
  first incomplete chunk instead of losing the answer.
- **Several bots, one Core.** Each Telegram token gets its own worker process
  and its own bot profile — workspace, model, developer instructions, and which
  tools it may use.
- **Files, images and block LaTeX** in both directions. Photos sent mid-turn are
  injected into the running turn rather than rejected.
- **Chat commands** for the things you would otherwise need a keyboard for:
  `/new`, `/view`, `/attach`, `/rewind`, `/compact`, `/status`, `/handback`.

## Architecture

```text
Telegram worker main ─┐
Telegram worker ops  ─┼─ core.sock ─ Core Router ─ app-server.sock ─ codex app-server
Telegram worker lab  ─┘                    │
                                     state.sqlite
```

Workers own Telegram tokens, polling and delivery, and never speak to Codex.
Core owns every Codex session, the `(botKey, chat/topic) -> thread` ledger and
the control socket. One app-server is the single writer, which is what lets a
desktop CLI join the same thread without becoming a second one.

[`TELECODEX.md`](TELECODEX.md) is the operational reference.

## Requirements

- macOS or Linux, including WSL2. **Native Windows is not supported** — see
  [`docs/platforms.md`](docs/platforms.md) for why, and for the three WSL2
  details that will otherwise bite you.
- Node 22 or newer. No native compilation.
- The Codex CLI, installed into the checkout by the setup script, and a working
  `codex login` (or an API key).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

## Getting started

The intended audience already runs a coding agent. Open Codex CLI or Claude Code
in this directory and say:

> follow SETUP.md

[`SETUP.md`](SETUP.md) is written for the agent: it probes the host, asks you
for the two credentials it cannot obtain by itself, explains the blast radius of
each before writing it down, and sets the bot's workspace.
[`docs/setup-manifest.json`](docs/setup-manifest.json) is the same thing in
machine-readable form.

Doing it by hand is four commands:

```bash
cp .telecodex.env.example .telecodex.env && chmod 600 .telecodex.env
# fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS
./telecodex.setup.sh
./telecodex.app-server.start.sh   # then, in two more shells:
./telecodex.core.start.sh
./telecodex.worker.start.sh main
```

For long-running installs, [`deploy/`](deploy/README.md) has parameterised
systemd user units and launchd agents.

## Repository layout

| Path | What |
| --- | --- |
| `.vendor/telecodex/` | The TypeScript source. Edit it here; this is the fork's source of truth, not a vendored copy. |
| `telecodex.*.sh` | Setup and the three start targets. All resolve Node and Codex through `telecodex.runtime.sh`. |
| `telecodex-bin/` | `codex` (pinned CLI shim) and `telecodex-remote` (desktop entry to the shared app-server). |
| `telegram-active/` | The Codex CLI trigger that binds the current thread to Telegram. |
| `profiles/example/` | A commented bot profile: workspace, model, developer instructions, dynamic tools. |
| `deploy/` | Supervisor templates for systemd and launchd. |
| `smoke/` | Playwright end-to-end tests that drive Telegram Web against a live bridge. |
| `tools/`, `CODEX_ANALYTICS.md` | Codex usage and rate-limit collectors. |
| `.telecodex/` | Runtime state: sockets, the SQLite ledger, per-bot credentials. Never tracked. |

## Tests

```bash
cd .vendor/telecodex && npm ci && npm run build && npm test
```

359 unit and integration tests. The `smoke/` suite is separate: it needs a
logged-in Telegram Web session and a live bridge, so it is not part of CI.

## Relationship to upstream

TeleCodex began as [`benedict2310/telecodex`](https://github.com/benedict2310/telecodex)
at commit `fd2a2413`. Merging from upstream was abandoned in August 2026; of 41
source files, one is unmodified. It is a fork in the legal and historical sense,
not a patch set — the provenance pointers exist for attribution and archaeology,
not as an update path.

Third-party notices, including the MIT-licensed `telemood.plan.v1` interaction
contract, are in
[`.vendor/telecodex/THIRD_PARTY_NOTICES.md`](.vendor/telecodex/THIRD_PARTY_NOTICES.md).

## License

MIT. See [`LICENSE`](LICENSE) — upstream's notice, unchanged:
`Copyright (c) 2025 Benedict Evert`.

<!-- TODO(maintainer): decide the fork's own copyright line and how it sits
     alongside the upstream notice, then replace this comment with it.
     Unresolved: do not publish before this is answered. -->
