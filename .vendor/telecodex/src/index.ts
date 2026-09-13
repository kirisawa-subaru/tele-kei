import path from "node:path";

import { createBot, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { startControlServer, type TeleCodexControlServer } from "./control-server.js";
import { SessionRegistry } from "./session-registry.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let controlServer: TeleCodexControlServer | undefined;

try {
  const config = loadConfig();
  registry = new SessionRegistry(config);
  await registry.initialize();
  bot = createBot(config, registry);
  await registerCommands(bot);
  controlServer = await startControlServer(
    path.join(config.workspace, ".telecodex", "run", "control.sock"),
    registry,
  );

  console.log("TeleCodex running");
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Codex backend: ${config.codexBackend ?? "sdk"}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  console.log("Session mode: per Telegram context");
  console.log(`CLI control socket: ${controlServer.socketPath}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TeleCodex: ${message}`);
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down TeleCodex...`);
  void controlServer?.close();
  if (bot) bot.stop();

  setTimeout(() => {
    registry?.disposeAll();
    console.log("TeleCodex stopped.");
    process.exit(0);
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      onStart: () => {
        restartAttempts = 0;
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
