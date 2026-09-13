import { describe, expect, it, vi } from "vitest";

import {
  buildSessionKeyboard,
  createNewThreadInMainWorkspace,
  getSessionPage,
  renderSessionDetailsPage,
  SerialTaskQueue,
  splitTelegramPlainText,
  TELEGRAM_RETRY_MAX_DELAY_SECONDS,
} from "../src/bot.js";
import type { CodexSessionInfo } from "../src/codex-session.js";
import type { CodexThreadRecord } from "../src/codex-state.js";

describe("phone session UX", () => {
  it("creates /new threads in the configured main workspace", async () => {
    const info = {} as CodexSessionInfo;
    const newThread = vi.fn(async () => info);

    await expect(
      createNewThreadInMainWorkspace({ newThread }, "/Users/tester/development/main-repo"),
    ).resolves.toBe(info);
    expect(newThread).toHaveBeenCalledOnce();
    expect(newThread).toHaveBeenCalledWith("/Users/tester/development/main-repo");
  });

  it("keeps the session details button on the current page", () => {
    const buttons = Array.from({ length: 8 }, (_, index) => ({
      label: `session ${index + 1}`,
      callbackData: `sess_${index}`,
    }));

    const keyboard = buildSessionKeyboard(buttons, 1);
    expect(keyboard.inline_keyboard.at(-1)).toEqual([
      { text: "显示", callback_data: "sess_show_1" },
    ]);
  });

  it("renders exactly the current six-session page with full details", () => {
    const sessions = Array.from({ length: 8 }, (_, index): CodexThreadRecord => ({
      id: `thread-${index + 1}`,
      name: index === 6 ? "手动名称" : "",
      title: `title ${index + 1}`,
      cwd: `/Users/tester/development/project-${index + 1}`,
      model: null,
      createdAt: new Date("2026-08-21T01:00:00.000Z"),
      updatedAt: new Date(`2026-08-21T0${index}:00:00.000Z`),
      firstUserMessage: `first ${index + 1}`,
    }));
    const page = getSessionPage(sessions, 1);
    const longInput = `latest-${"x".repeat(4_100)}`;
    const text = renderSessionDetailsPage(
      page.map((session, index) => ({ session, lastInput: index === 0 ? longInput : "last 8" })),
      1,
    );

    expect(page.map((session) => session.id)).toEqual(["thread-7", "thread-8"]);
    expect(text).toContain("7. 2026-08-21T06:00:00.000Z");
    expect(text).toContain("文件夹：/Users/tester/development/project-7");
    expect(text).toContain("名称：手动名称");
    expect(text).toContain(longInput);
    expect(text).toContain("8. 2026-08-21T07:00:00.000Z");
    expect(text).not.toContain("project-6");
  });
});

describe("Telegram delivery primitives", () => {
  it("allows Telegram's ordinary flood-control backoff window", () => {
    expect(TELEGRAM_RETRY_MAX_DELAY_SECONDS).toBeGreaterThanOrEqual(32);
  });

  it("splits long plain text without truncating it", () => {
    const text = `${"x".repeat(3_999)}😀${"y".repeat(4_100)}`;
    const chunks = splitTelegramPlainText(text);

    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.every((chunk) => !containsUnpairedSurrogate(chunk))).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("serializes a final edit behind an in-flight preview edit", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });

    const preview = queue.run(async () => {
      order.push("preview-start");
      await previewGate;
      order.push("preview-end");
    });
    const final = queue.run(async () => {
      order.push("final");
    });

    await vi.waitFor(() => expect(order).toEqual(["preview-start"]));
    releasePreview();
    await Promise.all([preview, final]);
    expect(order).toEqual(["preview-start", "preview-end", "final"]);
  });
});

function containsUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
