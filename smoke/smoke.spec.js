const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");
const zlib = require("zlib");

const CHAT = process.env.SMOKE_CHAT;
const BOT_USERNAME = process.env.SMOKE_BOT_USERNAME?.replace(/^@/, "");
const TURN_TIMEOUT = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 4 * 60 * 1000);

function addressed(text) {
  if (!BOT_USERNAME) {
    throw new Error("Set SMOKE_BOT_USERNAME for group smoke tests");
  }
  return `@${BOT_USERNAME} ${text}`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function makeSmokePng(width = 160, height = 120) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB

  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    pixels[y * stride] = 0; // PNG filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      pixels[offset] = 0x67;
      pixels[offset + 1] = 0x50;
      pixels[offset + 2] = 0xa4;
    }
  }

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SMOKE_PNG = makeSmokePng();

test.beforeEach(async ({ page }) => {
  test.skip(!CHAT, "Set SMOKE_CHAT (e.g. @your_bot) first");
  await tg.openChat(page, CHAT);
});

test("text roundtrip: reply arrives and echoes the marker", async ({ page }) => {
  const marker = `smoke-${Date.now()}`;
  const before = await tg.incomingCount(page);
  const sent = await tg.sendText(
    page,
    addressed(`[smoke] reply with exactly: pong ${marker}`),
  );
  const reply = await tg.waitForIncomingContaining(page, before, marker, TURN_TIMEOUT);
  const text = await tg.messageText(reply.message);
  expect(text).toContain(marker);
  console.log(
    `SMOKE_METRIC roundtrip send_to_final_flush_ms=${reply.seenAt - sent.sentAt} reply_chars=${text.length}`,
  );
});

test("typing indicator shows while the turn is active", async ({ page }) => {
  const marker = `typing-${Date.now()}`;
  const before = await tg.incomingCount(page);
  const sent = await tg.sendText(
    page,
    addressed(`[smoke] reply with about 250 plain-text characters and end exactly with: ${marker}`),
  );
  const typingPromise = tg.waitForTyping(page, sent.sentAt, 30_000);
  const replyPromise = tg.waitForIncomingContaining(
    page,
    before,
    marker,
    TURN_TIMEOUT,
  );
  // Drain the turn so the next test starts from an idle bridge.
  const [typing, reply] = await Promise.all([typingPromise, replyPromise]);
  console.log(
    `SMOKE_METRIC typing send_to_typing_ms=${typing.elapsedMs} send_to_final_flush_ms=${reply.seenAt - sent.sentAt}`,
  );
});

test("durable final: long reply arrives complete", async ({ page }) => {
  const marker = `stream-begin-${Date.now()}`;
  const tailMarker = `stream-tail-${Date.now()}`;
  const before = await tg.incomingCount(page);
  const sent = await tg.sendText(
    page,
    addressed(`[smoke] begin exactly with ${marker}, then reply with about 600 characters of plain filler prose, no formatting, and end exactly with ${tailMarker}`),
  );
  const reply = await tg.waitForIncomingContaining(page, before, tailMarker, TURN_TIMEOUT);
  const text = await tg.messageText(reply.message);
  expect(text.length).toBeGreaterThan(300);
  expect(text.trimEnd().endsWith(tailMarker)).toBe(true);
  console.log(
    `SMOKE_METRIC durable_final send_to_final_flush_ms=${reply.seenAt - sent.sentAt} final_chars=${text.length} tail_marker_rendered=${text.trimEnd().endsWith(tailMarker)}`,
  );
});

test("image inbound (opt-in: SMOKE_IMAGE=1)", async ({ page }) => {
  test.skip(!process.env.SMOKE_IMAGE, "opt-in via SMOKE_IMAGE=1");
  const marker = `image-${Date.now()}`;
  const before = await tg.incomingCount(page);
  const sent = await tg.sendImage(page, {
    name: "smoke.png",
    mimeType: "image/png",
    buffer: SMOKE_PNG,
  }, addressed(`[smoke] reply with exactly: ${marker}`));
  const reply = await tg.waitForIncomingContaining(page, before, marker, TURN_TIMEOUT);
  const text = await tg.messageText(reply.message);
  expect(text.length).toBeGreaterThan(0);
  console.log(
    `SMOKE_METRIC image send_to_final_flush_ms=${reply.seenAt - sent.sentAt} reply_chars=${text.length}`,
  );
});
