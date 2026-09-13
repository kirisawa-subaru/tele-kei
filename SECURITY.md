# Security model

Read this before you run TeleCodex on a machine you care about.

TeleCodex connects a Telegram chat to a Codex process on your computer. A
message in that chat is a prompt, and a prompt can make Codex read files, write
files, and run commands on the host. The security model is therefore not "a bot
with a few commands"; it is "a remote shell with a language model in front of
it, and one ACL".

## The trust boundary is a single list

`TELEGRAM_ALLOWED_USER_IDS` is the only authentication in the system.

- It is mandatory. Startup fails if it is empty (`src/config.ts`).
- It contains numeric Telegram user ids only. No usernames, no wildcards, no
  default-allow, no "anyone in this group" escape hatch.
- Every inbound path checks it: private messages, group messages, callback
  queries, and injected prompts (`src/bot.ts`).
- `TELEGRAM_GROUP_TRIGGER_MODE=all-authorized` is not a bypass. It only changes
  whether an allowlisted user must @-mention the bot; it runs *after* the
  allowlist check.

There is no second factor, no per-command authorization, and no audit prompt.
Anyone on that list can do anything Codex can do on the host.

## What compromise looks like

**Prompt injection is host access.** Codex acts on text. If it reads a file, a
web page, a repository, an email, or a tool result that contains instructions,
those instructions arrive with the same privileges as your own message. There is
no separation between "the user's request" and "content the model happened to
read". This is not a TeleCodex bug; it is the current state of the art for
agentic coding tools. TeleCodex's contribution to the problem is that it makes
the agent reachable from a phone, unattended, with nobody watching the tool
calls.

**Bot token compromise is at minimum total conversational exposure.** Whoever
holds `TELEGRAM_BOT_TOKEN` can poll the same update stream, read every message
you send the bot, read every answer it sends back — including file contents,
diffs, and anything else Codex quoted — and post messages to you as the bot.
They cannot forge the `from.id` of an inbound message, so the allowlist still
stands between them and code execution; but treat a leaked token as a full
disclosure of everything that chat has ever carried, and as a channel for
socially engineering you into running something.

Keep the token in `.telecodex.env` (gitignored) or
`.telecodex/instances/<botKey>/bot.env`, mode `0600`. Do not commit it, do not
paste it into an issue, do not put it in a shell history-visible command.

## Sandbox and approvals

`CODEX_SANDBOX_MODE` defaults to `workspace-write`, the Codex default. It is the
only meaningful containment in the system. Widening it to
`danger-full-access` means one injected instruction can reach anything your user
account can reach — SSH keys, browser profiles, cloud credentials, the rest of
your home directory.

`CODEX_APPROVAL_POLICY` defaults to `never`, and that default is deliberate:
**this bridge has no approval UI.** There is no handler for an approval request
anywhere in the codebase, so any value other than `never` stalls turns rather
than gating them. Do not treat the approval policy as a safety control here.
Tighten `CODEX_SANDBOX_MODE` instead, and give the bot a workspace that does not
contain anything you are unwilling to lose.

## Local IPC has no authentication

TeleCodex uses three Unix domain sockets under `<repo>/.telecodex/run/`:

| Socket | Purpose |
| --- | --- |
| `core.sock` | worker ↔ Core Router |
| `control.sock` | local CLI binds the current Codex thread to Telegram |
| `inject-<botKey>.sock` | queue a prompt into a bot's thread |

None of them authenticate their peers. There is no token, shared secret, or
HMAC on any of these protocols. The only access control is filesystem
permissions: the run directory is created `0700` and each socket is `chmod`ed
to `0600` after bind.

The consequence: **write access to the inject socket is arbitrary code
execution as you.** Any process running as your user can queue a prompt. Do not
relocate `.telecodex/` to a world-writable directory, a network share, or a
cloud-synced folder, and do not run TeleCodex on a host you share with
untrusted local users.

This also means the current design assumes a POSIX filesystem that enforces
socket permissions. Do not port it to a platform where `chmod` on a socket is a
no-op without designing an authentication layer first.

## What TeleCodex deliberately does not do

- No `/sh`, `/exec`, or any command that hands a raw shell to the chat window.
  `child_process` is used in five places, all with fixed argv.
- Dynamic tools (`telegram.send_file`, `telegram.send_interaction`) never let
  the model choose a destination. Core derives the chat/topic/message target
  from the calling thread's durable owner, verifies the owning bot profile
  enables the tool, and the worker rechecks the thread binding before calling
  Telegram.
- Voice and audio are not downloaded or transcribed.
- The `!telegram-active` trigger runs as a local CLI shell command, not a model
  turn, and the skill form refuses to run from a prompt carrying TeleCodex
  transport provenance.

## Reporting

This is a personal-scale project with no security response SLA. If you find
something, open an issue describing the impact without including a working
exploit against a third party's deployment.
