# Setup — instructions for an agent

This file is written for a coding agent (Codex CLI, Claude Code, or similar)
running on the machine that will host the bridge, with the human who owns that
machine present in the conversation. If you are a human reading this: open your
agent in this directory and say *"follow SETUP.md"*. You can also just do it
yourself — every step below is a command.

The machine-readable version of the same thing is
[`docs/setup-manifest.json`](docs/setup-manifest.json). Prefer it for the
probes, the environment keys and the validation patterns; prefer this file for
the judgement calls.

---

## 0. Before anything else

Read [`SECURITY.md`](SECURITY.md) and make sure the human has read the first two
sections. Do not treat this as boilerplate. What is being installed is a
Telegram chat that can read, write and execute on this machine, with a single
numeric allowlist as the only authentication. If the human has not understood
that sentence, stop and explain it before you install anything.

Two rules for you specifically:

- **Never echo the bot token.** Not into the transcript, not into a log, not
  into a `git diff` you show back. Write it to the env file and confirm only
  that you wrote it.
- **Never commit `.telecodex.env`, `.telecodex/`, or anything under
  `.vendor/codex/`.** They are gitignored; keep it that way.

## 1. Check the platform

```bash
uname -s -m
```

macOS and Linux are supported; WSL2 counts as Linux. Native Windows is not
supported — see [`docs/platforms.md`](docs/platforms.md).

If this is WSL2 (`/proc/sys/kernel/osrelease` contains `microsoft`), check where
the checkout is:

```bash
pwd
```

If it is under `/mnt/<drive>/`, **stop**. Move the checkout to the Linux
filesystem (`~/telecodex-oss`) and start again. DrvFs does not enforce the
socket permission bits that are this system's only access control. The start
scripts will refuse to run there anyway.

## 2. Probe the runtime

```bash
bash -c 'TELECODEX_ROOT=$PWD . ./telecodex.runtime.sh; telecodex_prepare_runtime; \
  echo "node: $TELECODEX_NODE_BIN ($("$TELECODEX_NODE_BIN" --version))"'
```

This resolves Node the same way every entrypoint does: explicit override, then
the version in `.nvmrc` across the common version managers, then PATH. If it
fails, install Node 22 or newer by whatever means this machine prefers, or point
`TELECODEX_NODE_BIN` at an existing one. Do not edit any script to add a path.

Optional, and worth reporting to the human rather than fixing silently:

```bash
command -v rsvg-convert || echo "no LaTeX image rendering (optional)"
command -v lsof         || echo "no lsof; socket liveness falls back to a connect probe (fine)"
```

## 3. Ask for the Telegram credentials

You need two values, and you cannot obtain either of them yourself.

**Bot token.** The human creates a bot by messaging
[@BotFather](https://t.me/BotFather) with `/newbot`. The token looks like
`1234567890:AA...`. Ask them to paste it. Treat it as a secret from the moment
it arrives.

**Allowed user id.** The *numeric Telegram user id* of every person allowed to
use the bot — not a username, and usually just the human in front of you. They
can get it by messaging [@userinfobot](https://t.me/userinfobot), or by starting
the bridge later and reading the rejection line from the log.

Before writing them down, say this back to the human in your own words: anyone
on that list gets to run commands on this machine through the bot, and a
mistyped digit could mean a stranger's id is on it.

## 4. Write the env file

```bash
cp .telecodex.env.example .telecodex.env
chmod 600 .telecodex.env
```

Then fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS`. The env file
uses shell assignment syntax; quote values containing spaces. It loads before
runtime discovery in setup, service scripts, and the CLI wrappers. For workers,
root settings load first and the instance env overrides them; additional bots
need their own credentials. See [`docs/platforms.md`](docs/platforms.md).

Every other key in the template has a working default and a comment explaining its blast
radius; change one only if the human asks.

Two you should *not* quietly widen:

- `CODEX_SANDBOX_MODE` — `workspace-write` is the default and the only
  meaningful containment in the system.
- `CODEX_APPROVAL_POLICY` — only `never` is supported. There is no approval
  interaction in the bridge; other values are rejected at startup.

Verify without printing secrets:

```bash
grep -c '^TELEGRAM_BOT_TOKEN=' .telecodex.env
grep '^TELEGRAM_ALLOWED_USER_IDS=' .telecodex.env
```

## 5. Choose the workspace

By default Codex's workspace is this repository, so the bot can read and write
its own source. That is rarely what anyone wants. Ask the human which directory
the bot should work in, and set it with a bot profile:

```bash
mkdir -p profiles/main
cat > profiles/main/profile.json <<'JSON'
{
  "default_workspace": "/absolute/path/they/named"
}
JSON
```

`profiles/example/` is a complete, commented example. The directory name must
equal the bot key (`main` unless they chose otherwise).

## 6. Install

```bash
./telecodex.setup.sh
```

This installs dependencies, builds the TypeScript source, and installs the
pinned Codex CLI into `.vendor/codex/` from npm. It needs network. If the
machine already has the exact pinned version installed elsewhere, either of
these avoids the download:

```bash
TELECODEX_PINNED_CODEX_SOURCE_PACKAGE=/path/to/node_modules/@openai/codex ./telecodex.setup.sh
TELECODEX_CODEX_BIN=/path/to/codex ./telecodex.setup.sh   # skip the pin entirely
```

If you used `TELECODEX_CODEX_BIN`, put it in `.telecodex.env` too, or the
services will look for a pin that does not exist.

Confirm:

```bash
./telecodex-bin/codex --version
```

## 7. Confirm the Codex login

```bash
./telecodex-bin/codex login status
```

If it reports no session, the human runs `codex login` themselves — it opens a
browser and you should not drive it. `CODEX_API_KEY` in `.telecodex.env` is the
alternative for API-key auth.

## 8. Start it, in this order

```bash
./telecodex.app-server.start.sh   # the single shared Codex writer
./telecodex.core.start.sh         # Core Router; needs the app-server
./telecodex.worker.start.sh main  # one per bot key; needs Core
```

Three separate long-lived processes — three terminals, three tmux panes, or a
supervisor. Order matters on first start.

Ask the human to message the bot. A reply means it works. Silence with a line in
the worker log about an unauthorised user means the id in
`TELEGRAM_ALLOWED_USER_IDS` is wrong.

## 9. Offer supervision, do not assume it

Only once the manual start has worked:

```bash
./deploy/render.sh --bot-key main
```

It prints the install commands for systemd user units (Linux, WSL2) or launchd
agents (macOS); it does not run them. On WSL2 remind the human that systemd
needs `[boot] systemd=true` in `/etc/wsl.conf`.

## 10. Hand back

Tell the human, briefly:

- where the token lives and that it is mode `0600` and gitignored;
- which workspace the bot can write to;
- that the sandbox is `workspace-write` and what that does and does not contain;
- how to stop it.

Then read [`TELECODEX.md`](TELECODEX.md) yourself before answering questions
about `/new`, `/past`, `/view`, `/status`, bot profiles, dynamic tools, or the
`telegram-active` binding trigger. It is the operational reference and it is
long on purpose.

---

## Things not to do

- Do not run `npm install -g` anything. The Codex pin installs into a private
  prefix inside the repository.
- Do not edit the start scripts to add a Node or Codex path. Use
  `TELECODEX_NODE_BIN` / `TELECODEX_CODEX_BIN`, in `.telecodex.env`.
- Do not set `CODEX_SANDBOX_MODE=danger-full-access` because something was
  blocked. Move the workspace instead, or ask.
- Do not start a second worker against the same token. Telegram allows one
  polling consumer; the second one will hold a lease conflict and exit.
- Do not put `.telecodex/` on a network share, a cloud-synced folder, or a
  Windows drive mount.
