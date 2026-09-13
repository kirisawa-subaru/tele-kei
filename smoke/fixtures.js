const base = require("@playwright/test");
const path = require("path");

const PROFILE_DIR = process.env.SMOKE_PROFILE_DIR
  ? path.resolve(process.env.SMOKE_PROFILE_DIR)
  : path.join(__dirname, ".profile");
const HEADLESS = /^(1|true|yes)$/i.test(process.env.HEADLESS ?? "");

// Telegram Web login lives in IndexedDB, so every test reuses one persistent
// Chromium profile instead of Playwright's default throwaway context.
const test = base.test.extend({
  context: async ({}, use) => {
    const context = await base.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
    });
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

module.exports = { test, expect: base.expect };
