# tele-kei

Keep Codex on your computer and your Telegram bot online together, continuing the same work from either side.

[简体中文](README.md) · English

## What this fork focuses on

**Keep the desktop and bot online together, working in the same conversation.**
Send messages from your phone without first closing the computer-side conversation. The Codex Desktop integration uses Codex's agent messaging mechanism to send phone messages into the conversation already open on the desktop. The CLI integration shares the same conversation service, keeping both sides on the same context.

**Make history, rollback and status useful on a phone.**
Conversation browsing and controls have been reworked for Telegram: `/view` finds history and shows conversation details, `/past` catches up on computer-side messages, `/rewind` rolls back the conversation, and `/status` shows the current conversation, context usage and rate-limit status. These full conversation controls apply to the shared CLI mode.

Sending retries and recovery of unfinished replies also help reduce interruptions from transient network failures when using the bot from a phone.

Supports **macOS and Linux**, including **Ubuntu on WSL2**. Codex Desktop integration is currently macOS-only; Linux uses the CLI integration. The computer running Codex must stay on and connected.

## What you provide

Give this repository to a **coding agent running on the target computer**, such as Codex CLI or Claude Code. It handles dependencies and configuration. You provide:

| Item | Where to get it |
| --- | --- |
| Telegram bot token | Send `/newbot` to [@BotFather](https://t.me/BotFather) and follow the prompts |
| Your numeric Telegram user ID | Send `/start` to [@userinfobot](https://t.me/userinfobot); use your own Id |
| Workspace | Choose an existing project or a new directory, as you would in Codex CLI |
| Codex subscription account | Complete sign-in if requested; an existing login can be reused |

The token is your bot's password. The bot invokes Codex to work with files and run commands under your account; use your own user ID in the allowlist.

Send this to your agent:

> Install https://github.com/kirisawa-subaru/tele-kei following SETUP.md. Set up a background bot and an on-demand tmux entry for opening and resuming the computer-side CLI. Ask me for the token, user ID, workspace or login when needed. Verify that phone and computer continue the same conversation, then tell me how to open, detach, stop and resume.

Once installed, chat with the bot on your phone or use the entry configured by the agent to open or reattach on your computer. **Detaching tmux leaves the bot running; sleeping or shutting down the host interrupts service.**

## For the installation agent

Start with [SETUP.md](SETUP.md). Finish with working background services, a tmux entry, verified phone/terminal continuity and instructions for everyday start and stop.

---

Maintained by [kirisawa-subaru](https://github.com/kirisawa-subaru), derived from [TeleCodex](https://github.com/benedict2310/telecodex).
[MIT license](LICENSE) · [Third-party notices](.vendor/telecodex/THIRD_PARTY_NOTICES.md) · [Security](SECURITY.md)
