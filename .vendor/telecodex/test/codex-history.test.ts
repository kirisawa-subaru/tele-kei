import { describe, expect, it } from "vitest";

import {
  buildPastHistory,
  findLastUserMessage,
  normalizeAppServerHistory,
  parseRolloutJsonl,
} from "../src/codex-history.js";

describe("Codex history", () => {
  it("normalizes completed app-server user and assistant items", () => {
    const turns = normalizeAppServerHistory({
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "userMessage",
              id: "user-1",
              content: [{ type: "text", text: "question", text_elements: [] }],
            },
            { type: "agentMessage", id: "agent-1", text: "answer" },
          ],
        },
        { id: "turn-active", status: "inProgress", items: [] },
      ],
    });

    expect(turns).toEqual([
      {
        turnId: "turn-1",
        messages: [
          { itemId: "user-1", turnId: "turn-1", role: "user", text: "question" },
          { itemId: "agent-1", turnId: "turn-1", role: "assistant", text: "answer" },
        ],
      },
    ]);
  });

  it("parses current rollout message variants", () => {
    const jsonl = [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "agent_message", id: "a1", text: "hi" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", id: "a2", content: [{ type: "output_text", text: "again" }] },
      }),
    ].join("\n");

    expect(parseRolloutJsonl(jsonl, "thread-1")[0]?.messages.map((message) => message.text)).toEqual([
      "hello",
      "hi",
      "again",
    ]);
  });

  it("ignores only a malformed final partial line", () => {
    const first = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "safe" }] },
    });
    expect(parseRolloutJsonl(`${first}\n{"type":"response_`, "thread-1")[0]?.messages[0]?.text).toBe(
      "safe",
    );
    expect(() => parseRolloutJsonl(`${first}\n{bad}\n${first}`, "thread-1")).toThrow(
      "Invalid rollout JSONL at line 2",
    );
  });

  it("builds /past from the latest five full messages after the watermark", () => {
    const turns = Array.from({ length: 7 }, (_, index) => ({
      turnId: `turn-${index}`,
      messages: [
        {
          itemId: `user-${index}`,
          turnId: `turn-${index}`,
          role: "user" as const,
          text: `q${index}`,
        },
        {
          itemId: `agent-${index}`,
          turnId: `turn-${index}`,
          role: "assistant" as const,
          text: index === 4 ? `a4-${"x".repeat(4_500)}` : `a${index}`,
        },
      ],
    }));

    const result = buildPastHistory(turns, "agent-0");

    expect(result.shownMessages).toBe(5);
    expect(result.omittedMessages).toBe(7);
    expect(result.text).toContain("a4-");
    expect(result.text).toContain("x".repeat(4_500));
    expect(result.text).toContain("q5");
    expect(result.text).toContain("a6");
    expect(result.text).not.toContain("q4");
    expect(result.lastItemId).toBe("agent-6");
    expect(result.text.length).toBeGreaterThan(4_000);
  });

  it("selects the requested number of complete messages", () => {
    const turns = Array.from({ length: 8 }, (_, index) => ({
      turnId: `turn-${index}`,
      messages: [
        {
          itemId: `agent-${index}`,
          turnId: `turn-${index}`,
          role: "assistant" as const,
          text: index === 2 ? `long-${"x".repeat(4_500)}` : `answer-${index}`,
        },
      ],
    }));

    const result = buildPastHistory(turns, undefined, { maxMessages: 6 });

    expect(result.shownMessages).toBe(6);
    expect(result.omittedMessages).toBe(2);
    expect(result.text).toContain(`long-${"x".repeat(4_500)}`);
    expect(result.text).not.toContain("answer-1");
    expect(result.lastItemId).toBe("agent-7");
  });

  it("falls back to the retained tail when rollback deleted the watermark item", () => {
    const turns = [
      {
        turnId: "turn-1",
        messages: [
          { itemId: "user-1", turnId: "turn-1", role: "user" as const, text: "question" },
          { itemId: "agent-1", turnId: "turn-1", role: "assistant" as const, text: "answer" },
        ],
      },
    ];

    const result = buildPastHistory(turns, "agent-deleted", { maxMessages: 5 });

    expect(result.text).toBe("你（电脑）：question\n\nCodex：answer");
    expect(result.lastItemId).toBe("agent-1");
  });

  it("finds the full latest user input across turns", () => {
    const turns = normalizeAppServerHistory({
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "first" }] },
            { type: "agentMessage", id: "agent-1", text: "answer" },
          ],
        },
        {
          id: "turn-2",
          status: "completed",
          items: [
            {
              type: "userMessage",
              id: "user-2",
              content: [{ type: "text", text: `latest-${"z".repeat(4_100)}` }],
            },
          ],
        },
      ],
    });

    expect(findLastUserMessage(turns)?.text).toBe(`latest-${"z".repeat(4_100)}`);
  });
});
