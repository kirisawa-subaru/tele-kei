const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const ALLOWED_CHAT = process.env.SMOKE_ALLOWED_CHAT;
const CHAT = process.env.SMOKE_CHAT;
const TURN_TIMEOUT = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 4 * 60 * 1000);

test("block LaTeX becomes numbered cards with native copy buttons", async ({ page }) => {
  test.skip(!CHAT, "Set SMOKE_CHAT first");
  if (CHAT !== ALLOWED_CHAT) {
    throw new Error(`Refusing to open any chat except the delegated test group ${ALLOWED_CHAT}`);
  }

  await tg.openChat(page, CHAT);
  const marker = `latex-smoke-${Date.now()}`;
  const beforeIds = await tg.incomingIds(page);
  const prompt = [
    "[smoke] Do not use tools. Reply with exactly the content below, preserving every TeX character and delimiter:",
    marker,
    "Inline: $x_i^2$",
    "Dollar block:",
    "$$E=mc^2$$",
    "Bracket block:",
    "\\[\\int_0^1 x^2\\,dx=\\frac{1}{3}\\]",
    "Fenced block:",
    "```latex",
    "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
    "```",
    "Fourth block:",
    "$$a^2+b^2=c^2$$",
    "Tail after the fourth formula.",
  ].join("\n");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://web.telegram.org",
  });
  const sent = await tg.sendText(page, prompt);
  const first = await tg.waitForNewIncomingPhoto(page, beforeIds, TURN_TIMEOUT);
  const second = await tg.waitForNewIncomingPhoto(
    page,
    beforeIds,
    TURN_TIMEOUT,
    first.messageId,
  );

  const firstText = await tg.messageText(first.message);
  const secondText = await tg.messageText(second.message);
  expect(firstText).toContain(marker);
  expect(firstText).toContain("$x_i^2$");
  expect(firstText).toContain("[1]");
  expect(firstText).toContain("[2]");
  expect(firstText).toContain("[3]");
  expect(firstText).not.toContain("$$E=mc^2$$");
  expect(firstText).not.toContain("\\int_0^1");
  expect(secondText).toContain("Fourth block:");
  expect(secondText).toContain("[4]");
  expect(secondText).toContain("Tail after the fourth formula.");
  expect(secondText).not.toContain("$$a^2+b^2=c^2$$");

  expect(await tg.messageButtonTexts(first.message)).toEqual(
    expect.arrayContaining(["[1]", "[2]", "[3]"]),
  );
  expect(await tg.messageButtonTexts(second.message)).toEqual(
    expect.arrayContaining(["[4]"]),
  );
  await first.message.getByRole("button", { name: "[1]", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("$$E=mc^2$$");

  const media = first.message.locator(tg.SEL.messagePhoto).first();
  const dimensions = await media.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      intrinsicWidth: element.width ?? element.naturalWidth ?? 0,
      intrinsicHeight: element.height ?? element.naturalHeight ?? 0,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
    };
  });
  expect(dimensions.intrinsicWidth).toBeGreaterThan(0);
  expect(dimensions.intrinsicHeight).toBeGreaterThan(0);
  expect(dimensions.renderedWidth).toBeGreaterThan(0);
  expect(dimensions.renderedHeight).toBeGreaterThan(0);

  await page.waitForTimeout(1_500);
  expect(await tg.countNewIncomingPhotos(page, beforeIds)).toBe(2);
  const firstArtifact = await tg.screenshotMessage(first.message, "latex-numbered-card-1-live");
  const secondArtifact = await tg.screenshotMessage(second.message, "latex-numbered-card-2-live");
  console.log(
    `SMOKE_METRIC latex send_to_first_card_ms=${first.seenAt - sent.sentAt} ` +
      `send_to_second_card_ms=${second.seenAt - sent.sentAt} ` +
      `photo=${JSON.stringify(dimensions)} artifacts=${firstArtifact},${secondArtifact}`,
  );
});
