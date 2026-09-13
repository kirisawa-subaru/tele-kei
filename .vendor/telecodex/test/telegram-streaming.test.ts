import { describe, expect, it } from "vitest";

import {
  countStreamingCharacters,
  hasCompleteStreamingChunk,
  STREAMING_CHUNK_SIZE,
} from "../src/bot.js";

describe("Telegram streaming chunks", () => {
  it("waits for 100 characters before publishing", () => {
    expect(STREAMING_CHUNK_SIZE).toBe(100);
    expect(hasCompleteStreamingChunk(99, 0)).toBe(false);
    expect(hasCompleteStreamingChunk(100, 0)).toBe(true);
    expect(hasCompleteStreamingChunk(199, 100)).toBe(false);
    expect(hasCompleteStreamingChunk(200, 100)).toBe(true);
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(countStreamingCharacters("你a🦊")).toBe(3);
  });
});
