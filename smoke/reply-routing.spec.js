const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const CHAT = process.env.SMOKE_CHAT;
const TURN_TIMEOUT = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 4 * 60 * 1000);

test("replying to a bot message continues the group thread without a mention", async ({ page }) => {
  test.skip(!CHAT, "Set SMOKE_CHAT first");
  await tg.openChat(page, CHAT);

  const marker = `reply-route-${Date.now()}`;
  const before = await tg.incomingCount(page);
  const target = page.locator(tg.SEL.incoming).last();
  await target.click({ button: "right", timeout: 5_000 });
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click({ timeout: 5_000 });

  const sent = await tg.sendText(
    page,
    `[smoke] reply with exactly: ${marker}`,
  );
  const reply = await tg.waitForIncomingContaining(page, before, marker, TURN_TIMEOUT);
  const text = await tg.messageText(reply.message);
  expect(text).toContain(marker);
  console.log(
    `SMOKE_METRIC reply_route send_to_final_flush_ms=${reply.seenAt - sent.sentAt}`,
  );
});
