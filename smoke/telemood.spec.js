const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const CHAT = process.env.SMOKE_CHAT;
const BOT_USERNAME = process.env.SMOKE_BOT_USERNAME?.replace(/^@/, "");
const TURN_TIMEOUT = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 4 * 60 * 1000);
const AUTONOMY_TIMEOUT = Number(process.env.TELEMOOD_AUTONOMY_TIMEOUT_MS ?? 10 * 60 * 1000);

test.beforeEach(async ({ page }) => {
  test.skip(!process.env.TELEMOOD_LIVE, "opt-in via TELEMOOD_LIVE=1");
  test.skip(!CHAT, "Set SMOKE_CHAT to the dedicated test group");
  test.skip(!BOT_USERNAME, "Set SMOKE_BOT_USERNAME for the group-addressed prompt");
  await tg.openChat(page, CHAT);
  await waitForChatConnected(page);
});

test("reaction, ordered bubbles, choices, and callback roundtrip", async ({ page }) => {
  await tg.sendCommand(page, `/new@${BOT_USERNAME}`, /New thread created/);

  const marker = Date.now();
  const bubbleMarker = `TELEMOOD-BUBBLE-${marker}`;
  const choiceMarker = `TELEMOOD-CHOICE-${marker}`;
  const callbackMarker = `TELEMOOD-CALLBACK-${marker}`;
  const beforeIds = await tg.incomingIds(page);
  const prompt = [
    `@${BOT_USERNAME} [Playwright Telemood acceptance ${marker}]`,
    "You must use telegram.send_interaction exactly once as the final action for this turn.",
    "Send this exact ordered plan: first react to this message with ❤; then one bubble whose entire text is",
    bubbleMarker,
    "; then choices with prompt exactly",
    choiceMarker,
    "and exactly two options: key continue label 继续测试, key stop label 结束测试.",
    "Do not emit any visible text after the tool call.",
    `When a later Telegram choice selects option_key continue, use telegram.send_interaction once with one bubble whose entire text is ${callbackMarker}, then emit no other visible text.`,
  ].join(" ");

  const sent = await tg.sendText(page, prompt);
  const bubble = await tg.waitForNewIncomingMatching(
    page,
    beforeIds,
    bubbleMarker,
    TURN_TIMEOUT,
    "telemood-bubble-missing",
  );
  const choices = await tg.waitForNewIncomingMatching(
    page,
    beforeIds,
    choiceMarker,
    TURN_TIMEOUT,
    "telemood-choices-missing",
  );

  expect(bubble.text).toBe(bubbleMarker);
  expect(choices.text).toBe(choiceMarker);
  expect(await tg.messageButtonTexts(choices.message)).toEqual(["继续测试", "结束测试"]);
  if (/^\d+$/.test(bubble.messageId) && /^\d+$/.test(choices.messageId)) {
    expect(Number(bubble.messageId)).toBeLessThan(Number(choices.messageId));
  }

  await waitForReaction(sent.message, /❤|❤️|Red Heart/iu, TURN_TIMEOUT);
  await waitForBotIdle(page);

  const firstTurnTexts = await newIncomingTexts(page, beforeIds);
  expect(firstTurnTexts.filter((text) => text === bubbleMarker)).toHaveLength(1);
  expect(firstTurnTexts.filter((text) => text === choiceMarker)).toHaveLength(1);
  expect(firstTurnTexts.some((text) => text.includes("✅ Done"))).toBe(false);

  const callbackBeforeIds = await tg.incomingIds(page);
  const selection = await tg.clickMessageButtonAndWait(
    page,
    choices.message,
    "继续测试",
    ({ text, buttons }) => text.includes("✓ 继续测试") && buttons.length === 0,
    { timeoutMs: 30_000, artifactName: "telemood-choice-not-settled" },
  );
  expect(selection.buttons).toEqual([]);

  const callback = await tg.waitForNewIncomingMatching(
    page,
    callbackBeforeIds,
    callbackMarker,
    TURN_TIMEOUT,
    "telemood-callback-missing",
  );
  expect(callback.text).toBe(callbackMarker);

  const promptScreenshot = await tg.screenshotMessage(sent.message, "telemood-reaction");
  const choicesScreenshot = await tg.screenshotMessage(choices.message, "telemood-choice-selected");
  console.log(
    `SMOKE_METRIC telemood bubble_ms=${bubble.seenAt - sent.sentAt} ` +
      `choices_ms=${choices.seenAt - sent.sentAt} callback_ms=${callback.seenAt - selection.clickedAt}`,
  );
  console.log(`SMOKE_ARTIFACT reaction=${promptScreenshot}`);
  console.log(`SMOKE_ARTIFACT choices=${choicesScreenshot}`);
});

test("the model chooses native choices from an ordinary conversational fork", async ({ page }) => {
  test.setTimeout(AUTONOMY_TIMEOUT + 2 * 60 * 1000);
  await tg.sendCommand(page, `/new@${BOT_USERNAME}`, /New thread created/);

  const marker = `自然对话验收-${Date.now()}`;
  const beforeIds = await tg.incomingIds(page);
  await tg.sendText(
    page,
    `@${BOT_USERNAME} ${marker}。我今晚只剩半小时，脑子有点散，在“读论文”和“整理笔记”之间摇摆。你替我把区别说清楚，但最后这一步我想自己选。`,
  );

  const choices = await waitForNewChoices(page, beforeIds, AUTONOMY_TIMEOUT);
  expect(choices.buttons.length).toBeGreaterThanOrEqual(2);
  expect(choices.buttons.length).toBeLessThanOrEqual(4);
  expect(choices.text).not.toContain("telegram.send_interaction");
  await waitForBotIdle(page);
  const firstTurnTexts = await newIncomingTexts(page, beforeIds);
  expect(firstTurnTexts.some((text) => text.includes("✅ Done"))).toBe(false);

  const chosenLabel = choices.buttons[0];
  const callbackBeforeIds = await tg.incomingIds(page);
  const selection = await tg.clickMessageButtonAndWait(
    page,
    choices.message,
    chosenLabel,
    ({ text, buttons }) => text.includes(`✓ ${chosenLabel}`) && buttons.length === 0,
    { timeoutMs: 30_000, artifactName: "telemood-autonomy-choice-not-settled" },
  );
  await tg.waitForNewIncomingMatching(
    page,
    callbackBeforeIds,
    /\S/u,
    AUTONOMY_TIMEOUT,
    "telemood-autonomy-callback-missing",
  );

  const screenshot = await tg.screenshotMessage(
    choices.message,
    "telemood-autonomous-choice-selected",
  );
  console.log(
    `SMOKE_METRIC telemood_autonomy choices=${choices.buttons.length} ` +
      `choice_ms=${choices.seenAt - choices.sentAt} callback_ui_ms=${selection.latencyMs}`,
  );
  console.log(`SMOKE_ARTIFACT autonomy=${screenshot}`);
});

async function waitForReaction(message, matcher, timeoutMs) {
  await expect.poll(
    async () => message.evaluate((row) => {
      const values = [row.textContent ?? ""];
      for (const element of row.querySelectorAll("*")) {
        for (const name of ["aria-label", "alt", "title", "data-emoji", "data-reaction"]) {
          const value = element.getAttribute(name);
          if (value) values.push(value);
        }
      }
      return values.join(" ");
    }),
    { timeout: timeoutMs, message: "the outgoing prompt should show the model-selected reaction" },
  ).toMatch(matcher);
}

async function waitForBotIdle(page, stableMs = 1_500, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let idleSince = null;
  while (Date.now() <= deadline) {
    const status = await page.locator(tg.SEL.typing).textContent().catch(() => "");
    if (!/\btyping\b/i.test(status ?? "")) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= stableMs) return;
    } else {
      idleSince = null;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("Telegram never observed a stable idle window before the choice click");
}

async function waitForChatConnected(page, timeoutMs = 60_000) {
  await expect.poll(
    async () => page.locator(tg.SEL.typing).textContent().catch(() => ""),
    { timeout: timeoutMs, message: "Telegram Web should finish reconnecting before a real send" },
  ).not.toMatch(/waiting for network|updating|connecting/i);
}

async function newIncomingTexts(page, beforeIds) {
  const rows = page.locator(tg.SEL.incoming);
  const texts = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    const id =
      (await row.getAttribute("data-message-id")) ??
      (await row.getAttribute("data-mid")) ??
      `index-${index}`;
    if (!beforeIds.has(id)) texts.push(await tg.messageText(row));
  }
  return texts;
}

async function waitForNewChoices(page, beforeIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sentAt = Date.now();
  while (Date.now() <= deadline) {
    const rows = page.locator(tg.SEL.incoming);
    for (let index = 0; index < (await rows.count()); index += 1) {
      const message = rows.nth(index);
      const id =
        (await message.getAttribute("data-message-id")) ??
        (await message.getAttribute("data-mid")) ??
        `index-${index}`;
      if (beforeIds.has(id)) continue;
      const buttons = await tg.messageButtonTexts(message);
      if (buttons.length >= 2 && buttons.length <= 4) {
        return {
          message,
          buttons,
          text: await tg.messageText(message),
          seenAt: Date.now(),
          sentAt,
        };
      }
    }
    const bottom = page.locator(tg.SEL.goToBottom);
    if (await bottom.isVisible().catch(() => false)) {
      await bottom.click({ force: true, timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(100);
  }
  const base = await tg.dump(page, "telemood-autonomous-choice-missing");
  throw new Error(`the model did not choose native choices for the conversational fork; see ${base}.*`);
}
