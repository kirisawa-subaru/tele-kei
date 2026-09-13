# TeleCodex

TeleCodex is a Telegram bridge for the OpenAI Codex CLI SDK. It keeps a Codex thread alive from your phone, streams agent responses and tool output in real time, and lets you hand the thread back to the CLI whenever you want.

## Features

- **Per-context sessions** — each Telegram chat or forum topic gets its own independent Codex session with separate thread, model, and busy state
- **Streaming responses** — agent text edits in-place as Codex generates it
- **Full tool visibility** — shell commands, file changes, web searches, MCP calls, and error items shown with configurable verbosity
- **Live plan display** — Codex's todo list rendered as a separate message and updated as steps complete
- **Image input** — send a photo (with optional caption) to pass screenshots or images directly to Codex
- **File ingest & artifacts** — send a document to stage it for Codex; generated files are delivered back as Telegram documents
- **Filtered thread browser** — `/view` lists interactive and automation threads while hiding exec workers and subagents
- **Model picker** — `/model` shows available models and lets you switch for new threads
- **Optional message reactions** — 👀 while processing, 👍 on success when enabled; silently degrades in chats without reaction support
- **Friendly errors** — common SDK and network errors are translated to actionable messages with command hints
- **Read-only status** — `/status` shows the current thread, workspace, model, and host auth state
- **Verified handback flow** — `/handback` releases the writer for Codex Desktop or CLI, then prints a ready-to-run `codex resume <id>` command (copied to clipboard on macOS)
- **User allowlist** — only configured Telegram user IDs can interact with the bot
- **Docker-friendly** — workspace auto-detected (`/workspace` in containers, `cwd` otherwise)

## Prerequisites

- Node.js 22+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The Codex CLI installed and authenticated on the host:
  - API key auth: set `CODEX_API_KEY`
  - ChatGPT login: `codex login` on the machine

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`:

   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs |
   | `CODEX_API_KEY` | — | API key for Codex (alternative to ChatGPT login) |
   | `CODEX_MODEL` | — | Default model, e.g. `gpt-5.4`, `o3` |
   | `CODEX_SANDBOX_MODE` | — | `read-only`, `workspace-write` *(default)*, `danger-full-access` |
   | `CODEX_APPROVAL_POLICY` | — | `never` *(default)*, `on-request`, `on-failure`, `untrusted` |
   | `TOOL_VERBOSITY` | — | `all`, `summary` *(default)*, `errors-only`, `none` |
   | `SHOW_TURN_TOKEN_USAGE` | — | Show the per-turn `in/cached/out` footer in final replies (`false` by default) |
   | `MAX_FILE_SIZE` | — | Max upload size in bytes (default `20971520` = 20 MB) |
   | `ENABLE_TELEGRAM_REACTIONS` | — | Enable Telegram emoji reactions like 👀 / 👍 (`false` by default) |

4. Start the bot:
   ```bash
   npm run dev
   ```

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome & status (concise for returning users) |
| `/help` | Command reference |
| `/new` | Start a fresh thread |
| `/status` | Current thread details and read-only host auth status |
| `/view` | Browse interactive and automation threads; tap to switch |
| `/switch <id>` | Switch directly to a thread by ID |
| `/rewind [n]` | Undo the last n rounds (default 1) |
| `/skill` | Choose a skill for the next message |
| `/compact` | Compact the current thread |
| `/model` | View and change the model |
| `/handback` | Release the writer for Desktop/CLI and print `codex resume <id>` |
| `/attach <id>` | Bind an existing Codex thread to this forum topic |

### Voice, image & file input

- **Voice / audio** — unsupported; TeleCodex replies `语音未启用，请发送文字。`
- **Photos** — send a photo with an optional caption; the image is forwarded to Codex as visual input
- **Documents** — send a file (with optional caption); TeleCodex stages it in the workspace, runs Codex, and delivers any generated files back as Telegram documents

### Tool verbosity

| Mode | What you see |
|---|---|
| `all` | Every tool start, streaming output, and result |
| `summary` *(default)* | A short grouped footer such as `Tools used: 3x bash, 2x subagents, web_fetch` |
| `errors-only` | Only failed tool calls |
| `none` | Silent |

Per-turn token usage is hidden by default. Set `SHOW_TURN_TOKEN_USAGE=true` if you want the `in / cached / out` footer appended to final replies.

## Multi-Session Architecture

Each Telegram chat or forum topic is identified by a **context key** — the chat ID alone for private chats, or `chatId:threadId` for forum topics. This means every topic in a supergroup gets its own independent Codex session.

The `SessionRegistry` maps context keys to `CodexSessionService` instances:

```
┌───────────────────┐      ┌───────────────────────────────┐
│ Private Chat A     │─────▶│ CodexSessionService (thread X) │
│ key: "111"         │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 1  │─────▶│ CodexSessionService (thread Y) │
│ key: "222:1"       │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 2  │─────▶│ CodexSessionService (thread Z) │
│ key: "222:2"       │      └───────────────────────────────┘
└───────────────────┘
```

- **First message** in a context → creates a new `CodexSessionService` → starts a new Codex thread
- **Subsequent messages** → same context key → same session → conversation continues
- **`/new`** → replaces the thread within the same context
- **`/view`** → lists whitelisted interactive and automation threads from `~/.codex`, lets you switch within the current context
- **`/attach <id>`** → resumes a specific Codex CLI thread (useful for picking up work started in the terminal)

Session metadata (thread ID, workspace, model) is persisted to `.telecodex/contexts.json` and restored on restart so threads survive bot reboots.

Each context has independent busy-state tracking, so a running prompt in one topic doesn't block another.

## Handoff: Telegram → Desktop or CLI

1. Run `/handback` in Telegram
2. TeleCodex waits until the shared app-server has released the thread writer
3. Open the same task in Codex Desktop, or use the command TeleCodex replies with:
   ```bash
   cd '/path/to/project' && codex resume 'thread-abc123'
   ```
4. Paste and run it in your terminal when using the CLI

On macOS the command is also copied to the clipboard automatically.

For app-server threads, an unsubscribe is not enough to release the writer.
TeleCodex archive-cycles the idle thread, immediately restores the same thread
ID as `notLoaded`, and verifies it is absent from `thread/loaded/list` before it
clears the Telegram binding or reports success.

## Architecture

```
Telegram ←→ Grammy bot (auto-retry, HTML formatting, inline keyboards)
                |
                v
        SessionRegistry  ──→  per-context CodexSessionService instances
                |
                ├── @openai/codex-sdk  ──→  spawns Codex CLI subprocess
                │     └── ThreadEvents (agent text, commands, file changes,
                │                       MCP calls, web searches, todo lists,
                │                       reasoning, errors, token usage)
                ├── CodexStateReader  ──→  ~/.codex/state_*.sqlite  (threads)
                │                    ──→  ~/.codex/models_cache.json (models)
                ├── CodexAuth        ──→  read-only codex login status
                ├── Attachments      ──→  .telecodex/inbox/<turnId>/ (staged files)
                └── Artifacts        ──→  .telecodex/outbox/<turnId>/ (generated files)
```

## Project Layout

```
TeleCodex/
├── src/
│   ├── index.ts           — startup, signal handling, polling loop
│   ├── bot.ts             — Telegram bot, all commands and handlers
│   ├── bot-ui.ts          — pure render helpers (/help, /start, session labels)
│   ├── codex-session.ts   — CodexSessionService wrapping the SDK
│   ├── codex-state.ts     — SQLite reader for thread/model discovery
│   ├── codex-auth.ts      — read-only Codex CLI login status
│   ├── session-registry.ts — per-context session map with persistence
│   ├── context-key.ts     — Telegram chat/topic → context key derivation
│   ├── attachments.ts     — file staging (sanitization, size limits)
│   ├── artifacts.ts       — generated file collection and Telegram delivery
│   ├── error-messages.ts  — SDK/network error → user-friendly translation
│   ├── config.ts          — environment loading and validation
│   └── format.ts          — Markdown → Telegram HTML conversion
├── test/                  — vitest suite
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
└── vitest.config.ts
```

## Docker

```bash
docker compose up --build
```

The compose file:
- loads environment from `.env`
- mounts `~/.codex` for auth state and persisted threads
- mounts `./workspace` as `/workspace`
- runs as a non-root user

## Development

```bash
npm run dev      # run with tsx (no build step)
npm run build    # compile TypeScript
npm test         # run vitest
```

## Release Automation

TeleCodex does not yet use the TelePi npm release pipeline, but the exact Trusted Publishing process has been documented so it can be adopted here.

See:
- `docs/npm-trusted-publishing.md`

That playbook covers:
- making the package publishable on npm
- adding a tag-driven GitHub Actions workflow
- configuring npm Trusted Publishing
- the maintainer release flow (`npm version ...` + `git push --follow-tags`)

## Security Notes

- Only users in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot
- Default sandbox mode is `workspace-write` — Codex can read and write within the working directory
- Use `danger-full-access` only if you fully trust the user and the host environment
- Default approval policy is `never` — suited for headless/automated use
- Authentication is managed on the host; Telegram exposes only read-only status on `/status`
- Files uploaded via Telegram are sanitized (name, size, type) before staging in the workspace
- All Markdown output is sanitized before being sent as Telegram HTML
