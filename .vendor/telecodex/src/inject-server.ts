import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  parseTelemoodPlan,
  type TelemoodInteractionReceipt,
  type TelemoodPlan,
} from "./telemood.js";

const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_INJECT_TEXT_BYTES = 15 * 1024;

export type InjectRequest = {
  chatId: number;
  text: string;
  topicId?: number;
  rollover?: boolean;
  afterRolloverText?: string;
};

export type SendFileRequest = {
  command: "send-file";
  threadId: string;
  chatId: number;
  filePath: string;
  topicId?: number;
  caption?: string;
  mode?: "document" | "photo";
};

export type SendInteractionRequest = {
  command: "send-interaction";
  requestId: string;
  threadId: string;
  turnId: string;
  chatId: number;
  topicId?: number;
  triggerMessageId?: number;
  userId?: number;
  plan: TelemoodPlan;
};

export type InjectResponse =
  | { ok: true; queued: true; contextKey: string; rollover: boolean }
  | { ok: false; error: string };

export type SendFileResponse =
  | {
      ok: true;
      sent: true;
      chatId: number;
      messageId: number;
      fileName: string;
      topicId?: number;
    }
  | { ok: false; error: string };

export type SendInteractionResponse =
  | { ok: true; receipt: TelemoodInteractionReceipt }
  | { ok: false; error: string; receipt?: TelemoodInteractionReceipt };

export type InjectSubmit = (request: InjectRequest) => Promise<InjectResponse>;
export type SendFileSubmit = (request: SendFileRequest) => Promise<SendFileResponse>;
export type SendInteractionSubmit = (
  request: SendInteractionRequest,
) => Promise<SendInteractionResponse>;

export interface TeleCodexInjectServer {
  socketPath: string;
  close(): Promise<void>;
}

export function injectSocketPath(repositoryRoot: string, botKey: string): string {
  return path.join(repositoryRoot, ".telecodex", "run", `inject-${botKey}.sock`);
}

export async function startInjectServer(
  socketPath: string,
  submit: InjectSubmit,
  sendFile?: SendFileSubmit,
  sendInteraction?: SendInteractionSubmit,
): Promise<TeleCodexInjectServer> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const server = createServer((socket) =>
    handleConnection(socket, submit, sendFile, sendInteraction));
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);

  let closePromise: Promise<void> | undefined;
  return {
    socketPath,
    close: () => {
      closePromise ??= closeServer(server, socketPath);
      return closePromise;
    },
  };
}

function handleConnection(
  socket: Socket,
  submit: InjectSubmit,
  sendFile?: SendFileSubmit,
  sendInteraction?: SendInteractionSubmit,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let handled = false;

  const respond = (response: InjectResponse | SendFileResponse | SendInteractionResponse): void => {
    if (handled) return;
    handled = true;
    socket.end(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      respond({ ok: false, error: "Inject request is too large" });
      return;
    }

    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    void processRequest(buffer.slice(0, newline), submit, sendFile, sendInteraction)
      .then(respond)
      .catch((error) =>
        respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  });

  socket.on("error", () => {
    // A disconnected client must not affect the worker.
  });
}

async function processRequest(
  raw: string,
  submit: InjectSubmit,
  sendFile?: SendFileSubmit,
  sendInteraction?: SendInteractionSubmit,
): Promise<InjectResponse | SendFileResponse | SendInteractionResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Inject request is not valid JSON" };
  }

  if (isSendFileCommand(parsed)) {
    const request = normalizeSendFileRequest(parsed);
    if (typeof request === "string") return { ok: false, error: request };
    if (!sendFile) return { ok: false, error: "This worker does not support file sending" };
    return sendFile(request);
  }
  if (isSendInteractionCommand(parsed)) {
    const request = normalizeSendInteractionRequest(parsed);
    if (typeof request === "string") return { ok: false, error: request };
    if (!sendInteraction) return { ok: false, error: "This worker does not support rich interactions" };
    return sendInteraction(request);
  }

  const request = normalizeRequest(parsed);
  if (typeof request === "string") return { ok: false, error: request };
  return submit(request);
}

function isSendInteractionCommand(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).command === "send-interaction",
  );
}

function isSendFileCommand(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).command === "send-file",
  );
}

function normalizeSendFileRequest(record: Record<string, unknown>): SendFileRequest | string {
  const rawChatId = record.chatId;
  const chatId =
    typeof rawChatId === "number"
      ? rawChatId
      : typeof rawChatId === "string" && /^-?\d+$/.test(rawChatId.trim())
        ? Number(rawChatId.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    return "Send-file request needs a numeric chatId";
  }
  if (typeof record.threadId !== "string" || !record.threadId.trim()) {
    return "Send-file request needs a threadId";
  }
  if (record.threadId.length > 200) return "Send-file threadId is too long";
  if (typeof record.filePath !== "string" || !record.filePath.trim()) {
    return "Send-file request needs a filePath";
  }
  if (Buffer.byteLength(record.filePath, "utf8") > 4_096) {
    return "Send-file path is too long";
  }
  if (
    record.topicId !== undefined &&
    (typeof record.topicId !== "number" ||
      !Number.isSafeInteger(record.topicId) ||
      record.topicId <= 0)
  ) {
    return "Send-file topicId must be a positive integer";
  }
  if (record.caption !== undefined && typeof record.caption !== "string") {
    return "Send-file caption must be a string";
  }
  if (typeof record.caption === "string" && record.caption.length > 1_024) {
    return "Send-file caption exceeds 1024 characters";
  }
  if (record.mode !== undefined && record.mode !== "document" && record.mode !== "photo") {
    return "Send-file mode must be document or photo";
  }

  return {
    command: "send-file",
    threadId: record.threadId.trim(),
    chatId,
    filePath: record.filePath.trim(),
    ...(record.topicId !== undefined ? { topicId: record.topicId as number } : {}),
    ...(typeof record.caption === "string" && record.caption
      ? { caption: record.caption }
      : {}),
    ...(record.mode !== undefined ? { mode: record.mode as "document" | "photo" } : {}),
  };
}

function normalizeSendInteractionRequest(
  record: Record<string, unknown>,
): SendInteractionRequest | string {
  const chatId = numericChatId(record.chatId);
  if (chatId === undefined) return "Send-interaction request needs a numeric chatId";
  const requestId = boundedString(record.requestId, 200);
  if (!requestId) return "Send-interaction request needs a requestId";
  const threadId = boundedString(record.threadId, 200);
  if (!threadId) return "Send-interaction request needs a threadId";
  const turnId = boundedString(record.turnId, 200);
  if (!turnId) return "Send-interaction request needs a turnId";
  if (record.topicId !== undefined && !positiveSafeInteger(record.topicId)) {
    return "Send-interaction topicId must be a positive integer";
  }
  if (record.triggerMessageId !== undefined && !positiveSafeInteger(record.triggerMessageId)) {
    return "Send-interaction triggerMessageId must be a positive integer";
  }
  if (record.userId !== undefined && !positiveSafeInteger(record.userId)) {
    return "Send-interaction userId must be a positive integer";
  }
  const parsedPlan = parseTelemoodPlan(record.plan);
  if (!parsedPlan.ok) return `Invalid Telemood plan: ${parsedPlan.error}`;
  return {
    command: "send-interaction",
    requestId,
    threadId,
    turnId,
    chatId,
    ...(record.topicId === undefined ? {} : { topicId: record.topicId as number }),
    ...(record.triggerMessageId === undefined
      ? {}
      : { triggerMessageId: record.triggerMessageId as number }),
    ...(record.userId === undefined ? {} : { userId: record.userId as number }),
    plan: parsedPlan.plan,
  };
}

function normalizeRequest(value: unknown): InjectRequest | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Inject request must be a JSON object";
  }
  const record = value as Record<string, unknown>;
  const rawChatId = record.chatId;
  const chatId =
    typeof rawChatId === "number"
      ? rawChatId
      : typeof rawChatId === "string" && /^-?\d+$/.test(rawChatId.trim())
        ? Number(rawChatId.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    return "Inject request needs a numeric chatId";
  }

  if (typeof record.text !== "string") return "Inject request needs a text string";
  if (!record.text.trim()) return "Inject text is empty";
  if (Buffer.byteLength(record.text, "utf8") > MAX_INJECT_TEXT_BYTES) {
    return `Inject text exceeds ${MAX_INJECT_TEXT_BYTES} bytes`;
  }

  if (
    record.topicId !== undefined &&
    (typeof record.topicId !== "number" ||
      !Number.isSafeInteger(record.topicId) ||
      record.topicId <= 0)
  ) {
    return "Inject topicId must be a positive integer";
  }
  if (record.rollover !== undefined && typeof record.rollover !== "boolean") {
    return "Inject rollover must be a boolean";
  }
  if (record.afterRolloverText !== undefined) {
    if (record.rollover !== true) {
      return "Inject afterRolloverText requires rollover=true";
    }
    if (typeof record.afterRolloverText !== "string" || !record.afterRolloverText.trim()) {
      return "Inject afterRolloverText must be a non-empty string";
    }
    if (Buffer.byteLength(record.afterRolloverText, "utf8") > MAX_INJECT_TEXT_BYTES) {
      return `Inject afterRolloverText exceeds ${MAX_INJECT_TEXT_BYTES} bytes`;
    }
  }

  return {
    chatId,
    text: record.text,
    ...(record.topicId !== undefined ? { topicId: record.topicId as number } : {}),
    ...(record.rollover === true ? { rollover: true } : {}),
    ...(typeof record.afterRolloverText === "string"
      ? { afterRolloverText: record.afterRolloverText }
      : {}),
  };
}

function numericChatId(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => void rm(socketPath, { force: true }).finally(resolve));
  });
}
