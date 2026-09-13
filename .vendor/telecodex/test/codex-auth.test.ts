import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

let checkAuthStatus: typeof import("../src/codex-auth.js").checkAuthStatus;

// Helper to make mockExecFile call its callback with success
function mockExecSuccess(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, stdout, stderr);
  });
}

// Helper to make mockExecFile call its callback with a non-zero exit error
function mockExecFailure(stderr: string, stdout = "", code?: string): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const error = new Error("Command failed") as Error & { stderr?: string; stdout?: string; code?: string };
    error.stderr = stderr;
    error.stdout = stdout;
    if (code) {
      error.code = code;
    }
    cb(error, stdout, stderr);
  });
}

// Helper to make mockExecFile throw (ENOENT — command not found)
function mockExecNotFound(): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    cb(error, "", "");
  });
}

describe("codex-auth", () => {
  beforeEach(async () => {
    mockExecFile.mockReset();
    vi.resetModules();
    ({ checkAuthStatus } = await import("../src/codex-auth.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkAuthStatus", () => {
    it("reports authenticated when API key is provided", async () => {
      const status = await checkAuthStatus("sk-test-key");
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("api-key");
      expect(status.detail).toContain("CODEX_API_KEY");
      // Should not call CLI when API key is present
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("reports authenticated when CLI auth succeeds", async () => {
      mockExecSuccess("Logged in as user@example.com");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toContain("user@example.com");
    });

    it("reports unauthenticated when CLI auth fails", async () => {
      mockExecFailure("Not logged in");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("Not logged in");
    });

    it("reports unauthenticated when CLI is not found", async () => {
      mockExecNotFound();

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("not found");
    });

    it("handles command timeout (signal termination)", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const error = new Error("Command timed out") as Error & { signal?: string; stderr?: string; stdout?: string };
        error.signal = "SIGTERM";
        error.stderr = "";
        error.stdout = "";
        cb(error, "", "");
      });

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("SIGTERM");
    });

    it("handles empty CLI output gracefully", async () => {
      mockExecSuccess("");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toBe("Authenticated via Codex CLI");
    });

    it("caches results across calls", async () => {
      mockExecSuccess("Logged in");

      const first = await checkAuthStatus();
      const second = await checkAuthStatus();

      expect(first).toEqual(second);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

  });
});
