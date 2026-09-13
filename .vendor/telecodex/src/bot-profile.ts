import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isSupportedDynamicTool } from "./dynamic-tools.js";

export interface BotProfileDefaults {
  workspace?: string;
  model?: string;
  developerInstructions?: string;
  dynamicToolNames?: string[];
}

type BotProfileFile = {
  default_workspace?: unknown;
  default_model?: unknown;
  system_instructions?: unknown;
  dynamic_tools?: unknown;
};

export function loadBotProfileDefaults(
  repositoryRoot: string,
  botKey: string,
): BotProfileDefaults {
  const profileDirectory = path.join(repositoryRoot, "profiles", botKey);
  const profilePath = path.join(profileDirectory, "profile.json");
  if (!existsSync(profilePath)) return {};

  let parsed: BotProfileFile;
  try {
    parsed = JSON.parse(readFileSync(profilePath, "utf8")) as BotProfileFile;
  } catch (error) {
    throw new Error(`Invalid bot profile ${profilePath}: ${formatError(error)}`);
  }

  const workspaceValue = optionalString(parsed.default_workspace, "default_workspace", profilePath);
  const model = optionalString(parsed.default_model, "default_model", profilePath);
  const dynamicToolNames = optionalDynamicTools(parsed.dynamic_tools, profilePath);
  const implicitSystemPath = path.join(profileDirectory, "SYSTEM.md");
  const systemFile = parsed.system_instructions === undefined
    ? (existsSync(implicitSystemPath) ? "SYSTEM.md" : undefined)
    : optionalString(parsed.system_instructions, "system_instructions", profilePath);
  let developerInstructions: string | undefined;
  if (systemFile) {
    const systemPath = resolveInside(profileDirectory, systemFile, profilePath);
    if (!existsSync(systemPath)) {
      throw new Error(`Bot profile system instructions do not exist: ${systemPath}`);
    }
    developerInstructions = readFileSync(systemPath, "utf8").trim();
    if (!developerInstructions) {
      throw new Error(`Bot profile system instructions are empty: ${systemPath}`);
    }
  }

  return {
    ...(workspaceValue
      ? { workspace: path.isAbsolute(workspaceValue) ? workspaceValue : path.resolve(repositoryRoot, workspaceValue) }
      : {}),
    ...(model ? { model } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(dynamicToolNames.length ? { dynamicToolNames } : {}),
  };
}

function optionalDynamicTools(value: unknown, profilePath: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid dynamic_tools in bot profile ${profilePath}: expected an array`);
  }

  const names = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(
        `Invalid dynamic_tools in bot profile ${profilePath}: expected non-empty strings`,
      );
    }
    const name = entry.trim();
    if (!isSupportedDynamicTool(name)) {
      throw new Error(`Unsupported dynamic tool ${name} in bot profile ${profilePath}`);
    }
    return name;
  });
  return [...new Set(names)];
}

function optionalString(value: unknown, field: string, profilePath: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${field} in bot profile ${profilePath}: expected a non-empty string`);
  }
  return value.trim();
}

function resolveInside(directory: string, relativePath: string, profilePath: string): string {
  const resolved = path.resolve(directory, relativePath);
  const prefix = `${path.resolve(directory)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`Invalid system_instructions in bot profile ${profilePath}: path leaves profile directory`);
  }
  return resolved;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
