#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const tg = require("./telegram-page");

const BOTFATHER_PEER = "93372553";
const PROFILE_DIR = path.join(__dirname, ".profile");
const ROOT = path.join(__dirname, "..");
const TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;

const botKey = requireEnv("BOT_KEY");
const botName = requireEnv("BOT_NAME");
const usernames = requireEnv("BOT_USERNAMES")
  .split(",")
  .map((value) => value.trim().replace(/^@/, ""))
  .filter(Boolean);
// Extra env files to read the inherited allowlist and proxy settings from,
// searched after <repo>/.telecodex.env. Colon-separated, empty by default.
const extraEnvFiles = (process.env.TELECODEX_EXTRA_ENV_FILES ?? "")
  .split(":")
  .map((value) => value.trim())
  .filter(Boolean);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Usage: BOT_KEY=<key> BOT_NAME="<display name>" ` +
        `BOT_USERNAMES=<candidate_bot,other_bot> node smoke/create-bot.js`,
    );
  }
  return value;
}

main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
});

async function main() {
  validateInputs();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: /^(1|true|yes)$/i.test(process.env.HEADLESS ?? "1"),
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  let token;
  let username;
  try {
    await page.goto(`https://web.telegram.org/a/#${BOTFATHER_PEER}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(tg.SEL.composer).waitFor({ state: "visible", timeout: 45_000 });

    await sendAndWait(page, "/newbot", /How are we going to call it\?/i);
    await sendAndWait(page, botName, /choose a username for your bot/i);

    for (const candidate of usernames) {
      const reply = await sendAndWait(
        page,
        candidate,
        /Done! Congratulations|Sorry, this username/i,
      );
      const match = reply.match(TOKEN_RE);
      if (match) {
        token = match[0];
        username = candidate;
        break;
      }
    }

    if (!token || !username) {
      throw new Error(`BotFather rejected every configured username: ${usernames.join(", ")}`);
    }

    await page.goto("about:blank");
    const botInfo = readBotInfo(token);
    if (String(botInfo.username).toLowerCase() !== username.toLowerCase()) {
      throw new Error(`BotFather returned @${botInfo.username}, expected @${username}`);
    }
    writeInstanceEnv(token);
    console.log(`Created @${botInfo.username} (id ${botInfo.id}) for profile ${botKey}.`);
    console.log(`Wrote .telecodex/instances/${botKey}/bot.env with mode 0600.`);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await context.close();
  }
}

async function sendAndWait(page, text, matcher, timeoutMs = 30_000) {
  const beforeIds = await tg.incomingIds(page);
  const composer = page.locator(tg.SEL.composer);
  await composer.fill(text);
  await composer.press("Enter");

  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let bottomRecoveryClicked = false;
  while (Date.now() <= deadline) {
    const messages = page.locator(tg.SEL.incoming);
    for (let index = 0; index < (await messages.count()); index += 1) {
      const message = messages.nth(index);
      const id =
        (await message.getAttribute("data-message-id")) ??
        (await message.getAttribute("data-mid")) ??
        `index-${index}`;
      if (beforeIds.has(id)) continue;
      const reply = await tg.messageText(message);
      if (matcher.test(reply)) return reply;
    }
    if (!bottomRecoveryClicked && Date.now() - startedAt >= 500) {
      const goToBottom = page.locator(tg.SEL.goToBottom);
      if (await goToBottom.isVisible().catch(() => false)) {
        bottomRecoveryClicked = await goToBottom
          .click({ force: true, timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`BotFather did not answer ${JSON.stringify(text)} within ${timeoutMs}ms`);
}

function validateInputs() {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(botKey)) {
    throw new Error(`Invalid BOT_KEY: ${botKey}`);
  }
  if (!botName.trim()) throw new Error("BOT_NAME must not be empty");
  if (usernames.length === 0) throw new Error("BOT_USERNAMES must contain at least one candidate");
  for (const username of usernames) {
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username) || !/bot$/i.test(username)) {
      throw new Error(`Invalid Telegram bot username: ${username}`);
    }
  }
  const existingEnv = path.join(ROOT, ".telecodex", "instances", botKey, "bot.env");
  if (fs.existsSync(existingEnv)) {
    throw new Error(`Refusing to replace the existing instance credential: ${existingEnv}`);
  }
}

function readBotInfo(token) {
  const proxyEnv = readEnvironment([path.join(ROOT, ".telecodex.env"), ...extraEnvFiles]);
  const output = execFileSync(
    "curl",
    ["-fsS", "--max-time", "30", `https://api.telegram.org/bot${token}/getMe`],
    { encoding: "utf8", env: { ...process.env, ...proxyEnv } },
  );
  const payload = JSON.parse(output);
  if (!payload.ok || !payload.result?.username) {
    throw new Error("Telegram getMe rejected the new bot token");
  }
  return payload.result;
}

function writeInstanceEnv(token) {
  const inherited = readEnvironment([path.join(ROOT, ".telecodex.env"), ...extraEnvFiles]);
  const allowed =
    process.env.TELEGRAM_ALLOWED_USER_IDS ??
    inherited.TELEGRAM_ALLOWED_USER_IDS ??
    inherited.TELEGRAM_ALLOWED_CHAT_IDS;
  if (!allowed) {
    throw new Error(
      "No Telegram allowed-user id found. Set TELEGRAM_ALLOWED_USER_IDS, or put it in .telecodex.env.",
    );
  }

  const values = {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USER_IDS: allowed,
    ...pick(inherited, ["TELEGRAM_API_BASE", "HTTP_PROXY", "HTTPS_PROXY"]),
  };
  const directory = path.join(ROOT, ".telecodex", "instances", botKey);
  const target = path.join(directory, "bot.env");
  const temporary = path.join(directory, `.bot.env.${process.pid}.tmp`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    temporary,
    `${Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function readEnvironment(files) {
  const result = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || result[match[1]] !== undefined) continue;
      result[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return result;
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key]).map((key) => [key, source[key]]));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function redactSecrets(text) {
  return text.replace(TOKEN_RE, "[REDACTED_TELEGRAM_TOKEN]");
}
