import path from "node:path";

import { createBot, recoverPendingDeliveries, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { assertBotKey } from "./core-protocol.js";
import { RemoteSessionRegistry } from "./core-client.js";
import { TelegramDeliveryStore } from "./delivery-store.js";
import {
  injectSocketPath,
  startInjectServer,
  type TeleCodexInjectServer,
} from "./inject-server.js";
import { TelegramTokenLease } from "./token-lease.js";
import { loadBotProfileDefaults } from "./bot-profile.js";

const config = loadConfig();
const botKey = assertBotKey(process.env.TELECODEX_BOT_KEY?.trim() || "main");
const repositoryRoot = config.workspace;
const profile = loadBotProfileDefaults(repositoryRoot, botKey);
if (profile.workspace) config.workspace = profile.workspace;
if (profile.model) config.codexModel = profile.model;
const coreSocket = process.env.TELECODEX_CORE_SOCKET?.trim() ||
  path.join(repositoryRoot, ".telecodex", "run", "core.sock");
const stateDb = process.env.TELECODEX_STATE_DB?.trim() ||
  path.join(repositoryRoot, ".telecodex", "state.sqlite");
const registry = new RemoteSessionRegistry(coreSocket, botKey);
const deliveryStore = new TelegramDeliveryStore(stateDb);
const tokenLease = TelegramTokenLease.acquire(
  path.join(repositoryRoot, ".telecodex", "run"),
  botKey,
  config.telegramBotToken,
);
const bot = createBot(config, registry, { botKey, deliveryStore });
let injectServer: TeleCodexInjectServer | undefined;

try {
  await registry.initialize();
  await registerCommands(bot);
  const recovery = await recoverPendingDeliveries(bot, registry, deliveryStore, botKey);
  if (recovery.recovered || recovery.failed) {
    console.log(`Delivery recovery: ${recovery.recovered} recovered, ${recovery.failed} failed`);
  }
  injectServer = await startInjectServer(
    process.env.TELECODEX_INJECT_SOCKET?.trim() || injectSocketPath(repositoryRoot, botKey),
    bot.enqueueInjectedText,
    bot.sendLocalFile,
    bot.sendInteraction,
  );
  console.log("TeleCodex Telegram worker running");
  console.log(`Bot key: ${botKey}`);
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Core socket: ${coreSocket}`);
  console.log(`Inject socket: ${injectServer.socketPath}`);
} catch (error) {
  console.error(`Failed to start TeleCodex worker ${botKey}: ${formatError(error)}`);
  registry.close();
  deliveryStore.close();
  tokenLease.release();
  void injectServer?.close().catch(() => {});
  process.exit(1);
}

let shuttingDown = false;
let shutdownSignal: NodeJS.Signals | undefined;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownSignal = signal;
  console.log(`Received ${signal}, shutting down TeleCodex worker ${botKey}...`);
  void injectServer?.close().catch(() => {});
  void bot.stop().catch((error) =>
    console.error(`Failed to stop Telegram polling for ${botKey}: ${formatError(error)}`),
  );
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

try {
  await bot.start();
} catch (error) {
  if (!shuttingDown) {
    console.error(`Fatal Telegram polling error for ${botKey}: ${formatError(error)}`);
    void injectServer?.close().catch(() => {});
    registry.close();
    deliveryStore.close();
    tokenLease.release();
    process.exit(1);
  }
}

registry.close();
deliveryStore.close();
tokenLease.release();
void injectServer?.close().catch(() => {});
if (shutdownSignal) console.log(`TeleCodex worker ${botKey} stopped after ${shutdownSignal}.`);

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
