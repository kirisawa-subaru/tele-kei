const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const CHAT = process.env.SMOKE_CHAT;
const BOT_USERNAME = process.env.SMOKE_BOT_USERNAME?.replace(/^@/, "");
const TURN_TIMEOUT = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 4 * 60 * 1000);

test("durable final splits a response above Telegram's message limit", async ({ page }) => {
  test.skip(!process.env.SMOKE_LONG, "opt-in via SMOKE_LONG=1");
  test.skip(!CHAT || !BOT_USERNAME, "Set SMOKE_CHAT and SMOKE_BOT_USERNAME first");
  await tg.openChat(page, CHAT);

  const head = `durable-head-${Date.now()}`;
  const tail = `durable-tail-${Date.now()}`;
  const beforeIds = await tg.incomingIds(page);
  const sent = await tg.sendText(
    page,
    `@${BOT_USERNAME} [smoke] Plain text only. Begin exactly with ${head}. ` +
      `Then write at least 4300 plain ASCII filler characters. End exactly with ${tail}.`,
  );

  const reply = await tg.waitForNewIncomingMatching(
    page,
    beforeIds,
    tail,
    TURN_TIMEOUT,
    "durable-tail-not-seen",
  );
  await page.waitForTimeout(500);

  const rows = page.locator(tg.SEL.incoming);
  const parts = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    const id =
      (await row.getAttribute("data-message-id")) ??
      (await row.getAttribute("data-mid")) ??
      `index-${index}`;
    if (!beforeIds.has(id)) parts.push(await tg.messageText(row));
  }

  const combined = parts.join("");
  expect(parts.length).toBeGreaterThanOrEqual(2);
  expect(combined).toContain(head);
  expect(combined.trimEnd().endsWith(tail)).toBe(true);
  expect(combined.length).toBeGreaterThan(4000);
  console.log(
    `SMOKE_METRIC durable_split send_to_final_flush_ms=${reply.seenAt - sent.sentAt} parts=${parts.length} chars=${combined.length}`,
  );
});
