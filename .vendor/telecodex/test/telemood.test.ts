import { describe, expect, it } from "vitest";

import { parseTelemoodPlan, telemoodPlanInputSchema } from "../src/telemood.js";

describe("Telemood plan contract", () => {
  it("preserves the model supplied action order", () => {
    const parsed = parseTelemoodPlan({
      version: "telemood.plan.v1",
      actions: [
        { type: "bubble", text: "first" },
        { type: "reaction", target: "trigger_message", emoji: "❤" },
        {
          type: "choices",
          prompt: "Continue?",
          options: [
            { key: "yes", label: "Yes" },
            { key: "no", label: "No" },
          ],
        },
      ],
    });

    expect(parsed).toMatchObject({
      ok: true,
      plan: { actions: [{ type: "bubble" }, { type: "reaction" }, { type: "choices" }] },
    });
  });

  it("rejects unknown fields and duplicate choice keys", () => {
    expect(parseTelemoodPlan({
      version: "telemood.plan.v1",
      actions: [{ type: "bubble", text: "hello", chat_id: 123 }],
    })).toEqual({ ok: false, error: "actions[0]: bubble contains unknown fields" });

    expect(parseTelemoodPlan({
      version: "telemood.plan.v1",
      actions: [{
        type: "choices",
        prompt: "Pick",
        options: [
          { key: "same", label: "One" },
          { key: "same", label: "Two" },
        ],
      }],
    })).toEqual({ ok: false, error: "actions[0]: choices option key same is duplicated" });
  });

  it("rejects forbidden controls, untrimmed choice text, and endpoint-like sticker ids", () => {
    expect(parseTelemoodPlan({
      version: "telemood.plan.v1",
      actions: [{ type: "bubble", text: "bad\u0000text" }],
    })).toMatchObject({ ok: false, error: expect.stringContaining("control characters") });
    expect(parseTelemoodPlan({
      version: "telemood.plan.v1",
      actions: [{
        type: "choices",
        prompt: " Pick ",
        options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
      }],
    })).toMatchObject({ ok: false, error: expect.stringContaining("trimmed") });
    expect(parseTelemoodPlan({
      version: "telemood.plan.v1",
      actions: [{ type: "sticker", sticker: { kind: "catalog", id: "https://example.test/x" } }],
    })).toMatchObject({ ok: false, error: expect.stringContaining("logical catalog reference") });
  });

  it("does not advertise sticker actions before a trusted catalog exists", () => {
    const schema = telemoodPlanInputSchema();
    expect(JSON.stringify(schema)).not.toContain('"sticker"');
  });
});
