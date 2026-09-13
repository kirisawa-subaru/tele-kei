import { connect } from "node:net";

import type { AppServerServerRequest } from "./app-server-rpc.js";
import { parseContextKey } from "./context-key.js";
import {
  injectSocketPath,
  type SendInteractionRequest,
  type SendInteractionResponse,
  type SendFileRequest,
  type SendFileResponse,
} from "./inject-server.js";
import { parseTelemoodPlan, telemoodPlanInputSchema } from "./telemood.js";

export const TELEGRAM_SEND_FILE_TOOL = "telegram.send_file";
export const TELEGRAM_SEND_INTERACTION_TOOL = "telegram.send_interaction";
const TELEGRAM_INTERACTION_WORKER_TIMEOUT_MS = 10 * 60 * 1_000;

export type DynamicToolSpec =
  | {
      type: "function";
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }
  | {
      type: "namespace";
      name: string;
      description: string;
      tools: Array<{
        type: "function";
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    };

export type DynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

export function isSupportedDynamicTool(name: string): boolean {
  return name === TELEGRAM_SEND_FILE_TOOL || name === TELEGRAM_SEND_INTERACTION_TOOL;
}

export function buildDynamicToolSpecs(names: readonly string[]): DynamicToolSpec[] {
  const tools: Array<{
    type: "function";
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [];
  if (names.includes(TELEGRAM_SEND_FILE_TOOL)) {
    tools.push({
      type: "function",
      name: "send_file",
      description: "Send an existing local file to the Telegram conversation that owns this thread. Use only when the user explicitly asks to receive the file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Absolute path of the local file to send.",
          },
          caption: {
            type: "string",
            description: "Optional Telegram caption, at most 1024 characters.",
          },
          mode: {
            type: "string",
            enum: ["document", "photo"],
            description: "Use document by default. Use photo only when an image should preview inline.",
          },
        },
        required: ["path"],
      },
    });
  }
  if (names.includes(TELEGRAM_SEND_INTERACTION_TOOL)) {
    tools.push({
      type: "function",
      name: "send_interaction",
      description: [
        "Send the complete user-visible response as an ordered Telemood plan to this thread's Telegram conversation.",
        "Choose this tool autonomously when native Telegram expression fits the conversation; the user does not need to request the tool or format explicitly.",
        "Use this as the final output action for the turn: put all reply text in bubble actions and do not repeat it afterward.",
        "Include at least one bubble or choices action to complete the visible turn; a reaction alone is non-blocking.",
        "The host binds the trusted destination and user. Sticker actions are not available yet.",
      ].join(" "),
      inputSchema: telemoodPlanInputSchema(),
    });
  }
  if (tools.length === 0) return [];
  return [{
    type: "namespace",
    name: "telegram",
    description: "Actions on the Telegram conversation that owns this Codex thread.",
    tools,
  }];
}

export type DynamicToolHandlerOptions = {
  repositoryRoot: string;
  resolveThreadOwner: (threadId: string) => { botKey: string; contextKey: string } | undefined;
  resolveTurnProvenance: (
    threadId: string,
    turnId: string,
  ) => { senderUserId?: number; chatId: string; messageId?: number; messageThreadId?: number } | undefined;
  enabledToolsForBot: (botKey: string) => readonly string[];
};

export function createDynamicToolRequestHandler(options: DynamicToolHandlerOptions) {
  return async (request: AppServerServerRequest): Promise<DynamicToolCallResponse> => {
    if (request.method !== "item/tool/call") {
      throw new Error(`Unsupported app-server request: ${request.method}`);
    }

    const params = asRecord(request.params);
    const threadId = stringField(params, "threadId");
    const turnId = stringField(params, "turnId");
    const callId = stringField(params, "callId");
    const tool = stringField(params, "tool");
    const namespace = optionalStringField(params, "namespace");
    if (!threadId || !turnId || !callId || !tool) {
      return failure("Malformed dynamic tool call");
    }

    const toolName = namespace ? `${namespace}.${tool}` : tool;
    const owner = options.resolveThreadOwner(threadId);
    if (!owner) return failure(`No Telegram owner is bound to thread ${threadId}`);
    if (!options.enabledToolsForBot(owner.botKey).includes(toolName)) {
      return failure(`Tool ${toolName} is not enabled for bot ${owner.botKey}`);
    }
    if (toolName !== TELEGRAM_SEND_FILE_TOOL && toolName !== TELEGRAM_SEND_INTERACTION_TOOL) {
      return failure(`Unsupported dynamic tool: ${toolName}`);
    }

    if (toolName === TELEGRAM_SEND_INTERACTION_TOOL) {
      const parsedPlan = parseTelemoodPlan(params.arguments);
      if (!parsedPlan.ok) return failure(`Invalid Telemood plan: ${parsedPlan.error}`);

      const provenance = options.resolveTurnProvenance(threadId, turnId);
      const needsReaction = parsedPlan.plan.actions.some((action) => action.type === "reaction");
      const needsChoices = parsedPlan.plan.actions.some((action) => action.type === "choices");
      if (!provenance && (needsReaction || needsChoices)) {
        return failure("This turn has no trusted Telegram provenance for reactions or choices");
      }
      const address = parseContextKey(owner.contextKey);
      if (provenance && provenance.chatId !== String(address.chatId)) {
        return failure("Trusted turn provenance does not match the thread's Telegram owner");
      }
      if (provenance && provenance.messageThreadId !== address.messageThreadId) {
        return failure("Trusted turn topic does not match the thread's Telegram owner");
      }
      if (needsReaction && !provenance?.messageId) {
        return failure("Reaction requires a trusted triggering Telegram message");
      }
      if (needsChoices && !provenance?.senderUserId) {
        return failure("Choices require a trusted triggering Telegram user");
      }

      const workerRequest: SendInteractionRequest = {
        command: "send-interaction",
        requestId: callId,
        threadId,
        turnId,
        chatId: address.chatId,
        plan: parsedPlan.plan,
        ...(address.messageThreadId ? { topicId: address.messageThreadId } : {}),
        ...(provenance?.messageId ? { triggerMessageId: provenance.messageId } : {}),
        ...(provenance?.senderUserId ? { userId: provenance.senderUserId } : {}),
      };
      try {
        const response = await requestWorker<SendInteractionRequest, SendInteractionResponse>(
          injectSocketPath(options.repositoryRoot, owner.botKey),
          workerRequest,
          TELEGRAM_INTERACTION_WORKER_TIMEOUT_MS,
        );
        if (!response.ok) {
          const status = response.receipt?.receipts.at(-1)?.status;
          const uncertain = status === "UNCERTAIN" || status === "UNKNOWN";
          return failure(
            uncertain
              ? `Telegram interaction outcome is ${status}; do not retry automatically: ${response.error}`
              : response.error,
          );
        }
        return success(
          `Telegram interaction ${response.receipt.requestId} completed with ` +
            `${response.receipt.receipts.length} verified action(s).`,
        );
      } catch (error) {
        return failure(
          `Telegram interaction outcome is UNCERTAIN; do not retry automatically: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const args = asRecord(params.arguments);
    const filePath = stringField(args, "path");
    const caption = optionalStringField(args, "caption");
    const mode = optionalStringField(args, "mode") ?? "document";
    if (!filePath) return failure("telegram.send_file requires an absolute path");
    if (mode !== "document" && mode !== "photo") {
      return failure("telegram.send_file mode must be document or photo");
    }

    const address = parseContextKey(owner.contextKey);
    const workerRequest: SendFileRequest = {
      command: "send-file",
      threadId,
      chatId: address.chatId,
      filePath,
      mode,
      ...(address.messageThreadId ? { topicId: address.messageThreadId } : {}),
      ...(caption ? { caption } : {}),
    };

    try {
      const response = await requestWorker<SendFileRequest, SendFileResponse>(
        injectSocketPath(options.repositoryRoot, owner.botKey),
        workerRequest,
      );
      if (!response.ok) return failure(response.error);
      return success(
        `Telegram accepted ${response.fileName} via bot ${owner.botKey}` +
          ` (chat ${response.chatId}, message ${response.messageId}).`,
      );
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };
}

function requestWorker<TRequest, TResponse>(
  socketPath: string,
  request: TRequest,
  timeoutMs = 65_000,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let buffer = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("timeout", () => fail(new Error("Telegram worker request timed out")));
    socket.on("error", fail);
    socket.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) {
        fail(new Error("Telegram worker response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      settled = true;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as TResponse);
      } catch {
        reject(new Error("Telegram worker returned malformed JSON"));
      }
    });
    socket.on("close", () => {
      if (!settled) fail(new Error("Telegram worker closed without a response"));
    });
  });
}

function success(text: string): DynamicToolCallResponse {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}

function failure(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}
