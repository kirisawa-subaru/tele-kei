import { describe, expect, it, vi } from "vitest";

import { createBot, SKILL_PENDING_TTL_MS } from "../src/bot.js";
import type { CodexSkill } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

function createConfig(): TeleCodexConfig {
  return {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "test-key",
    codexBackend: "app-server",
    codexAppServerSocket: "/tmp/codex-app-server.sock",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    toolVerbosity: "none",
    showTurnTokenUsage: false,
    enableTelegramReactions: false,
  };
}

function userSkill(index: number): CodexSkill {
  return {
    name: `skill-${index}`,
    description: `Description for skill ${index}`,
    path: `/tmp/codex-home/skills/skill-${index}/SKILL.md`,
    scope: "user",
    enabled: true,
  };
}

function commandUpdate(text: string, updateId = 1, messageId = 10) {
  const commandLength = text.split(/\s/, 1)[0]?.length ?? text.length;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
      entities: [{ offset: 0, length: commandLength, type: "bot_command" as const }],
    },
  };
}

function textUpdate(text: string, updateId = 2, messageId = 11) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_001,
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
    },
  };
}

function callbackUpdate(data: string, updateId = 3, messageId = 20) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: "test-chat",
      from: { id: 123, is_bot: false, first_name: "Ada" },
      data,
      message: {
        message_id: messageId,
        date: 1_700_000_002,
        chat: { id: 123, type: "private" as const, first_name: "Ada" },
        text: "picker",
      },
    },
  };
}

function createHarness(options: { skills?: CodexSkill[]; busy?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const callbackAnswers: Array<Record<string, unknown>> = [];
  const replyMarkupEdits: Array<Record<string, unknown>> = [];
  const textEdits: Array<Record<string, unknown>> = [];
  const session = {
    getInfo: vi.fn(() => ({ threadId: "thread-main", workspace: "/workspace", model: "gpt-5.4" })),
    hasActiveThread: vi.fn(() => true),
    isProcessing: vi.fn(() => options.busy ?? false),
    canSteer: vi.fn(() => false),
    listSkills: vi.fn(async () => options.skills ?? [userSkill(1)]),
    compactThread: vi.fn(async () => {}),
    prompt: vi.fn(async (_input: unknown, callbacks: { onTextDelta: (delta: string) => void; onAgentEnd: () => void }) => {
      callbacks.onTextDelta("done");
      callbacks.onAgentEnd();
    }),
    steer: vi.fn(async () => true),
  };
  const registry = {
    onRemove: vi.fn(),
    getOrCreate: vi.fn(async () => session),
    get: vi.fn(() => session),
    updateMetadata: vi.fn(),
    resolveReplyRoute: vi.fn(() => undefined),
    markPastDelivered: vi.fn(),
  };
  const bot = createBot(createConfig(), registry as never);
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "TeleCodex",
    username: "telecodex_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  bot.api.config.use(async (_previous, method, payload) => {
    const record = payload as Record<string, unknown>;
    if (method === "sendMessage") {
      sent.push(record);
      return { ok: true, result: { message_id: 100 + sent.length } };
    }
    if (method === "answerCallbackQuery") callbackAnswers.push(record);
    if (method === "editMessageReplyMarkup") replyMarkupEdits.push(record);
    if (method === "editMessageText") textEdits.push(record);
    return { ok: true, result: true };
  });
  return { bot, session, registry, sent, callbackAnswers, replyMarkupEdits, textEdits };
}

function keyboardRows(payload: Record<string, unknown>) {
  return ((payload.reply_markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard ?? []);
}

function callbackData(payload: Record<string, unknown>, label: string): string {
  const buttons = keyboardRows(payload).flat() as Array<{ text?: string; callback_data?: string }>;
  const button = buttons.find((candidate) => candidate.text === label);
  if (!button?.callback_data) throw new Error(`Missing callback button: ${label}`);
  return button.callback_data;
}

async function selectFirstSkill(harness: ReturnType<typeof createHarness>): Promise<Record<string, unknown>> {
  await harness.bot.handleUpdate(commandUpdate("/skill"));
  const pick = callbackData(harness.sent[0]!, "skill-1 — Description for skill 1");
  await harness.bot.handleUpdate(callbackUpdate(pick));
  return harness.sent.at(-1)!;
}

describe("/skill command", () => {
  it("renders six skills per page and redraws a token-bound second page", async () => {
    const harness = createHarness({ skills: Array.from({ length: 7 }, (_, index) => userSkill(index + 1)) });

    await harness.bot.handleUpdate(commandUpdate("/skill"));

    const firstKeyboard = harness.sent[0]!;
    expect(keyboardRows(firstKeyboard)).toHaveLength(7);
    expect(callbackData(firstKeyboard, "skill-1 — Description for skill 1")).toMatch(
      /^skill_pick:[a-f0-9]{8}:0$/,
    );
    const next = callbackData(firstKeyboard, "Next ▶️");
    expect(next).toMatch(/^skill:[a-f0-9]{8}_page_1$/);

    await harness.bot.handleUpdate(callbackUpdate(next));

    const editedKeyboard = harness.replyMarkupEdits.at(-1)!;
    expect(callbackData(editedKeyboard, "skill-7 — Description for skill 7")).toMatch(
      /^skill_pick:[a-f0-9]{8}:6$/,
    );
  });

  it("sends the selected skill and next message together before reply routing", async () => {
    const harness = createHarness();
    await selectFirstSkill(harness);

    await harness.bot.handleUpdate(textUpdate("last seven days"));
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledOnce());

    const input = harness.session.prompt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      text: "last seven days",
      skill: { name: "skill-1", path: "/tmp/codex-home/skills/skill-1/SKILL.md" },
      provenance: { transport: "telegram", chatId: "123", messageId: 11 },
    });
    expect(harness.registry.resolveReplyRoute).not.toHaveBeenCalled();
  });

  it("supports direct run with no text arguments", async () => {
    const harness = createHarness();
    const confirmation = await selectFirstSkill(harness);

    await harness.bot.handleUpdate(callbackUpdate(callbackData(confirmation, "直接运行"), 4, 101));
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledOnce());

    const input = harness.session.prompt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      skill: { name: "skill-1", path: "/tmp/codex-home/skills/skill-1/SKILL.md" },
      provenance: { transport: "telegram", chatId: "123" },
    });
    expect(input).not.toHaveProperty("text");
  });

  it("cancels without running and rejects stale picker generations", async () => {
    const harness = createHarness();
    const firstConfirmation = await selectFirstSkill(harness);
    const stalePick = callbackData(harness.sent[0]!, "skill-1 — Description for skill 1");

    await harness.bot.handleUpdate(callbackUpdate(callbackData(firstConfirmation, "取消"), 4, 101));
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.textEdits.at(-1)?.text).toContain("已取消");

    await harness.bot.handleUpdate(commandUpdate("/skill", 5, 12));
    await harness.bot.handleUpdate(callbackUpdate(stalePick, 6));
    expect(harness.callbackAnswers.at(-1)?.text).toBe("已过期，请重新运行 /skill");
  });

  it("does not revive a picker if another command arrives while skills are loading", async () => {
    const harness = createHarness();
    let finishList!: (skills: CodexSkill[]) => void;
    harness.session.listSkills.mockImplementation(() => new Promise((resolve) => {
      finishList = resolve;
    }));

    const skillCommand = harness.bot.handleUpdate(commandUpdate("/skill"));
    await vi.waitFor(() => expect(harness.session.listSkills).toHaveBeenCalledOnce());
    await harness.bot.handleUpdate(commandUpdate("/help", 2, 11));
    finishList([userSkill(1)]);
    await skillCommand;

    expect(harness.sent.some((payload) => String(payload.text).includes("用户 Skills"))).toBe(false);
  });

  it("expires the picker keyboard as well as the selected invocation", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const harness = createHarness();
      await harness.bot.handleUpdate(commandUpdate("/skill"));
      const pick = callbackData(harness.sent[0]!, "skill-1 — Description for skill 1");
      now += SKILL_PENDING_TTL_MS + 1;

      await harness.bot.handleUpdate(callbackUpdate(pick));

      expect(harness.callbackAnswers.at(-1)?.text).toBe("已过期，请重新运行 /skill");
      expect(harness.sent).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("atomically claims a pending skill so concurrent arguments cannot run it twice", async () => {
    const harness = createHarness();
    const confirmation = await selectFirstSkill(harness);
    let finishGet!: (session: typeof harness.session) => void;
    harness.registry.getOrCreate.mockImplementationOnce(() => new Promise((resolve) => {
      finishGet = resolve;
    }));

    const directRun = harness.bot.handleUpdate(
      callbackUpdate(callbackData(confirmation, "直接运行"), 4, 101),
    );
    await vi.waitFor(() => expect(harness.registry.getOrCreate).toHaveBeenCalledTimes(2));
    await harness.bot.handleUpdate(textUpdate("racing args", 5, 13));
    finishGet(harness.session);
    await directRun;

    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledOnce());
    expect(harness.sent.some((payload) => String(payload.text).includes("正在提交"))).toBe(true);
  });

  it("cancels pending selection on another slash command", async () => {
    const harness = createHarness();
    await selectFirstSkill(harness);

    await harness.bot.handleUpdate(commandUpdate("/help", 4, 12));
    await harness.bot.handleUpdate(textUpdate("ordinary prompt", 5, 13));
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledOnce());

    const input = harness.session.prompt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ text: "ordinary prompt" });
    expect(input).not.toHaveProperty("skill");
  });

  it("expires pending selection without sending the argument as an ordinary prompt", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const harness = createHarness();
      await selectFirstSkill(harness);
      now += SKILL_PENDING_TTL_MS + 1;

      await harness.bot.handleUpdate(textUpdate("do not leak this as a plain prompt"));

      expect(harness.session.prompt).not.toHaveBeenCalled();
      expect(harness.sent.at(-1)?.text).toContain("Skill 选择已过期");
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("/compact command", () => {
  it("reports completion only after the session compact call resolves", async () => {
    const harness = createHarness();
    let finish!: () => void;
    harness.session.compactThread.mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    const command = harness.bot.handleUpdate(commandUpdate("/compact"));
    await vi.waitFor(() => expect(harness.session.compactThread).toHaveBeenCalledOnce());
    expect(harness.sent).toEqual([]);
    finish();
    await command;

    expect(harness.sent.at(-1)?.text).toBe("✅ 当前 thread 已完成 compact。");
  });

  it("refuses while the context is busy", async () => {
    const harness = createHarness({ busy: true });

    await harness.bot.handleUpdate(commandUpdate("/compact"));

    expect(harness.session.compactThread).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)?.text).toContain("当前 turn 仍在运行");
  });

  it("does not steer or drop ordinary input into an in-flight compaction turn", async () => {
    const harness = createHarness();
    let finish!: () => void;
    harness.session.compactThread.mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    const compact = harness.bot.handleUpdate(commandUpdate("/compact"));
    await vi.waitFor(() => expect(harness.session.compactThread).toHaveBeenCalledOnce());
    await harness.bot.handleUpdate(textUpdate("keep this out of compaction"));

    expect(harness.session.steer).not.toHaveBeenCalled();
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)?.text).toContain("这条消息没有发送");
    finish();
    await compact;
  });
});
