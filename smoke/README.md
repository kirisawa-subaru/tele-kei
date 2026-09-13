# TeleCodex smoke tests

Playwright drives Telegram Web A (`web.telegram.org/a`) with your real account to
exercise the live Core/worker path end to end: group addressing, text roundtrip,
typing indicator, durable final delivery, and (opt-in) image inbound.

## What these tests actually do

Every test sends a real message that starts a **real Codex turn** on the live
bridge: real model cost, running under whatever sandbox profile the app-server
was started with. Messages land on whatever thread the target chat's context
maps to.

`SMOKE_CHAT` is the **Telegram chat** Playwright types into — not a Codex
thread. The bridge maps each chat to its own context and auto-creates a fresh
Codex thread the first time a new chat messages it; nothing thread-related
needs provisioning.

**Recommended target: a dedicated test group**, not a private chat you
actually use (that chat is already bound to a live thread, so smoke turns would
land there). Create a group, add the bot, and point `SMOKE_CHAT` at its `@username`
or numeric chat id (`-100...`, via e.g. @getidsbot). BotFather privacy may stay
on: model prompts explicitly mention the bot or reply to one of its messages.

## Setup (once)

```bash
cd smoke
npm install
npx playwright install chromium
npm run login        # headed browser opens; scan the QR with the Telegram app
```

The session persists in `smoke/.profile` (gitignored).

## Run

```bash
SMOKE_CHAT=@your_test_group SMOKE_BOT_USERNAME=@your_bot npm run smoke
SMOKE_CHAT=@your_test_group SMOKE_BOT_USERNAME=@your_bot SMOKE_IMAGE=1 npm run smoke
HEADLESS=1 SMOKE_CHAT=@your_test_group SMOKE_BOT_USERNAME=@your_bot npm run smoke
```

The message-limit boundary is opt-in because it asks a real turn for more than
4,000 characters:

```bash
HEADLESS=1 SMOKE_LONG=1 SMOKE_CHAT=@your_test_group \
  SMOKE_BOT_USERNAME=@your_bot npx playwright test durable-boundary.spec.js
```

For the Core/worker routing checks, navigate to the bot private chat using the
bot's own peer id (from Bot API `getMe`) and assert the user's Bot API chat id
separately. Telegram Web A treats the user chat id as Saved Messages and does
not resolve a bot username in the URL hash:

```bash
HEADLESS=1 SMOKE_CHAT=<-100... group id> \
  SMOKE_PRIVATE_CHAT=<bot peer id> SMOKE_PRIVATE_CONTEXT_ID=<your user id> \
  npx playwright test architecture-c-routing.spec.js
```

The crash-recovery check stages a synthetic pending outbox row and restarts the
configured worker, so it is separately opt-in. It restarts the worker through
`telecodex.worker.start.sh` by default; set `SMOKE_WORKER_RESTART_CMD` to hand
that off to your process supervisor instead:

```bash
HEADLESS=1 SMOKE_RECOVERY=1 SMOKE_CHAT=<-100... group id> \
  SMOKE_BOT_KEY=main npx playwright test delivery-recovery.spec.js
```

The live multi-bot check opens BotFather, reads the selected bot's plaintext
token into process memory, starts an ephemeral second worker, verifies that the
same Telegram user maps to a different Codex thread, then stops the worker. It
disables screenshots/traces and never prints or persists the token:

```bash
HEADLESS=1 MULTIBOT_LIVE=1 \
  EXPERIMENT_BOT_USERNAME=@an_unused_bot EXPERIMENT_BOT_KEY=experiment \
  EXPERIMENT_USER_CHAT_ID=123456789 \
  npx playwright test multi-bot-live.spec.js
```

The focused LaTeX delivery check is hard-pinned to the delegated test group
and verifies raw TeX text followed by exactly one summary photo:

```bash
HEADLESS=1 SMOKE_CHAT=<-100... group id> SMOKE_ALLOWED_CHAT=<same group id> \
  npx playwright test latex.spec.js
```

The Telemood acceptance check creates a fresh group thread, verifies a model
reaction plus ordered bubble/choice delivery, clicks the choice, and waits for
the callback turn. It is opt-in because it sends real messages and runs two
real Codex turns:

```bash
HEADLESS=1 TELEMOOD_LIVE=1 SMOKE_CHAT=<-100... group id> \
  SMOKE_BOT_USERNAME=@your_bot \
  npx playwright test telemood.spec.js
```

Use this repository's Playwright harness and its persistent Telegram Web A
profile for live browser acceptance rather than an ad-hoc browser session.

Knobs: `SMOKE_TURN_TIMEOUT_MS` (default 240000) bounds how long one turn may
take before the test fails.

## Create another managed Telegram bot

The creation helper reuses the logged-in Playwright profile and the selector layer in
`telegram-page.js`. It creates the bot through BotFather, verifies the token with `getMe`, and
writes the token plus the inherited allowlist to the ignored instance env without printing
the token. The allowlist comes from `TELEGRAM_ALLOWED_USER_IDS`, `.telecodex.env`, or any file
listed in `TELECODEX_EXTRA_ENV_FILES`:

```bash
HEADLESS=1 BOT_KEY=study BOT_NAME="Study" \
  BOT_USERNAMES=example_study_bot,example_study_alt_bot \
  npm run create-bot
```

`BOT_USERNAMES` is an ordered retry list. The resulting credential is written to
`.telecodex/instances/<BOT_KEY>/bot.env` with mode `0600`.

## When a test fails

- Playwright saves a screenshot + trace under `smoke/test-results/`; the page
  helpers additionally dump screenshot + full HTML into `smoke/artifacts/`.
- A failure means the *symptom* is confirmed. The cause lives in the bridge
  and app-server logs, wherever your process supervisor writes them. The specs
  that read those logs take `SMOKE_BRIDGE_STDERR_LOG` and
  `SMOKE_APP_SERVER_STDERR_LOG`.

## Known soft spots

- Telegram Web A's class names are minified and drift with upstream releases.
  Every selector lives in `telegram-page.js` — fix them there, nowhere else.
  Selectors are best-effort until the first live run confirms them.
- The harness uses Web A because the first live calibration showed that Web K
  ignored a private supergroup's full Bot API `-100...` hash, while Web A
  resolved it to the intended group.
- The image test's attach/confirm selectors are the least verified path; it is
  opt-in for that reason.
- `workers: 1` is load-bearing: one browser profile, one shared bridge.
