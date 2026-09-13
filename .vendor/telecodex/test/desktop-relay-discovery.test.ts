import { describe, expect, it, vi } from "vitest";

import {
  discoverDesktopRelayDescriptor,
  type DesktopRelayDiscoveryDependencies,
} from "../src/desktop-relay-discovery.js";

const PIPE_PATH = "/tmp/codex-browser-use/desktop.sock";

function desktopCommand(pipePath = PIPE_PATH): string {
  return [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "-c features.code_mode_host=true app-server",
    `-c mcp_servers.codex_app={"env"={"CODEX_APP_TOOLS_PIPE_PATH"="${pipePath}"}}`,
  ].join(" ");
}

function createDependencies(
  overrides: Partial<DesktopRelayDiscoveryDependencies> = {},
): DesktopRelayDiscoveryDependencies {
  return {
    getWriterLockPath: vi.fn(() => "/codex/thread-writer-locks/thread-target.lock"),
    listThreadIds: vi.fn(() => ["thread-target", "thread-caller"]),
    run: vi.fn((_command, args) => args.includes("command=")
      ? desktopCommand()
      : "p42\nau\n"),
    stat: vi.fn(() => ({ isSocket: () => true })),
    ...overrides,
  };
}

describe("discoverDesktopRelayDescriptor", () => {
  it("resolves the socket from the Desktop process that owns the rollout writer", () => {
    const dependencies = createDependencies();

    expect(discoverDesktopRelayDescriptor(
      "thread-target",
      "thread-preferred",
      dependencies,
    )).toEqual({
      pipePath: PIPE_PATH,
      callerThreadId: "thread-preferred",
    });
    expect(dependencies.stat).toHaveBeenCalledWith(PIPE_PATH);
  });

  it("uses another real thread when the target cannot call its own Desktop tools", () => {
    const dependencies = createDependencies();

    expect(discoverDesktopRelayDescriptor(
      "thread-target",
      "thread-target",
      dependencies,
    )).toEqual({
      pipePath: PIPE_PATH,
      callerThreadId: "thread-caller",
    });
  });

  it("does not treat a read-only Desktop file handle as the active writer", () => {
    const dependencies = createDependencies({
      run: vi.fn((_command, args) => args.includes("command=")
        ? desktopCommand()
        : "p42\nar\n"),
    });

    expect(discoverDesktopRelayDescriptor("thread-target", null, dependencies)).toBeNull();
  });

  it("fails closed when the writer lock has multiple writable holders", () => {
    const dependencies = createDependencies({
      run: vi.fn((_command, args) => args.includes("command=")
        ? desktopCommand()
        : "p42\nau\np77\nau\n"),
    });

    expect(discoverDesktopRelayDescriptor("thread-target", null, dependencies)).toBeNull();
  });

  it("does not route a CLI-owned writer through an unrelated Desktop instance", () => {
    const dependencies = createDependencies({
      run: vi.fn((_command, args) => args.includes("command=")
        ? "/opt/homebrew/bin/codex app-server --listen stdio://"
        : "p77\nau\n"),
    });

    expect(discoverDesktopRelayDescriptor("thread-target", null, dependencies)).toBeNull();
  });

  it("rejects a stale capability path", () => {
    const dependencies = createDependencies({
      stat: vi.fn(() => { throw new Error("ENOENT"); }),
    });

    expect(discoverDesktopRelayDescriptor("thread-target", null, dependencies)).toBeNull();
  });
});
