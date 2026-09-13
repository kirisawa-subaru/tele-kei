const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

const BOTFATHER_PEER = "93372553";
const EXPERIMENT_BOT = process.env.EXPERIMENT_BOT_USERNAME;
const EXPERIMENT_BOT_KEY = process.env.EXPERIMENT_BOT_KEY ?? "second-bot";
const USER_CHAT_ID = process.env.EXPERIMENT_USER_CHAT_ID;
const ROOT = path.join(__dirname, "..");
const DB = path.join(ROOT, ".telecodex", "state.sqlite");
const WORKER = path.join(ROOT, "telecodex.worker.start.sh");
const REPO_ENV = readSelectedEnv(path.join(ROOT, ".telecodex.env"));
const TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;

test.use({ screenshot: "off", trace: "off" });

test("an unused BotFather token runs an isolated second worker", async ({ page }) => {
  test.skip(!process.env.MULTIBOT_LIVE, "opt-in via MULTIBOT_LIVE=1");
  test.skip(
    !EXPERIMENT_BOT || !USER_CHAT_ID,
    "Set EXPERIMENT_BOT_USERNAME and EXPERIMENT_USER_CHAT_ID first",
  );
  let worker;
  try {
    const token = await readBotFatherToken(page);

    // Remove the secret-bearing BotFather message from the live page before any
    // later assertion can fail. This spec also disables Playwright artifacts.
    await page.goto("about:blank");
    const botInfo = await getBotInfo(token);
    expect(`@${botInfo.username}`.toLowerCase()).toBe(EXPERIMENT_BOT.toLowerCase());
    console.log(`SMOKE_INFO experiment_bot_id=${botInfo.id} username=@${botInfo.username}`);

    worker = spawn(WORKER, [EXPERIMENT_BOT_KEY], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...REPO_ENV,
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USER_IDS: USER_CHAT_ID,
        TELECODEX_BOT_KEY: EXPERIMENT_BOT_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForWorker(worker, 30_000);

    await openBotChat(page, String(botInfo.id));
    const marker = `multi-bot-${Date.now()}`;
    const before = await tg.incomingCount(page);
    const sent = await tg.sendText(page, `[smoke] reply with exactly: ${marker}`);
    const sentMessageId =
      (await sent.message.getAttribute("data-message-id")) ??
      (await sent.message.getAttribute("data-mid"));
    const reply = await waitForMultiBotResult(
      page,
      String(botInfo.id),
      before,
      marker,
      sentMessageId,
      worker,
      240_000,
    );
    expect(await tg.messageText(reply.message)).toContain(marker);

    const bindings = readBindings();
    const main = bindings.find((row) => row.botKey === "main");
    const experiment = bindings.find((row) => row.botKey === EXPERIMENT_BOT_KEY);
    expect(main?.threadId).toBeTruthy();
    expect(experiment?.threadId).toBeTruthy();
    expect(experiment.threadId).not.toBe(main.threadId);
    console.log(
      `SMOKE_METRIC multi_bot bot_key=${EXPERIMENT_BOT_KEY} ` +
        `send_to_final_flush_ms=${reply.seenAt - sent.sentAt} ` +
        `isolated_threads=true`,
    );
  } finally {
    if (worker) await stopWorker(worker);
  }
});

async function readBotFatherToken(page) {
  try {
    await page.goto(`https://web.telegram.org/a/#${BOTFATHER_PEER}`, {
      waitUntil: "domcontentloaded",
    });
    const composer = page.locator(tg.SEL.composer);
    await composer.waitFor({ state: "visible", timeout: 45_000 });
    await composer.fill("/mybots");
    await composer.press("Enter");
    const botButton = page.getByRole("button", {
      name: EXPERIMENT_BOT,
      exact: true,
    }).last();
    await botButton.waitFor({ state: "visible", timeout: 15_000 });
    await botButton.click({ timeout: 5_000 });
    const tokenButton = page.getByRole("button", { name: "API Token", exact: true });
    await tokenButton.waitFor({ state: "visible", timeout: 15_000 });
    const beforeTokenIds = await tg.incomingIds(page);
    await tokenButton.click({ timeout: 5_000 });
    return await waitForNewToken(page, beforeTokenIds, 20_000);
  } catch (error) {
    await page.goto("about:blank").catch(() => {});
    throw error;
  }
}

async function waitForNewToken(page, beforeIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let recoveryClicked = false;
  let lastMeta = { rows: [], buttons: [] };
  while (Date.now() <= deadline) {
    const goToBottom = page.locator(tg.SEL.goToBottom);
    if (!recoveryClicked && (await goToBottom.isVisible().catch(() => false))) {
      recoveryClicked = await goToBottom
        .click({ force: true, timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
    }
    const tokenPanel = page.locator(tg.SEL.incoming).filter({
      has: page.getByRole("button", { name: "Revoke current token", exact: true }),
    }).last();
    if (await tokenPanel.isVisible().catch(() => false)) {
      const editedMatch = (await tg.messageText(tokenPanel)).match(TOKEN_RE);
      if (editedMatch) return editedMatch[0];
    }
    const rows = page.locator(tg.SEL.incoming);
    const rowMeta = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const id =
        (await row.getAttribute("data-message-id")) ??
        (await row.getAttribute("data-mid")) ??
        `index-${index}`;
      if (beforeIds.has(id)) continue;
      const text = await tg.messageText(row);
      const match = text.match(TOKEN_RE);
      rowMeta.push({
        id,
        chars: text.length,
        tokenShape: Boolean(match),
        hasApiWord: /\bAPI\b/i.test(text),
      });
      if (match) return match[0];
    }
    lastMeta = {
      rows: rowMeta,
      buttons: await page.getByRole("button").allInnerTexts().then((values) =>
        values.map((value) => value.trim()).filter(Boolean).slice(-20)),
    };
    await page.waitForTimeout(100);
  }
  await page.goto("about:blank");
  throw new Error(`BotFather did not provide a token for the selected bot: ${JSON.stringify(lastMeta)}`);
}

async function getBotInfo(token) {
  const output = execFileSync("curl", [
    "-fsS",
    "--max-time",
    "30",
    `https://api.telegram.org/bot${token}/getMe`,
  ], { encoding: "utf8", env: { ...process.env, ...REPO_ENV } });
  const payload = JSON.parse(output);
  if (!payload.ok) throw new Error("Selected BotFather token failed getMe");
  return payload.result;
}

function readSelectedEnv(file) {
  const selected = {};
  const allowed = new Set(["HTTP_PROXY", "HTTPS_PROXY", "TELEGRAM_API_BASE"]);
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !allowed.has(match[1])) continue;
    selected[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return selected;
}

async function openBotChat(page, peerId) {
  await page.goto(`https://web.telegram.org/a/#${peerId}`, { waitUntil: "domcontentloaded" });
  const composer = page.locator(tg.SEL.composer);
  if (!(await composer.isVisible().catch(() => false))) {
    const start = page.getByRole("button", { name: "Start", exact: true });
    if (await start.isVisible().catch(() => false)) await start.click();
  }
  await composer.waitFor({ state: "visible", timeout: 45_000 });
}

function waitForWorker(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Experimental worker startup timed out")), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      child.diagnosticOutput = redactSecrets(output.slice(-20_000));
      if (output.includes("TeleCodex Telegram worker running")) finish();
    };
    const onExit = (code) => finish(new Error(`Experimental worker exited during startup (${code})`));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForMultiBotResult(
  page,
  botPeerId,
  before,
  marker,
  sentMessageId,
  worker,
  timeoutMs,
) {
  const requestKey = `telegram:${EXPERIMENT_BOT_KEY}:${USER_CHAT_ID}:${sentMessageId}`;
  const deadline = Date.now() + timeoutMs;
  let completedAt = null;
  let reopened = false;
  let observedMessage = null;
  let lastState = { request: "missing", deliveries: 0, incompleteDeliveries: 0 };
  while (Date.now() <= deadline) {
    lastState = readTurnState(requestKey);
    if (lastState.request === "completed") completedAt ??= Date.now();
    if (completedAt && !reopened && Date.now() - completedAt >= 1_000) {
      const chat = page.locator(`a[href="#${botPeerId}"]`);
      if (await chat.isVisible().catch(() => false)) {
        await chat.click({ timeout: 5_000 });
        reopened = true;
      }
    }
    const rows = page.locator(tg.SEL.incoming);
    const count = await rows.count();
    for (let index = Math.max(0, before - 1); index < count; index += 1) {
      const message = rows.nth(index);
      const text = await tg.messageText(message).catch(() => "");
      if (text.includes(marker)) {
        observedMessage ??= { message, seenAt: Date.now() };
      }
    }
    if (
      observedMessage &&
      lastState.deliveries > 0 &&
      lastState.incompleteDeliveries === 0
    ) return observedMessage;
    if (completedAt && Date.now() - completedAt >= 15_000 && lastState.deliveries === 0) {
      throw new Error(
        `Core completed without staging a Telegram outbox row; worker=${worker.diagnosticOutput ?? ""}`,
      );
    }
    await page.waitForTimeout(200);
  }
  throw new Error(
    `Timed out waiting for experimental bot reply; state=${JSON.stringify(lastState)} ` +
      `worker=${worker.diagnosticOutput ?? ""}`,
  );
}

function readTurnState(requestKey) {
  const output = execFileSync("sqlite3", [
    "-separator",
    "|",
    DB,
    `select coalesce((select state from turn_requests where request_key='${requestKey}'),'missing'),` +
      `(select count(*) from telegram_outbox where bot_key='${EXPERIMENT_BOT_KEY}' ` +
      `and created_at >= coalesce((select created_at from turn_requests where request_key='${requestKey}'),0)),` +
      `(select count(*) from telegram_outbox where bot_key='${EXPERIMENT_BOT_KEY}' ` +
      `and created_at >= coalesce((select created_at from turn_requests where request_key='${requestKey}'),0) ` +
      `and state!='delivered');`,
  ], { encoding: "utf8" }).trim();
  const [request, deliveries, incompleteDeliveries] = output.split("|");
  return {
    request,
    deliveries: Number(deliveries),
    incompleteDeliveries: Number(incompleteDeliveries),
  };
}

function redactSecrets(value) {
  return value.replace(/[0-9]{6,15}:[A-Za-z0-9_-]{10,}/g, "[REDACTED_TOKEN]");
}

function stopWorker(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function readBindings() {
  const output = execFileSync("sqlite3", [
    "-separator",
    "|",
    DB,
    `select bot_key,telegram_context_key,thread_id from context_bindings ` +
      `where telegram_context_key='${USER_CHAT_ID}' and bot_key in ('main','${EXPERIMENT_BOT_KEY}') ` +
      `order by bot_key;`,
  ], { encoding: "utf8" });
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [botKey, contextKey, threadId] = line.split("|");
    return { botKey, contextKey, threadId };
  });
}
