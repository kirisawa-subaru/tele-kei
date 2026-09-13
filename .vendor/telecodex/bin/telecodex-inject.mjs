#!/usr/bin/env node

import { connect } from "node:net";
import { readFileSync } from "node:fs";

const USAGE =
  "usage: telecodex-inject.mjs --socket <path> --chat <id> [--topic <id>] [--rollover [--after-rollover-file <path>]] (<text...> | --stdin)";

function parseArgs(argv) {
  let socketPath;
  let chatId;
  let topicId;
  let stdin = false;
  let rollover = false;
  let afterRolloverPath;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--socket") socketPath = argv[++index];
    else if (arg === "--chat") chatId = argv[++index];
    else if (arg === "--topic") topicId = argv[++index];
    else if (arg === "--stdin") stdin = true;
    else if (arg === "--rollover") rollover = true;
    else if (arg === "--after-rollover-file") afterRolloverPath = argv[++index];
    else if (arg === "--help" || arg === "-h") return { help: true };
    else rest.push(arg);
  }
  return { socketPath, chatId, topicId, stdin, rollover, afterRolloverPath, text: rest.join(" ") };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (!args.socketPath || !args.chatId) fail(USAGE);
if (args.afterRolloverPath && !args.rollover) {
  fail("telecodex-inject: --after-rollover-file requires --rollover");
}

const text = args.stdin ? readFileSync(0, "utf8") : args.text;
if (!text || !text.trim()) fail(USAGE);
const afterRolloverText = args.afterRolloverPath
  ? readFileSync(args.afterRolloverPath, "utf8")
  : undefined;
if (args.afterRolloverPath && !afterRolloverText?.trim()) {
  fail("telecodex-inject: --after-rollover-file is empty");
}

const chatId = Number(args.chatId);
if (!Number.isSafeInteger(chatId)) fail(`telecodex-inject: --chat must be an integer, got ${args.chatId}`);
let topicId;
if (args.topicId !== undefined) {
  topicId = Number(args.topicId);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) {
    fail(`telecodex-inject: --topic must be a positive integer, got ${args.topicId}`);
  }
}

const request = JSON.stringify({
  chatId,
  text,
  ...(topicId === undefined ? {} : { topicId }),
  ...(args.rollover ? { rollover: true } : {}),
  ...(afterRolloverText === undefined ? {} : { afterRolloverText }),
});
const socket = connect(args.socketPath);
socket.setEncoding("utf8");
let buffer = "";
let settled = false;

const finish = (code, message) => {
  if (settled) return;
  settled = true;
  if (message) (code === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  socket.destroy();
  process.exit(code);
};

socket.on("connect", () => socket.write(`${request}\n`));
socket.on("error", (error) => finish(1, `telecodex-inject: ${error.message}`));
socket.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline === -1) return;
  const line = buffer.slice(0, newline);
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    finish(1, `telecodex-inject: bad response ${line}`);
    return;
  }
  if (response?.ok === true) {
    finish(0, `queued for ${response.contextKey}${response.rollover ? " with rollover" : ""}`);
  } else {
    finish(1, `telecodex-inject: ${response?.error || "rejected"}`);
  }
});
socket.on("close", () => finish(1, "telecodex-inject: inject socket closed without a response"));
