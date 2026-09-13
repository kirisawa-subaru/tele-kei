#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const options = parseArguments(process.argv.slice(2));
const threadId = process.env.CODEX_THREAD_ID?.trim();
if (!threadId) {
  fail("CODEX_THREAD_ID is not available. Run this trigger from an active Codex CLI conversation.");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const socketPath = options.socketPath ?? path.join(repoRoot, ".telecodex", "run", "control.sock");
const request = {
  command: "bind-active-thread",
  threadId,
  botKey: options.botKey ?? process.env.TELECODEX_BOT_KEY?.trim() ?? "main",
  ...(options.contextKey ? { contextKey: options.contextKey } : {}),
  ...(process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim()
    ? { desktopRelay: { pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH.trim() } }
    : {}),
};

try {
  const response = await sendRequest(socketPath, request);
  if (!response || typeof response !== "object" || response.ok !== true) {
    const message =
      response && typeof response === "object" && typeof response.error === "string"
        ? response.error
        : "TeleCodex returned an invalid control response";
    fail(message);
  }

  const previous =
    response.previousThreadId && response.previousThreadId !== response.threadId
      ? ` (replaced ${abbreviate(response.previousThreadId)})`
      : "";
  const mode = response.mode === "desktop-relay" ? " via Desktop relay" : "";
  console.log(
    `Telegram context ${response.contextKey} now follows Codex thread ${abbreviate(response.threadId)}${previous}${mode}.`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("ENOENT") || detail.includes("ECONNREFUSED")) {
    fail("TeleCodex control socket is unavailable. Start the bridge and try again.");
  }
  fail(detail);
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: telegram-active [--bot BOT_KEY] [--context CHAT_OR_TOPIC_KEY] [--socket PATH]");
      process.exit(0);
    }
    if (argument === "--bot") {
      parsed.botKey = requireValue(args, ++index, "--bot");
      continue;
    }
    if (argument === "--context") {
      parsed.contextKey = requireValue(args, ++index, "--context");
      continue;
    }
    if (argument === "--socket") {
      parsed.socketPath = requireValue(args, ++index, "--socket");
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index]?.trim();
  if (!value) fail(`${option} requires a value`);
  return value;
}

function sendRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let responseBytes = 0;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the TeleCodex control socket"));
    }, REQUEST_TIMEOUT_MS);

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      responseBytes += Buffer.byteLength(chunk, "utf8");
      if (responseBytes > MAX_RESPONSE_BYTES) {
        socket.destroy();
        reject(new Error("TeleCodex control response is too large"));
      }
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(response.trim()));
      } catch {
        reject(new Error("TeleCodex returned malformed JSON"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function abbreviate(value) {
  return typeof value === "string" && value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function fail(message) {
  console.error(`telegram-active: ${message}`);
  process.exit(1);
}
