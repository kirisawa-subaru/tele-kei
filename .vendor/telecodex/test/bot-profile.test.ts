import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBotProfileDefaults } from "../src/bot-profile.js";

describe("bot profiles", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows a dynamic-tools-only profile without duplicating system instructions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecodex-profile-"));
    directories.push(root);
    const profileDir = path.join(root, "profiles", "main");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, "profile.json"), JSON.stringify({
      dynamic_tools: ["telegram.send_interaction"],
    }));

    expect(loadBotProfileDefaults(root, "main")).toEqual({
      dynamicToolNames: ["telegram.send_interaction"],
    });
  });

  it("keeps the implicit SYSTEM.md convention when that file exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecodex-profile-"));
    directories.push(root);
    const profileDir = path.join(root, "profiles", "study");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, "profile.json"), "{}");
    writeFileSync(path.join(profileDir, "SYSTEM.md"), "Study instructions\n");

    expect(loadBotProfileDefaults(root, "study")).toEqual({
      developerInstructions: "Study instructions",
    });
  });
});
