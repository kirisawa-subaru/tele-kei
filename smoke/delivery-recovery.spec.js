const { execFileSync } = require("child_process");
const path = require("path");

const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const CHAT = process.env.SMOKE_CHAT;
const ROOT = path.join(__dirname, "..");
const DB = path.join(ROOT, ".telecodex", "state.sqlite");
const BOT_KEY = process.env.SMOKE_BOT_KEY ?? "main";
// How this host restarts a worker. SMOKE_WORKER_RESTART_CMD is split on
// whitespace; the default restarts the worker in the foreground of a
// throwaway process group via the repo's own entrypoint.
const RESTART_CMD = (
  process.env.SMOKE_WORKER_RESTART_CMD ??
  `${path.join(ROOT, "telecodex.worker.start.sh")} ${BOT_KEY}`
).split(/\s+/);

test("worker restart recovers a staged but unsent durable delivery", async ({ page }) => {
  test.skip(!process.env.SMOKE_RECOVERY, "opt-in via SMOKE_RECOVERY=1");
  test.skip(!CHAT, "Set SMOKE_CHAT first");
  await tg.openChat(page, CHAT);
  const beforeIds = await tg.incomingIds(page);
  const marker = `recovered-after-worker-restart-${Date.now()}`;
  const deliveryId = `smoke-recovery-${Date.now()}`;
  const now = Date.now();

  execFileSync("sqlite3", [
    DB,
    `insert into telegram_outbox ` +
      `(delivery_id,bot_key,context_key,chat_id,kind,payload_json,state,attempts,next_attempt_at,created_at) ` +
      `values ('${deliveryId}','${BOT_KEY}','${CHAT}','${CHAT}','text','{}','pending',0,0,${now}); ` +
      `insert into telegram_outbox_parts ` +
      `(delivery_id,part_index,text,fallback_text,state,attempts) ` +
      `values ('${deliveryId}',0,'${marker}','${marker}','pending',0);`,
  ]);

  execFileSync(RESTART_CMD[0], RESTART_CMD.slice(1), { cwd: ROOT });
  // Telegram Web A updates the chat-list preview while leaving the selected
  // chat's virtual message list stale across the worker restart. Click the
  // unread chat item just as a user would; re-navigating the numeric hash can
  // leave Web A's middle column blank.
  await page.locator(`a[href="#${CHAT}"]`).click({ timeout: 5_000 });
  await page.locator(tg.SEL.composer).waitFor({ timeout: 15_000 });
  const reply = await tg.waitForNewIncomingMatching(
    page,
    beforeIds,
    marker,
    45_000,
    "delivery-recovery-not-seen",
  );
  expect(reply.text).toBe(marker);

  const state = execFileSync("sqlite3", [
    DB,
    `select o.state || '|' || o.attempts || '|' || p.state || '|' || ` +
      `p.attempts || '|' || coalesce(p.telegram_message_id,0) ` +
      `from telegram_outbox o join telegram_outbox_parts p using(delivery_id) ` +
      `where o.delivery_id='${deliveryId}';`,
  ], { encoding: "utf8" }).trim();
  expect(state).toMatch(/^delivered\|1\|delivered\|1\|[1-9]\d*$/);
  console.log(`SMOKE_METRIC delivery_recovery state=${state} message_id=${reply.messageId}`);
});
