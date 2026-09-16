# Platform support

TeleCodex runs on **macOS** and **Linux**, including **WSL2**. Native Windows is
not supported and is not on the near-term roadmap; the reason is in
[Why not native Windows](#why-not-native-windows).

| | Status |
| --- | --- |
| macOS (Apple Silicon, Intel) | supported |
| Linux x64 / arm64 | supported |
| WSL2 (Ubuntu and friends) | supported, on the Linux filesystem — see below |
| Native Windows (PowerShell, cmd, MSYS) | not supported |

## What the host has to provide

| Requirement | Notes |
| --- | --- |
| Node >= 22 | `.nvmrc` names the version this deployment is pinned to. Anything 22+ works; see [runtime resolution](#runtime-resolution). |
| npm | Ships with Node. Used by `telecodex.setup.sh` and by the Codex pin. |
| The Codex CLI | Installed into the checkout by `./telecodex.pin-codex.sh`, or supplied with `TELECODEX_CODEX_BIN`. |
| A Codex login | `codex login status`. TeleCodex reuses your existing `~/.codex` session; `CODEX_API_KEY` is the alternative. |
| A POSIX filesystem | Unix domain sockets with enforced permission bits, and working SQLite WAL. See `SECURITY.md`. |
| `rsvg-convert` *(optional at runtime)* | Block-LaTeX rendering. `brew install librsvg` / `apt install librsvg2-bin`. Missing means LaTeX images are skipped, not that turns fail — but two tests in `test/latex-renderer.test.ts` do shell out to it, so the suite needs it. |
| `lsof` *(optional)* | Used to detect a live socket owner and, on macOS, to detect a Codex Desktop writer. Without it the start scripts fall back to a connect probe and Desktop relay stays off. |

**No compiler, Python or make is needed** — but only because
`.vendor/telecodex/.npmrc` sets `ignore-scripts=true`. The one native
dependency, `better-sqlite3`, ships prebuilt binaries for every supported
platform, yet it also ships a `binding.gyp` and declares no install script, and
npm's documented response to that combination is to run `node-gyp rebuild`
itself. node-gyp's configure step fails without Python long before it would
discover the prebuild. Verified on a PATH with no `python3`: `npm ci` exits 1
without the `.npmrc`, and succeeds with it.

## Runtime resolution

Nothing in this repository hardcodes a Node or Codex path. `telecodex.runtime.sh`
is sourced by each runtime entrypoint. It loads the checkout's
`.telecodex.env` before computing defaults or resolving executables, including
for setup, pinning, analytics and direct CLI calls. Use shell assignment syntax
and quote paths containing spaces.

Existing process variables supply initial values; the root env file overrides
them, and a worker's `.telecodex/instances/<botKey>/bot.env` overrides the root.
Only the primary worker (`main` by default) inherits root Telegram credentials.
Additional workers use credentials from their instance env or from their own
launch environment. Child CLI wrappers inherit this effective configuration,
so they do not reload the root file over an instance override.

Supported runtime settings:

| Variable | Effect |
| --- | --- |
| `TELECODEX_NODE_BIN` | Absolute path to the `node` executable to use. Ends the search. |
| `TELECODEX_NODE_VERSION` | Preferred version, e.g. `v24.14.1`. Defaults to the contents of `.nvmrc`. |
| `TELECODEX_REQUIRE_PINNED_NODE=1` | Fail instead of falling back to another installed Node. |
| `TELECODEX_MIN_NODE_MAJOR` | Minimum acceptable major version. Default 22, matching `engines`. |
| `TELECODEX_CODEX_BIN` | Absolute path to an existing Codex CLI. Bypasses the repo-local pin entirely. |
| `TELECODEX_PIN_ROOT` | Where the pinned Codex snapshot lives. Default `<repo>/.vendor/codex`. |
| `TELECODEX_PINNED_CODEX_VERSION` | Codex CLI version to pin. |

Without any of these, Node is looked for in: the preferred version under nvm,
fnm, asdf, volta, `n`, `~/.local/opt`, `/opt`, `/usr/local/opt`; then whatever
`node` is on PATH; then any other installed version new enough. Homebrew
directories are added to PATH on macOS only.

Check what a host resolves to without starting anything:

```bash
bash -c 'TELECODEX_ROOT=$PWD . ./telecodex.runtime.sh; telecodex_prepare_runtime; echo "$TELECODEX_NODE_BIN"'
./telecodex-bin/codex --version
```

## WSL2

WSL2 is a real Linux kernel, so the bridge itself needs nothing special. Three
things about the *environment* will bite you.

### 1. The checkout must live on the Linux filesystem

Clone into `~/telecodex-oss`, **not** `/mnt/c/...`.

Windows drives are mounted through DrvFs, which does not enforce Unix permission
bits and does not give SQLite a working WAL. Both are load bearing here:

- `chmod 0600` on the three IPC sockets is the **only** access control in the
  entire system (`SECURITY.md`). On DrvFs that chmod is cosmetic, so the inject
  socket — write access to which is arbitrary code execution — is exposed to
  anything that can reach the path, including Windows-side processes.
- `.telecodex/state.sqlite` is the durable turn journal and the Telegram outbox.
  WAL on DrvFs produces locking errors and, worse, silent corruption.

The start scripts refuse to run from `/mnt/<drive>/...` when they detect WSL.
`TELECODEX_ALLOW_DRVFS=1` overrides the refusal; do not use it because a
Windows-side editor was more convenient. Edit over `\\wsl$\` from Windows
instead, which keeps the files on ext4.

### 2. Line endings

`.gitattributes` forces `eol=lf` on every shell script, including the
extensionless ones in `telecodex-bin/`. Windows checkouts default to
`core.autocrlf=true`, and a CRLF shebang makes bash fail with
`$'\r': command not found`. If you cloned before pulling a version with
`.gitattributes`, fix an existing checkout with:

```bash
git add --renormalize .
```

### 3. systemd is opt-in

`systemctl --user` fails with "System has not been booted with systemd" unless
`/etc/wsl.conf` contains:

```ini
[boot]
systemd=true
```

followed by `wsl.exe --shutdown` from Windows. See `deploy/README.md`. Without
it, run the three start scripts by hand or use any other supervisor.

Also worth knowing: WSL2 does not keep the distro running after the last shell
closes unless something holds it open. `loginctl enable-linger "$USER"` plus a
running systemd covers this; otherwise the bridge stops when you close the
terminal.

## macOS

Codex Desktop relay (`/past` continuity with the Desktop app, `desktop-relay*`
in `src/`) is macOS-only by construction: it inspects a writer lock held by
Codex Desktop, which does not exist on Linux. Everything degrades to the normal
direct app-server path; nothing fails.

`pbcopy` is used in exactly one place and is already guarded by a
`process.platform === "darwin"` check.

## Why not native Windows

Not a porting backlog — a missing security layer.

The three local IPC endpoints have no authentication of any kind: no token, no
shared secret, no HMAC. `mkdir 0700` plus `chmod 0600` on the socket is the
entire access control model, and write access to the inject socket is arbitrary
code execution as you.

On native Windows, Node implements `net` sockets as named pipes. `chmod` is a
no-op, and libuv creates the pipe with `lpSecurityAttributes = NULL`, which
means the default DACL. Node's standard library exposes no API for setting a
pipe DACL. Porting the path handling would be easy; the honest version of the
port requires inventing an authentication layer that does not exist today.

WSL2 gets you the same machine with a POSIX filesystem and costs nothing.
