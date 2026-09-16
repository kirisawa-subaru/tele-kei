import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Real entry scripts, but every executable they could launch is a local stub.
// These tests never start a bridge, read credentials, or contact Telegram.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "telecodex-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["telecodex-bin", ".vendor/telecodex/dist", "bin", "telegram-active/scripts"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const file of [
    "telecodex.runtime.sh", "telecodex.setup.sh", "telecodex.pin-codex.sh",
    "telecodex.core.start.sh", "telecodex.worker.start.sh", "telecodex.app-server.start.sh",
    "telecodex-bin/codex", "telecodex-bin/telecodex-remote",
  ]) copyFileSync(path.join(sourceRoot, file), path.join(root, file));
  writeFileSync(path.join(root, ".vendor/telecodex/package.json"), "{}");
  writeFileSync(path.join(root, ".nvmrc"), "v0.0.0\n");
  for (const name of ["core", "worker"]) {
    writeFileSync(path.join(root, `.vendor/telecodex/dist/${name}-index.js`), "");
  }
  writeFileSync(path.join(root, "telegram-active/scripts/bind-current-thread.mjs"), "");
  const report = path.join(root, "calls.jsonl");
  writeFileSync(path.join(root, "probe.cjs"), `
const fs = require('node:fs');
const [kind, ...args] = process.argv.slice(2);
if (args[0] === '--version') { console.log(kind === 'codex' ? 'codex-cli 0.153.4' : 'v24.14.1'); process.exit(0); }
if (kind === 'node' && args[0] === '-p') { console.log('24'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ kind, args,
  node: process.env.TELECODEX_NODE_BIN, codex: process.env.TELECODEX_CODEX_BIN,
  approval: process.env.CODEX_APPROVAL_POLICY, token: process.env.TELEGRAM_BOT_TOKEN,
  allowed: process.env.TELEGRAM_ALLOWED_USER_IDS }) + '\\n');
`);
  for (const name of ["node", "codex", "npm", "instance-codex"]) {
    writeFileSync(path.join(root, "bin", name),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "probe.cjs"))} ${quote(name)} "$@"\n`,
      { mode: 0o755 });
  }
  const node = path.join(root, "bin/node");
  const codex = path.join(root, "bin/codex");
  const config = [
    `TELECODEX_NODE_BIN=${quote(node)}`, `TELECODEX_CODEX_BIN=${quote(codex)}`,
    `TELEGRAM_ACTIVE_BIN=${quote(path.join(root, "bin/telegram-active"))}`,
    "TELEGRAM_BOT_TOKEN=fixture-primary-token", "TELEGRAM_ALLOWED_USER_IDS=123",
  ];
  const writeConfig = (extra = []) => writeFileSync(path.join(root, ".telecodex.env"), [...config, ...extra].join("\n") + "\n");
  writeConfig();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(TELECODEX_|TELEGRAM_|CODEX_|NPM_CONFIG_|npm_config_)/.test(key)));
  // HOME stays untouched; the fixture contains all configuration and binaries.
  env.PATH = "/usr/bin:/bin";
  env.TELECODEX_REQUIRE_PINNED_NODE = "1";
  return {
    root, node, codex, writeConfig,
    run: (file, args = [], extraEnv = {}) => spawnSync("/bin/bash", [path.join(root, file), ...args], {
      cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10_000,
    }),
    calls: () => existsSync(report) ? readFileSync(report, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

function succeeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("direct Codex wrapper reads the configured external CLI without a local pin", (t) => {
  const f = fixture(t);
  const result = f.run("telecodex-bin/codex", ["--version"]);
  succeeded(result);
  assert.match(result.stdout, /codex-cli 0\.153\.4/);
});

test("setup reads runtime and trigger paths before resolving dependencies", (t) => {
  const f = fixture(t);
  succeeded(f.run("telecodex.setup.sh"));
  assert.deepEqual(f.calls().map(({ kind, args }) => [kind, args[0]]), [["npm", "install"], ["npm", "run"]]);
  assert.ok(f.calls().every((call) => call.node === f.node && call.codex === f.codex));
  assert.ok(existsSync(path.join(f.root, "bin/telegram-active")));
  assert.equal(existsSync(path.join(f.root, ".vendor/codex")), false);
});

test("core defaults to never when the env file omits the approval key", (t) => {
  const f = fixture(t);
  succeeded(f.run("telecodex.core.start.sh"));
  assert.equal(f.calls().at(-1).approval, "never");
  assert.equal(f.calls().at(-1).node, f.node);
});

test("instance overrides reach child CLI wrappers without root config being reloaded", (t) => {
  const f = fixture(t);
  const instanceDir = path.join(f.root, ".telecodex/instances/ops");
  mkdirSync(instanceDir, { recursive: true });
  const instanceCodex = path.join(f.root, "bin/instance-codex");
  writeFileSync(path.join(instanceDir, "bot.env"), [
    "TELEGRAM_BOT_TOKEN=fixture-ops-token", "TELEGRAM_ALLOWED_USER_IDS=456",
    `TELECODEX_CODEX_BIN=${quote(instanceCodex)}`,
  ].join("\n"));
  // The fake worker invokes the real CLI wrapper, as auth/usage code does.
  writeFileSync(path.join(f.root, "bin/node"),
    `#!/bin/sh\nexec /bin/bash ${quote(path.join(f.root, "telecodex-bin/codex"))} probe\n`, { mode: 0o755 });
  succeeded(f.run("telecodex.worker.start.sh", ["ops"]));
  assert.equal(f.calls().at(-1).kind, "instance-codex");
  assert.equal(f.calls().at(-1).token, "fixture-ops-token");
});

test("an additional worker cannot inherit the primary bot's credentials", (t) => {
  const f = fixture(t);
  const result = f.run("telecodex.worker.start.sh", ["ops"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing token or allowed user ids/);
  assert.deepEqual(f.calls(), []);
});

test("an additional worker accepts credentials supplied by a supervisor", (t) => {
  const f = fixture(t);
  succeeded(f.run("telecodex.worker.start.sh", ["ops"], {
    TELEGRAM_BOT_TOKEN: "fixture-supervisor-token", TELEGRAM_ALLOWED_USER_IDS: "789",
  }));
  assert.equal(f.calls().at(-1).token, "fixture-supervisor-token");
  assert.equal(f.calls().at(-1).allowed, "789");
  assert.equal(f.calls().at(-1).node, f.node);
});

test("remote CLI reads the configured socket before checking its existence", (t) => {
  const f = fixture(t);
  const socket = path.join(f.root, "custom.sock");
  f.writeConfig([`CODEX_APP_SERVER_SOCKET=${quote(socket)}`]);
  const result = f.run("telecodex-bin/telecodex-remote");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(socket), result.stderr);
});
