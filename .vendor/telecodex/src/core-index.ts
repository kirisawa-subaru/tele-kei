import path from "node:path";

import { loadCoreConfig } from "./config.js";
import { startControlServer, type TeleCodexControlServer } from "./control-server.js";
import { startCoreRouterServer, type CoreRouterServer } from "./core-server.js";
import { SessionRegistry } from "./session-registry.js";
import { CoreStateStore } from "./state-store.js";
import { DurableTurnJournal } from "./turn-journal.js";

let registry: SessionRegistry | undefined;
let router: CoreRouterServer | undefined;
let controlServer: TeleCodexControlServer | undefined;
let stateStore: CoreStateStore | undefined;

try {
  const config = loadCoreConfig();
  stateStore = new CoreStateStore(
    process.env.TELECODEX_STATE_DB?.trim() || path.join(config.workspace, ".telecodex", "state.sqlite"),
  );
  registry = new SessionRegistry(config, { defaultBotKey: "main", stateStore });
  await registry.initialize();
  const runDir = path.join(config.workspace, ".telecodex", "run");
  router = await startCoreRouterServer(
    process.env.TELECODEX_CORE_SOCKET?.trim() || path.join(runDir, "core.sock"),
    registry,
    new DurableTurnJournal(stateStore),
  );
  controlServer = await startControlServer(
    process.env.TELECODEX_CONTROL_SOCKET?.trim() || path.join(runDir, "control.sock"),
    registry,
  );

  console.log("TeleCodex Core Router running");
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Codex backend: ${config.codexBackend ?? "sdk"}`);
  console.log(`Worker socket: ${router.socketPath}`);
  console.log(`Control socket: ${controlServer.socketPath}`);
} catch (error) {
  console.error(`Failed to start TeleCodex Core Router: ${formatError(error)}`);
  registry?.disposeAll();
  stateStore?.close();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down TeleCodex Core Router...`);
  void Promise.all([router?.close(), controlServer?.close()]).finally(() => {
    registry?.disposeAll();
    stateStore?.close();
    console.log("TeleCodex Core Router stopped.");
    process.exit(0);
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
