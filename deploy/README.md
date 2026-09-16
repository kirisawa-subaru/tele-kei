# Process supervision templates

TeleCodex runs as three long-lived processes, supervised separately:

```text
telecodex.app-server.start.sh        the single shared Codex writer
telecodex.core.start.sh              Core Router: sessions, ledger, control socket
telecodex.worker.start.sh <botKey>   one per Telegram token
```

The app-server starts first and Core must be reachable before a worker starts.
These templates provide the default installation described in [SETUP.md](../SETUP.md):
the bot stays in the background while the desktop CLI is opened on demand in
tmux. tmux holds the CLI frontend; it does not replace service supervision.
Three foreground terminals are useful for diagnosis, not the default handoff.
If the user explicitly prefers manual service start/stop, keep supervision but
disable automatic startup and give them the exact commands.

Both sets are parameterised. Render them for your checkout:

```bash
./deploy/render.sh                      # bot key "main", target detected from uname
./deploy/render.sh --bot-key ops        # an additional worker
./deploy/render.sh --target launchd --label-prefix com.yourname.telecodex
```

Output lands in `.telecodex/deploy/` (gitignored) and the install commands are
printed. Nothing outside the repository is written or loaded for you.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `__TELECODEX_ROOT__` | absolute path of this checkout |
| `__LABEL_PREFIX__` | reverse-DNS prefix you own, launchd only |
| `__BOT_KEY__` | lowercase bot key, e.g. `main` |

## systemd (Linux, WSL2)

User units, not system units: the bridge runs as you, reads your `~/.codex`
credentials, and writes into your checkout.

```bash
mkdir -p ~/.config/systemd/user
cp .telecodex/deploy/telecodex-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now telecodex-app-server telecodex-core telecodex-worker@main
```

Services stop when your last session ends unless lingering is enabled:

```bash
loginctl enable-linger "$USER"
```

Liveness and logs:

```bash
systemctl --user status telecodex-core
journalctl --user -u telecodex-worker@main -f
```

The worker unit is a template unit: one instance per bot key
(`telecodex-worker@main`, `telecodex-worker@ops`), each with its own
`.telecodex/instances/<botKey>/bot.env`.

**WSL2 has no systemd unless you ask for it.** Put this in `/etc/wsl.conf` and
run `wsl.exe --shutdown` from Windows:

```ini
[boot]
systemd=true
```

Without it, `systemctl --user` fails with "System has not been booted with
systemd". The three start scripts still run fine by hand.

## launchd (macOS)

```bash
mkdir -p ~/Library/LaunchAgents .telecodex/logs
cp .telecodex/deploy/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.app-server.plist
```

launchd has no ordering primitive. Core retries its app-server connection, so
bootstrapping in order — app-server, core, worker — is enough.

A supervisor's own `status` verb can lag. Ask the platform instead:

```bash
launchctl print "gui/$(id -u)/<label-prefix>.app-server"
```

launchd agents do not inherit your shell environment. That is exactly why the
start scripts resolve Node themselves (`telecodex.runtime.sh`) instead of
trusting PATH.

## Restart semantics worth knowing

- launchd restarts on failure and stops after a clean exit. The app-server
  and Core scripts exit 0 when another process already holds their socket.
- systemd uses `Restart=always`, including after a clean exit, with a limit of
  5 starts per minute. A duplicate instance therefore reaches the limit and
  stays down; inspect `systemctl --user status` to see why.
- A worker refuses to start while another live worker holds the same Telegram
  token. Telegram allows exactly one polling consumer per token, so a stopped
  unit is the correct failure mode, not a duplicate poller.
