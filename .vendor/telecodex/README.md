# TeleCodex source

This directory is the maintained TypeScript source for the fork. The repository
root owns installation, configuration and process supervision.

- [Project overview](../../README.md)
- [Agent-guided installation](../../SETUP.md)
- [Operational reference and Telegram commands](../../TELECODEX.md)
- [Platform support](../../docs/platforms.md)
- [Security and execution scope](../../SECURITY.md)

## Install and run

Follow the root setup guide. Credentials and runtime paths belong in
`<repo>/.telecodex.env`; additional bots use
`<repo>/.telecodex/instances/<botKey>/bot.env`.

The supported deployment has three processes: shared Codex app-server, Core
Router, and one Telegram worker per token. Use the root `telecodex.*.sh`
entrypoints or the templates in [deploy/](../../deploy/README.md).

Only `CODEX_APPROVAL_POLICY=never` is supported. There is no approval
interaction; other values are rejected at startup.

## Development

Node 22 or newer is required. From this directory:

```bash
npm ci
npm run build
npm test
```

Install librsvg for the LaTeX renderer tests. From the repository root, also run
`node --test tools/*.test.mjs` for collectors and startup configuration tests.

`npm run dev` and `npm start` invoke the legacy single-process backend. They
are development entrypoints, not the installation path for the three-process
deployment. The local `.env.example` belongs only to that legacy entrypoint.

## Distribution and attribution

This fork is distributed as a source checkout; the nested package is private
and has no npm release workflow. The root [LICENSE](../../LICENSE) and this
folder's [third-party notices](THIRD_PARTY_NOTICES.md) preserve upstream
attribution. The old npm publishing playbook is historical upstream material.
