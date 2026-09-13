const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: __dirname,
  // A smoke turn is a real Codex turn; give it room.
  timeout: 6 * 60 * 1000,
  retries: 0,
  // One browser profile, one shared bridge: never run in parallel.
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
