const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const GROUP_CHAT = process.env.SMOKE_CHAT;
const PRIVATE_CHAT = process.env.SMOKE_PRIVATE_CHAT;
const PRIVATE_CONTEXT_ID = process.env.SMOKE_PRIVATE_CONTEXT_ID;
const BOT_KEY = process.env.SMOKE_BOT_KEY ?? "main";
const EXPECT_WORKSPACE = process.env.SMOKE_EXPECT_WORKSPACE;
const EXPECT_MODEL = process.env.SMOKE_EXPECT_MODEL;
const QUIET_WINDOW_MS = Number(process.env.SMOKE_QUIET_WINDOW_MS ?? 15_000);

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

test("ordinary group chatter stays silent", async ({ page }) => {
  test.skip(!GROUP_CHAT, "Set SMOKE_CHAT first");
  await tg.openChat(page, GROUP_CHAT);
  const marker = `must-stay-silent-${Date.now()}`;
  const beforeIds = await tg.incomingIds(page);
  await tg.sendText(page, `[routing-smoke] ordinary group chatter ${marker}`);
  await page.waitForTimeout(QUIET_WINDOW_MS);
  const replies = await newIncomingTexts(page, beforeIds);
  expect(replies.some((text) => text.includes(marker))).toBe(false);
  console.log(`SMOKE_METRIC group_quiet window_ms=${QUIET_WINDOW_MS} marker=${marker}`);
});

test("group command reports the scoped worker context", async ({ page }) => {
  test.skip(!GROUP_CHAT, "Set SMOKE_CHAT first");
  await tg.openChat(page, GROUP_CHAT);
  const reply = await tg.sendCommand(
    page,
    "/status",
    new RegExp(`Bot:\\s*${BOT_KEY}[\\s\\S]*Telegram:\\s*${GROUP_CHAT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`),
  );
  expect(reply.text).toContain("Chat session:");
  console.log(`SMOKE_METRIC group_status command_to_reply_ms=${reply.latencyMs}`);
});

test("private chat has a distinct scoped context", async ({ page }) => {
  test.skip(!PRIVATE_CHAT, "Set SMOKE_PRIVATE_CHAT first");
  test.skip(!PRIVATE_CONTEXT_ID, "Set SMOKE_PRIVATE_CONTEXT_ID first");
  await tg.openChat(page, PRIVATE_CHAT);
  const reply = await tg.sendCommand(
    page,
    "/status",
    new RegExp(`Bot:\\s*${BOT_KEY}[\\s\\S]*Telegram:\\s*${PRIVATE_CONTEXT_ID.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`),
  );
  expect(reply.text).toContain("Chat session:");
  if (EXPECT_WORKSPACE) expect(reply.text).toContain(`Workspace: ${EXPECT_WORKSPACE}`);
  if (EXPECT_MODEL) expect(reply.text).toContain(`Model: ${EXPECT_MODEL}`);
  expect(reply.text).not.toContain(`Telegram: ${GROUP_CHAT}`);
  console.log(`SMOKE_METRIC private_status command_to_reply_ms=${reply.latencyMs}`);
});
