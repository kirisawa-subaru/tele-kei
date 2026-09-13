import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import type { Context } from "grammy";
import { afterEach, describe, expect, it } from "vitest";

import { downloadTelegramFile } from "../src/telegram-file.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((filePath) => unlink(filePath).catch(() => {})));
});

describe("downloadTelegramFile", () => {
  it("uses the configured Telegram API root for the file request", async () => {
    const payload = Buffer.from("telegram-photo");
    let requestedPath = "";
    const server = createServer((request, response) => {
      requestedPath = request.url ?? "";
      response.writeHead(200, { "content-length": payload.length });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const api = {
        getFile: async () => ({ file_path: "photos/test.jpg", file_size: payload.length }),
      } as unknown as Context["api"];
      const filePath = await downloadTelegramFile(api, "token", "file-id", {
        apiRoot: `http://127.0.0.1:${port}`,
      });
      tempPaths.push(filePath);

      expect(requestedPath).toBe("/file/bottoken/photos/test.jpg");
      expect(await readFile(filePath)).toEqual(payload);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects Telegram metadata that exceeds the configured limit before downloading", async () => {
    const api = {
      getFile: async () => ({ file_path: "photos/large.jpg", file_size: 101 }),
    } as unknown as Context["api"];

    await expect(
      downloadTelegramFile(api, "token", "file-id", { maxBytes: 100 }),
    ).rejects.toThrow("Telegram file too large");
  });
});
