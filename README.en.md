# tele-kei

Use the Codex CLI on your computer through Telegram and continue the same work from your phone or terminal.

[简体中文](README.md) · English

## What it does

- **Continue the same conversation on phone and computer.** Pick up phone-side work in the terminal, or bind a terminal conversation to Telegram.
- **Work with your files.** Send text, images or files; Codex uses your chosen workspace and sends results back to the chat.
- **Keep working away from the terminal.** The bot runs in the background. Open the computer-side CLI when needed; tmux keeps its terminal session available to reattach.
- **Manage conversations in Telegram.** Start a conversation, find history, switch models or check status from the chat.

Supports **macOS and Linux**, including **Ubuntu on WSL2**. The computer running Codex must stay on and connected.

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
