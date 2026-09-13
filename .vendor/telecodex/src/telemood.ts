// TypeScript host adaptation of beniedev/telemood v0.1.0 plan semantics.
// See THIRD_PARTY_NOTICES.md for the upstream MIT notice.
// TeleCodex intentionally omits sticker delivery until it has a trusted catalog.

export const TELEMOOD_PLAN_VERSION = "telemood.plan.v1";
export const TELEMOOD_CALLBACK_TTL_MS = 30 * 60 * 1_000;

export type TelemoodBubbleAction = {
  type: "bubble";
  text: string;
};

export type TelemoodReactionAction = {
  type: "reaction";
  target: "trigger_message";
  emoji: string;
};

export type TelemoodChoiceOption = {
  key: string;
  label: string;
};

export type TelemoodChoicesAction = {
  type: "choices";
  prompt: string;
  options: TelemoodChoiceOption[];
};

export type TelemoodStickerAction = {
  type: "sticker";
  sticker: {
    kind: "catalog";
    id: string;
  };
};

export type TelemoodAction =
  | TelemoodBubbleAction
  | TelemoodReactionAction
  | TelemoodChoicesAction
  | TelemoodStickerAction;

export type TelemoodPlan = {
  version: typeof TELEMOOD_PLAN_VERSION;
  actions: TelemoodAction[];
};

export type TelemoodDeliveryStatus = "VERIFIED" | "FAILED" | "UNCERTAIN" | "UNKNOWN";

export type TelemoodActionReceipt = {
  requestId: string;
  actionIndex: number;
  actionType: TelemoodAction["type"];
  status: TelemoodDeliveryStatus;
  blocking: boolean;
  verifiedVisibleCompletion: boolean;
  providerDeliveryId?: string;
  callbackExpiresAt?: number;
  detail?: string;
};

export type TelemoodInteractionReceipt = {
  requestId: string;
  completed: boolean;
  visibleCompletion: boolean;
  receipts: TelemoodActionReceipt[];
  stoppedAt?: number;
  unexecutedCount: number;
};

export type ParsedTelemoodPlan =
  | { ok: true; plan: TelemoodPlan }
  | { ok: false; error: string };

export function parseTelemoodPlan(value: unknown): ParsedTelemoodPlan {
  const root = asRecord(value);
  if (!root || !hasOnlyKeys(root, ["version", "actions"])) {
    return invalid("plan must contain only version and actions");
  }
  if (root.version !== TELEMOOD_PLAN_VERSION) {
    return invalid(`version must be ${TELEMOOD_PLAN_VERSION}`);
  }
  if (!Array.isArray(root.actions) || root.actions.length === 0) {
    return invalid("actions must contain at least one action");
  }

  const actions: TelemoodAction[] = [];
  for (const [index, valueAction] of root.actions.entries()) {
    const action = parseAction(valueAction);
    if (typeof action === "string") return invalid(`actions[${index}]: ${action}`);
    actions.push(action);
  }
  return { ok: true, plan: { version: TELEMOOD_PLAN_VERSION, actions } };
}

export function telemoodPlanInputSchema(): Record<string, unknown> {
  const bubble = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", const: "bubble" },
      text: { type: "string", minLength: 1 },
    },
    required: ["type", "text"],
  };
  const reaction = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", const: "reaction" },
      target: { type: "string", const: "trigger_message" },
      emoji: { type: "string", minLength: 1, maxLength: 32 },
    },
    required: ["type", "target", "emoji"],
  };
  const choices = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", const: "choices" },
      prompt: { type: "string", minLength: 1 },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
          },
          required: ["key", "label"],
        },
      },
    },
    required: ["type", "prompt", "options"],
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      version: { type: "string", const: TELEMOOD_PLAN_VERSION },
      actions: {
        type: "array",
        minItems: 1,
        items: { oneOf: [bubble, reaction, choices] },
      },
    },
    required: ["version", "actions"],
  };
}

function parseAction(value: unknown): TelemoodAction | string {
  const action = asRecord(value);
  if (!action || typeof action.type !== "string") return "action must be an object with a type";
  if (action.type === "bubble") {
    if (!hasOnlyKeys(action, ["type", "text"])) return "bubble contains unknown fields";
    if (typeof action.text !== "string" || !action.text.trim()) return "bubble text must be non-empty";
    if (hasForbiddenControls(action.text, true)) return "bubble text must not contain control characters";
    return { type: "bubble", text: action.text };
  }
  if (action.type === "reaction") {
    if (!hasOnlyKeys(action, ["type", "target", "emoji"])) return "reaction contains unknown fields";
    if (action.target !== "trigger_message") return "reaction target must be trigger_message";
    if (!validTrimmedText(action.emoji)) {
      return "reaction emoji must be trimmed non-empty text without control characters";
    }
    if (Array.from(action.emoji).length > 32) return "reaction emoji exceeds 32 characters";
    return { type: "reaction", target: "trigger_message", emoji: action.emoji.trim() };
  }
  if (action.type === "choices") {
    if (!hasOnlyKeys(action, ["type", "prompt", "options"])) return "choices contains unknown fields";
    if (!validTrimmedText(action.prompt)) {
      return "choices prompt must be trimmed non-empty text without control characters";
    }
    if (!Array.isArray(action.options) || action.options.length < 2 || action.options.length > 4) {
      return "choices must contain 2-4 options";
    }
    const options: TelemoodChoiceOption[] = [];
    const keys = new Set<string>();
    for (const [index, valueOption] of action.options.entries()) {
      const option = asRecord(valueOption);
      if (!option || !hasOnlyKeys(option, ["key", "label"])) {
        return `choices option ${index} contains unknown fields`;
      }
      if (!validChoiceText(option.key) || !validChoiceText(option.label)) {
        return `choices option ${index} key and label must be trimmed non-empty text without control characters`;
      }
      if (keys.has(option.key)) return `choices option key ${option.key} is duplicated`;
      keys.add(option.key);
      options.push({ key: option.key, label: option.label });
    }
    return { type: "choices", prompt: action.prompt, options };
  }
  if (action.type === "sticker") {
    if (!hasOnlyKeys(action, ["type", "sticker"])) return "sticker contains unknown fields";
    const sticker = asRecord(action.sticker);
    if (!sticker || !hasOnlyKeys(sticker, ["kind", "id"])) return "sticker contains unknown fields";
    if (sticker.kind !== "catalog") return "sticker kind must be catalog";
    if (!validTrimmedText(sticker.id)) {
      return "sticker id must be trimmed non-empty text without control characters";
    }
    if (sticker.id.includes("://")) return "sticker id must be a logical catalog reference";
    return { type: "sticker", sticker: { kind: "catalog", id: sticker.id } };
  }
  return `unsupported action type ${action.type}`;
}

function validChoiceText(value: unknown): value is string {
  return validTrimmedText(value);
}

function validTrimmedText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !hasForbiddenControls(value, false);
}

function hasForbiddenControls(value: string, allowLayout: boolean): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 127) return true;
    if (codePoint >= 32) return false;
    return !(allowLayout && (character === "\n" || character === "\r" || character === "\t"));
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function invalid(error: string): ParsedTelemoodPlan {
  return { ok: false, error };
}
