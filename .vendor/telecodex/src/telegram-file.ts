import { randomUUID } from "node:crypto";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";

const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";
const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type TelegramFileDownloadOptions = {
  apiRoot?: string;
  proxyUrl?: string;
  maxBytes?: number;
};

export async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  options: TelegramFileDownloadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_SIZE;
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }
  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const apiRoot = (options.apiRoot ?? DEFAULT_TELEGRAM_API_ROOT).replace(/\/+$/, "");
  const filePath = file.file_path.replace(/^\/+/, "");
  const url = new URL(`${apiRoot}/file/bot${token}/${filePath}`);

  let buffer: Buffer;
  try {
    buffer = await downloadBuffer(url, options.proxyUrl, maxBytes);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = rawMessage.replaceAll(token, "[redacted-token]");
    throw new Error(`Telegram file download failed: ${safeMessage}`);
  }

  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

async function downloadBuffer(
  url: URL,
  proxyUrl: string | undefined,
  maxBytes: number,
  redirectCount = 0,
): Promise<Buffer> {
  const response = await openResponse(url, proxyUrl);
  const statusCode = response.statusCode ?? 0;
  const location = response.headers.location;

  if (statusCode >= 300 && statusCode < 400 && location) {
    response.resume();
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error("too many redirects");
    }
    return downloadBuffer(new URL(location, url), proxyUrl, maxBytes, redirectCount + 1);
  }

  if (statusCode < 200 || statusCode >= 300) {
    response.resume();
    throw new Error(`HTTP ${statusCode}`);
  }

  const contentLength = Number(response.headers["content-length"] ?? 0);
  if (contentLength > maxBytes) {
    response.resume();
    throw new Error(`file exceeds ${maxBytes} byte limit`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += data.length;
    if (totalBytes > maxBytes) {
      response.destroy();
      throw new Error(`file exceeds ${maxBytes} byte limit`);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks, totalBytes);
}

function openResponse(url: URL, proxyUrl?: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};
    const request = url.protocol === "http:"
      ? httpGet(url, options, resolve)
      : httpsGet(url, options, resolve);
    request.on("error", reject);
  });
}
