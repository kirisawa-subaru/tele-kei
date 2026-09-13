import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

import { listThreads } from "./codex-state.js";
import type { DesktopRelayDescriptor } from "./desktop-relay.js";

const DESKTOP_CODEX_PATH = /\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/codex(?:\s|$)/;
const APP_SERVER_ARGUMENT = /(?:^|\s)app-server(?:\s|$)/;
const PIPE_ARGUMENT = /CODEX_APP_TOOLS_PIPE_PATH["']?\s*[:=]\s*["']?([^"',}\s]+)/;

type FileStat = {
  isSocket(): boolean;
};

export type DesktopRelayDiscoveryDependencies = {
  getWriterLockPath(threadId: string): string | null;
  listThreadIds(): string[];
  run(command: string, args: string[]): string;
  stat(path: string): FileStat;
};

const defaultDependencies: DesktopRelayDiscoveryDependencies = {
  getWriterLockPath: (threadId) => {
    const home = process.env.HOME?.trim();
    const codexHome = process.env.CODEX_HOME?.trim() || (home ? path.join(home, ".codex") : null);
    return codexHome ? path.join(codexHome, "thread-writer-locks", `${threadId}.lock`) : null;
  },
  listThreadIds: () => listThreads(200).map((thread) => thread.id),
  run: (command, args) => execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  }),
  stat: (targetPath) => statSync(targetPath),
};

/**
 * Resolve Desktop relay only when Desktop is the process that actually owns
 * the target writer lock. An active-writer error alone is not enough: a
 * separate Codex CLI app-server produces the same error and must not be routed
 * through Desktop.
 */
export function discoverDesktopRelayDescriptor(
  threadId: string,
  preferredCallerThreadId?: string | null,
  dependencies: DesktopRelayDiscoveryDependencies = defaultDependencies,
): DesktopRelayDescriptor | null {
  const writerLockPath = dependencies.getWriterLockPath(threadId);
  if (!writerLockPath) return null;

  let ownerPids: string[];
  try {
    const lsofPath = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
    ownerPids = parseWritableOwnerPids(
      dependencies.run(lsofPath, ["-n", "-F", "pa", "--", writerLockPath]),
    );
  } catch {
    return null;
  }
  if (ownerPids.length !== 1) return null;

  for (const pid of ownerPids) {
    let command: string;
    try {
      const psPath = process.platform === "darwin" ? "/bin/ps" : "ps";
      command = dependencies.run(psPath, ["-p", pid, "-ww", "-o", "command="]).trim();
    } catch {
      continue;
    }
    if (!DESKTOP_CODEX_PATH.test(command) || !APP_SERVER_ARGUMENT.test(command)) continue;

    const pipePath = PIPE_ARGUMENT.exec(command)?.[1];
    if (!pipePath || !isSocket(pipePath, dependencies)) continue;

    const callerThreadId = resolveCallerThreadId(
      threadId,
      preferredCallerThreadId,
      dependencies.listThreadIds(),
    );
    if (!callerThreadId) {
      throw new Error(
        "Desktop relay needs a different local caller thread; start another Codex thread and try again",
      );
    }
    return { pipePath, callerThreadId };
  }

  return null;
}

function parseWritableOwnerPids(output: string): string[] {
  const writable = new Set<string>();
  let currentPid: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p") && /^\d+$/.test(line.slice(1))) {
      currentPid = line.slice(1);
      continue;
    }
    if (currentPid && line.startsWith("a") && /[uw]/.test(line.slice(1))) {
      writable.add(currentPid);
    }
  }
  return [...writable];
}

function isSocket(
  pipePath: string,
  dependencies: DesktopRelayDiscoveryDependencies,
): boolean {
  try {
    return dependencies.stat(pipePath).isSocket();
  } catch {
    return false;
  }
}

function resolveCallerThreadId(
  targetThreadId: string,
  preferredCallerThreadId: string | null | undefined,
  candidates: string[],
): string | null {
  const preferred = preferredCallerThreadId?.trim();
  if (preferred && preferred !== targetThreadId) return preferred;
  return candidates.find((candidate) => candidate && candidate !== targetThreadId) ?? null;
}
