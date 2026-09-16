# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the runtime code for the Telegram bridge. The supported deployment uses `src/core-index.ts` and `src/worker-index.ts`, alongside a shared Codex app-server. `src/index.ts` is the legacy single-process entrypoint. Bot wiring lives in `src/bot.ts`, Codex sessions in `src/codex-session.ts`, and configuration in `src/config.ts`.

`test/` mirrors the source layout with Vitest files such as `test/config.test.ts`. Build output goes to `dist/` and should not be committed. Use the root `../../SETUP.md` for installation. Deployment configuration belongs in `../../.telecodex.env`, with additional bot credentials in `../../.telecodex/instances/<botKey>/bot.env`. The local `.env.example` is only for the legacy development entrypoint.

## Build, Test, and Development Commands
Use Node.js 22+.

- `npm ci` installs the locked project dependencies.
- `npm run dev` starts the legacy single-process backend with `tsx`; use the root shell entrypoints for the supported deployment.
- `npm run build` runs `tsc` and emits production files to `dist/`.
- `npm test` runs the Vitest suite once.
- From the repository root, `node --test tools/*.test.mjs` checks collectors and startup configuration. These tests use stub executables and never start live bots.

## Coding Style & Naming Conventions
This repository uses strict TypeScript with ES modules. Follow the existing style: 2-space indentation, double quotes, semicolons, and explicit `.js` import specifiers in TypeScript source. Prefer small, focused modules and descriptive camelCase identifiers; use PascalCase for exported types and classes, such as `TeleCodexConfig` and `CodexSessionService`.

Keep environment variable names uppercase with underscores, for example `CODEX_APPROVAL_POLICY`. Match new filenames to the current pattern: lowercase kebab-free names in `src/`, and `*.test.ts` in `test/`.

## Testing Guidelines
Tests use Vitest with globals enabled and the pattern `test/**/*.test.ts`. Add or update tests alongside behavior changes, especially for config parsing, formatting, and session lifecycle logic. Run `npm test` before opening a PR; run `npm run build` when changing types, imports, or entrypoint wiring.

## Commit & Pull Request Guidelines
The current history uses short, descriptive commit subjects, for example: `Initial TeleCodex implementation - Telegram bridge for OpenAI Codex CLI SDK`. Keep commit messages imperative, concise, and scoped to one logical change.

PRs should explain the behavior change, note any config impact, and link related issues when present. Include screenshots or Telegram message samples for UI or formatting changes.

## Security & Configuration Tips
Do not commit `.telecodex.env`, `.env`, runtime state, API keys, or Telegram tokens. Only `CODEX_APPROVAL_POLICY=never` is supported; other values must fail configuration validation. Restrict `TELEGRAM_ALLOWED_USER_IDS` to trusted users, and default to `CODEX_SANDBOX_MODE=workspace-write` unless broader access is required.

## Release Automation
This fork is distributed as a source checkout. The nested package is private and CI only builds and tests. `docs/npm-trusted-publishing.md` is historical upstream material, not a release procedure for this fork.
