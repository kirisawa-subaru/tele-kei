# Bot profiles

A profile sets the defaults a bot key starts new threads with: which directory
Codex works in, which model, what developer instructions it carries, and which
app-server dynamic tools it may use.

`profiles/<botKey>/profile.json` is loaded by `src/bot-profile.ts` when a bot
with that key starts. The directory name **is** the bot key — the profile in
this directory applies to `./telecodex.worker.start.sh example` and to nothing
else. Copy it to `profiles/main/` (or whatever your bot key is) and edit.

Only `profiles/example/` is tracked. Your own profiles are gitignored, because
`default_workspace` is machine-specific and `SYSTEM.md` tends to accumulate
things you did not mean to publish. Remove the `profiles/*` rule from
`.gitignore` if you want yours in version control.

## `profile.json`

| Field | Type | Meaning |
| --- | --- | --- |
| `default_workspace` | string | Directory Codex operates in. Relative paths resolve against the repository root. **Without it the workspace is this repository**, so the bot can rewrite its own source. |
| `default_model` | string | Model for new threads. Omit to use the Codex default. |
| `system_instructions` | string | Path to a developer-instructions file, relative to this directory. Defaults to `SYSTEM.md` when that file exists. Cannot escape the profile directory. |
| `dynamic_tools` | string[] | App-server tools exposed to newly created threads. Unknown names are a startup error. |

Every field is optional; an empty `{}` is valid. Malformed JSON, an empty
instructions file, or an unsupported tool name fails the bot at startup rather
than being ignored.

## Dynamic tools

| Name | What it does |
| --- | --- |
| `telegram.send_file` | Send a local file to the chat that owns the calling thread. Absolute path plus an optional caption and `document`/`photo` mode. |
| `telegram.send_interaction` | Send an ordered plan of bubbles, a reaction, and one-shot choices (the `telemood.plan.v1` contract). |

The model never chooses a destination. Core derives the chat, topic and message
target from the calling thread's durable owner, checks that this profile enables
the tool, and hands the request to that bot's private worker socket; the worker
rechecks the thread binding before it calls Telegram. Enabling a tool widens
what the bot can *send*, never where it can send it.

Declarations are applied by `thread/start`, so an existing thread keeps the set
it was created with until the next `/new` or scheduled rollover.

## `SYSTEM.md`

Developer instructions, sent with every new thread this bot creates. Keep it to
what changes the bot's behaviour in this workspace: output conventions, which
commands are cheap or expensive, what needs a human go-ahead. It is not a place
for credentials or for anything you would not publish — if you fork this
repository, check what is in here before you push.
