#!/usr/bin/env node
// One-time bootstrap: opens a headed Chromium on the persistent smoke profile
// so the Telegram Web QR login sticks for every later `npm run smoke`.
const path = require("path");
const { chromium } = require("@playwright/test");
const { SEL } = require("./telegram-page");

const PROFILE_DIR = path.join(__dirname, ".profile");

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://web.telegram.org/a/");
  console.log("Scan the QR code with the Telegram app. Waiting up to 5 minutes...");
  await page.locator(SEL.loggedIn).waitFor({ timeout: 5 * 60 * 1000 });
  console.log("Logged in. Session saved to smoke/.profile.");
  await context.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
