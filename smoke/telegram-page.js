// Selector layer for web.telegram.org/k. All DOM knowledge lives in this file
// so upstream markup drift only ever requires edits here. Selectors are
// best-effort until confirmed on a live logged-in session; on failure the
// helpers dump a screenshot + HTML into smoke/artifacts for recalibration.
const fs = require("fs");
const path = require("path");

const ARTIFACTS_DIR = path.join(__dirname, "artifacts");
const TELEGRAM_WEB_BASE = "https://web.telegram.org/a/";

const SEL = {
  loggedIn: "#telegram-search-input",
  composer: '#editable-message-text[contenteditable="true"][role="textbox"]',
  // ActionMessage rows are service notices; ordinary messages use Message.
  incoming: ".Message.message-list-item:not(.own)",
  outgoing: ".Message.message-list-item.own",
  messageText: ".text-content",
  // Web A currently renders full-size chat photos as <img class="full-media">.
  // Scope through a media message so reaction/custom-emoji images cannot match.
  messagePhoto: ".message-content.media img.full-media",
  typing: ".chat-info-wrapper",
  goToBottom: 'button[aria-label="Go to bottom"]',
  attachButton: "#attach-menu-button",
  imageCaption: '#editable-message-text-modal[aria-label="Add a caption..."]',
  imageSend: '[role="dialog"] button:has(.icon-new-send)',
};

async function dump(page, name) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(ARTIFACTS_DIR, `${stamp}-${name}`);
  await page
    .screenshot({ path: `${base}.png`, fullPage: false, timeout: 10_000 })
    .catch(() => {});
  let timer;
  const html = await Promise.race([
    page.content().catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 10_000);
    }),
  ]);
  clearTimeout(timer);
  if (html) {
    await fs.promises.writeFile(`${base}.html`, html).catch(() => {});
  }
  return base;
}

async function openChat(page, chat) {
  if (!chat || !/^(@\w+|-?\d+)$/.test(chat)) {
    throw new Error(
      "SMOKE_CHAT must be a public @username or a numeric chat id (private groups: e.g. -1001234567890)",
    );
  }
  await page.goto(`${TELEGRAM_WEB_BASE}#${chat}`, {
    waitUntil: "domcontentloaded",
  });
  try {
    await page.locator(SEL.composer).waitFor({ timeout: 45_000 });
  } catch {
    const base = await dump(page, "open-chat-failed");
    throw new Error(
      `Composer not found for ${chat} — not logged in (run \`npm run login\`) or selectors drifted; see ${base}.*`,
    );
  }

  if (/^-?\d+$/.test(chat) && new URL(page.url()).hash !== `#${chat}`) {
    const base = await dump(page, "wrong-chat");
    throw new Error(
      `Telegram resolved ${chat} to ${page.url()} instead; refusing to send; see ${base}.*`,
    );
  }

  const bottomRecoveryClicks = (await clickGoToBottom(page)) ? 1 : 0;
  if (bottomRecoveryClicks) {
    await page.waitForTimeout(300);
  }
  return { bottomRecoveryClicks };
}

async function clickGoToBottom(page) {
  const goToBottom = page.locator(SEL.goToBottom);
  if (!(await goToBottom.isVisible().catch(() => false))) return false;
  // Telegram A can visually overlap this control with the composer even
  // though it is active. A forced click avoids Playwright's unbounded
  // pointer-interception retries while preserving Telegram's own scroll logic.
  return goToBottom
    .click({ force: true, timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
}

async function sendText(page, text) {
  const composer = page.locator(SEL.composer);
  const before = await lastOutgoingSnapshot(page);
  await composer.click();
  await composer.fill(text);
  const sentAt = Date.now();
  await composer.press("Enter");
  const message = await waitForLastOutgoingText(
    page,
    text,
    before,
    15_000,
    "send-not-visible",
  );
  return { sentAt, message };
}

async function sendImage(page, file, caption) {
  const before = await page.locator(SEL.outgoing).count();
  await page.locator(SEL.attachButton).click({ timeout: 5_000 });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page
    .getByRole("menuitem", { name: "Photo or Video", exact: true })
    .click({ timeout: 5_000 });
  const chooser = await chooserPromise;
  await chooser.setFiles(file);

  const send = page.locator(SEL.imageSend);
  await send.waitFor({ state: "attached", timeout: 15_000 });
  if (caption) {
    await page.locator(SEL.imageCaption).fill(caption);
  }
  const sentAt = Date.now();
  // The Web A attachment dialog is a zero-height portal whose child button is
  // visibly positioned; force avoids a false hidden-parent actionability wait.
  await send.click({ force: true, timeout: 5_000 });
  await waitForCountAfter(page, SEL.outgoing, before, 15_000, "image-send-not-visible");
  return { sentAt, message: page.locator(SEL.outgoing).last() };
}

function incomingCount(page) {
  return page.locator(SEL.incoming).count();
}

async function waitForIncomingAfter(page, before, timeoutMs) {
  await waitForCountAfter(page, SEL.incoming, before, timeoutMs, "no-reply");
  return { message: page.locator(SEL.incoming).last(), seenAt: Date.now() };
}

async function waitForIncomingContaining(page, before, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  const firstSeen = new Map();
  let bottomRecoveryClicks = 0;
  while (Date.now() <= deadline) {
    const incoming = page.locator(SEL.incoming);
    const count = await incoming.count();
    for (let index = before; index < count; index += 1) {
      const message = incoming.nth(index);
      const id =
        (await message.getAttribute("data-message-id")) ??
        (await message.getAttribute("data-mid")) ??
        `index-${index}`;
      const text = await messageText(message);
      if (!firstSeen.has(id)) {
        firstSeen.set(id, { at: Date.now(), text });
      }
      if (text.includes(needle)) {
        const first = firstSeen.get(id);
        return {
          message:
            id.startsWith("index-")
              ? message
              : page.locator(`${SEL.incoming}[data-message-id="${id}"]`),
          seenAt: Date.now(),
          firstSeenAt: first.at,
          firstSeenText: first.text,
          bottomRecoveryClicks,
        };
      }
    }
    // A growing streamed reply can push Web A off the live edge. Its virtual
    // scroller then leaves the new row unmounted even though the chat-list
    // preview already shows the reply. Make one bounded recovery click so the
    // marker row becomes observable without creating an unbounded UI loop.
    if (
      bottomRecoveryClicks === 0 &&
      Date.now() - startedAt >= 1_000 &&
      (await clickGoToBottom(page))
    ) {
      bottomRecoveryClicks = 1;
    }
    await page.waitForTimeout(100);
  }
  const base = await dump(page, "reply-not-matched");
  const observedLengths = [...firstSeen.values()].map(({ text }) => text.length);
  throw new Error(
    `No incoming message contained the expected marker within ${timeoutMs}ms; first-seen lengths=${observedLengths.join(",")}; see ${base}.*`,
  );
}

async function incomingIds(page) {
  return new Set(
    await page.locator(SEL.incoming).evaluateAll((rows) =>
      rows.map(
        (row, index) =>
          row.getAttribute("data-message-id") ??
          row.getAttribute("data-mid") ??
          `index-${index}`,
      ),
    ),
  );
}

async function waitForNewIncomingPhoto(
  page,
  beforeIds,
  timeoutMs,
  afterMessageId = null,
) {
  const deadline = Date.now() + timeoutMs;
  let bottomRecoveryClicks = 0;
  while (Date.now() <= deadline) {
    const incoming = page.locator(SEL.incoming);
    const count = await incoming.count();
    for (let index = 0; index < count; index += 1) {
      const message = incoming.nth(index);
      const id =
        (await message.getAttribute("data-message-id")) ??
        (await message.getAttribute("data-mid")) ??
        `index-${index}`;
      if (beforeIds.has(id)) continue;

      const numericId = Number(id);
      const numericAfterMessageId = Number(afterMessageId);
      if (
        Number.isFinite(numericId) &&
        Number.isFinite(numericAfterMessageId) &&
        numericId <= numericAfterMessageId
      ) {
        continue;
      }
      if ((await message.locator(SEL.messagePhoto).count()) > 0) {
        return { message, messageId: id, seenAt: Date.now(), bottomRecoveryClicks };
      }
    }
    if (bottomRecoveryClicks === 0 && (await clickGoToBottom(page))) {
      bottomRecoveryClicks = 1;
    }
    await page.waitForTimeout(100);
  }
  const base = await dump(page, "latex-photo-not-seen");
  throw new Error(`No new incoming photo appeared within ${timeoutMs}ms; see ${base}.*`);
}

async function countNewIncomingPhotos(page, beforeIds) {
  const incoming = page.locator(SEL.incoming);
  let count = 0;
  for (let index = 0; index < (await incoming.count()); index += 1) {
    const message = incoming.nth(index);
    const id =
      (await message.getAttribute("data-message-id")) ??
      (await message.getAttribute("data-mid")) ??
      `index-${index}`;
    if (beforeIds.has(id)) continue;
    if ((await message.locator(SEL.messagePhoto).count()) > 0) count += 1;
  }
  return count;
}

async function waitForNewIncomingMatching(
  page,
  beforeIds,
  matcher,
  timeoutMs,
  artifactName = "menu-reply-not-matched",
  previewAfterSend = null,
  outgoingCommand = null,
  afterMessageId = null,
) {
  const deadline = Date.now() + timeoutMs;
  let bottomRecoveryClicks = 0;
  while (Date.now() <= deadline) {
    const incoming = page.locator(SEL.incoming);
    const count = await incoming.count();
    for (let index = 0; index < count; index += 1) {
      const message = incoming.nth(index);
      const id =
        (await message.getAttribute("data-message-id")) ??
        (await message.getAttribute("data-mid")) ??
        `index-${index}`;
      const numericId = Number(id);
      const numericAfterMessageId = Number(afterMessageId);
      if (Number.isFinite(numericId) && Number.isFinite(numericAfterMessageId)) {
        if (numericId <= numericAfterMessageId) continue;
      }
      if (beforeIds.has(id)) continue;
      const text = await messageText(message);
      const matches =
        typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);
      if (matches) {
        return {
          message:
            id.startsWith("index-")
              ? message
              : page.locator(`${SEL.incoming}[data-message-id="${id}"]`),
          text,
          messageId: id,
          seenAt: Date.now(),
          bottomRecoveryClicks,
        };
      }
    }
    if (
      bottomRecoveryClicks === 0 &&
      previewAfterSend !== null &&
      ((await chatPreviewText(page)) !== previewAfterSend ||
        (outgoingCommand !== null && !previewAfterSend.includes(outgoingCommand))) &&
      (await clickGoToBottom(page))
    ) {
      bottomRecoveryClicks = 1;
    }
    await page.waitForTimeout(100);
  }
  const base = await dump(page, artifactName);
  throw new Error(`No new incoming message matched ${matcher} within ${timeoutMs}ms; see ${base}.*`);
}

async function chatPreviewText(page) {
  const hash = new URL(page.url()).hash;
  if (!hash) return "";
  return page
    .locator(`a[href="${hash}"]`)
    .first()
    .innerText()
    .then((text) => text.trim())
    .catch(() => "");
}

async function sendCommand(page, command, matcher, timeoutMs = 45_000) {
  if (!command.startsWith("/")) {
    throw new Error(`Refusing to send non-command text through sendCommand: ${command}`);
  }
  const beforeIds = await incomingIds(page);
  const sent = await sendText(page, command);
  const sentMessageId =
    (await sent.message.getAttribute("data-message-id")) ??
    (await sent.message.getAttribute("data-mid"));
  // The first preview change is our own outgoing command. A subsequent change
  // means the bot reply has arrived; only then should a virtual-list recovery
  // click run, otherwise it can fire too early and miss the actual reply.
  await page.waitForTimeout(100);
  const previewAfterSend = await chatPreviewText(page);
  const reply = await waitForNewIncomingMatching(
    page,
    beforeIds,
    matcher,
    timeoutMs,
    `command-${command.slice(1).replace(/\W+/g, "-")}-failed`,
    previewAfterSend,
    command,
    sentMessageId,
  );
  return {
    ...reply,
    sentAt: sent.sentAt,
    sentMessageId,
    latencyMs: reply.seenAt - sent.sentAt,
  };
}

async function messageButtonTexts(message) {
  return message
    .getByRole("button")
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.trim()).filter(Boolean));
}

async function armCallbackProbe(page, button) {
  await button.evaluate((element) => {
    window.__telecodexMenuCallbackProbe?.observers?.forEach((observer) => observer.disconnect());
    const probe = {
      startedAt: Date.now(),
      events: [],
      observers: [],
    };
    const push = (event) => {
      const serialized = JSON.stringify(event);
      if (probe.events.at(-1)?.serialized === serialized) return;
      probe.events.push({ ...event, at: Date.now(), serialized });
    };
    const buttonObserver = new MutationObserver(() => {
      push({
        type: "button-state",
        className: element.className,
        disabled: element.disabled,
        ariaBusy: element.getAttribute("aria-busy"),
        childClasses: [...element.querySelectorAll("*")]
          .map((node) => node.className)
          .filter((value) => typeof value === "string" && value)
          .slice(0, 12),
      });
    });
    buttonObserver.observe(element, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    const bodyObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          const text = (node.textContent ?? "").trim();
          if (/Switching|Creating thread|expired|Wait for the current prompt/i.test(text)) {
            push({ type: "callback-text", text: text.slice(0, 200) });
          }
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    probe.observers.push(buttonObserver, bodyObserver);
    window.__telecodexMenuCallbackProbe = probe;
  });
}

async function stopCallbackProbe(page) {
  return page.evaluate(() => {
    const probe = window.__telecodexMenuCallbackProbe;
    if (!probe) return { startedAt: null, events: [] };
    probe.observers.forEach((observer) => observer.disconnect());
    return {
      startedAt: probe.startedAt,
      events: probe.events.map(({ serialized: _serialized, ...event }) => event),
    };
  });
}

async function clickMessageButtonAndWait(
  page,
  message,
  buttonMatcher,
  stateMatcher,
  { timeoutMs = 30_000, artifactName = "callback-failed" } = {},
) {
  const button = message.getByRole("button", { name: buttonMatcher }).first();
  await button.waitFor({ state: "visible", timeout: 5_000 });
  const beforeText = await messageText(message);
  const beforeButtons = await messageButtonTexts(message);
  await armCallbackProbe(page, button);
  const clickedAt = Date.now();
  await button.click({ timeout: 5_000 });
  const clickReturnedAt = Date.now();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const text = await messageText(message).catch(() => "");
    const buttons = await messageButtonTexts(message).catch(() => []);
    if (await stateMatcher({ text, buttons, beforeText, beforeButtons })) {
      const updatedAt = Date.now();
      const probe = await stopCallbackProbe(page);
      return {
        clickedAt,
        clickReturnedAt,
        updatedAt,
        latencyMs: updatedAt - clickedAt,
        text,
        buttons,
        probe,
      };
    }
    await page.waitForTimeout(50);
  }
  await stopCallbackProbe(page);
  const base = await dump(page, artifactName);
  throw new Error(`Callback ${buttonMatcher} did not reach its expected state within ${timeoutMs}ms; see ${base}.*`);
}

async function screenshotMessage(message, name) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(ARTIFACTS_DIR, `${stamp}-${name}.png`);
  await message.screenshot({ path: outputPath, timeout: 10_000 });
  return outputPath;
}

async function waitForCountAfter(page, selector, before, timeoutMs, artifactName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ((await page.locator(selector).count()) > before) return;
    await page.waitForTimeout(100);
  }
  const base = await dump(page, artifactName);
  throw new Error(
    `${selector} did not grow beyond ${before} within ${timeoutMs}ms; see ${base}.*`,
  );
}

function normalizeMessageText(text) {
  return text.replace(/\u00a0/g, " ").trim();
}

function outgoingTextMatches(expected, actual) {
  if (actual === expected) return true;
  if (!expected.startsWith("/")) return false;

  const separator = expected.indexOf(" ");
  const command = separator === -1 ? expected : expected.slice(0, separator);
  const argument = separator === -1 ? "" : expected.slice(separator);
  return new RegExp(
    `^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@[A-Za-z0-9_]+${argument.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}$`,
  ).test(actual);
}

async function lastOutgoingSnapshot(page) {
  const outgoing = page.locator(SEL.outgoing);
  const count = await outgoing.count();
  if (count === 0) return { count, id: null, text: null };

  const message = outgoing.last();
  return {
    count,
    id:
      (await message.getAttribute("data-message-id")) ??
      (await message.getAttribute("data-mid")),
    text: await messageText(message),
  };
}

async function waitForLastOutgoingText(page, expected, before, timeoutMs, artifactName) {
  const normalizedExpected = normalizeMessageText(expected);
  const deadline = Date.now() + timeoutMs;
  let lastObserved = null;

  while (Date.now() <= deadline) {
    const outgoing = page.locator(SEL.outgoing);
    const count = await outgoing.count();
    if (count > 0) {
      const message = outgoing.last();
      const id =
        (await message.getAttribute("data-message-id")) ??
        (await message.getAttribute("data-mid"));
      const text = await messageText(message);
      const identityChanged =
        before.id !== null && id !== null
          ? id !== before.id
          : count > before.count || text !== before.text;
      lastObserved = { count, id, text, identityChanged };
      if (identityChanged && outgoingTextMatches(normalizedExpected, text)) return message;
    }
    await page.waitForTimeout(100);
  }

  const base = await dump(page, artifactName);
  throw new Error(
    `Last outgoing message did not become ${JSON.stringify(normalizedExpected)} within ${timeoutMs}ms; ` +
      `before=${JSON.stringify(before)} last=${JSON.stringify(lastObserved)}; see ${base}.*`,
  );
}

async function messageText(message) {
  const text = await message.evaluate((row) => {
    const source = row.querySelector(".text-content") ?? row;
    const clone = source.cloneNode(true);
    clone
      .querySelectorAll(".MessageMeta, .message-time, .outgoing-icon")
      .forEach((node) => node.remove());
    clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    return clone.textContent.trim();
  });
  return normalizeMessageText(text);
}

async function waitForTyping(page, sentAt, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const activity = page.locator(SEL.typing);
  while (Date.now() <= deadline) {
    const text = await activity.textContent().catch(() => "");
    if (/\btyping\b/i.test(text ?? "")) {
      const seenAt = Date.now();
      return { seenAt, elapsedMs: seenAt - sentAt, text: text.trim() };
    }
    await page.waitForTimeout(100);
  }
  const base = await dump(page, "typing-not-seen");
  throw new Error(`Typing status not seen within ${timeoutMs}ms; see ${base}.*`);
}

async function waitForTextToSettle(
  page,
  message,
  sentAt,
  { minChars = 300, stableMs = 12_000, timeoutMs },
) {
  const deadline = Date.now() + timeoutMs;
  let text = await messageText(message);
  let lastLength = text.length;
  let lastChangedAt = Date.now();
  const changes = [{ elapsedMs: lastChangedAt - sentAt, chars: lastLength }];

  while (Date.now() <= deadline) {
    await page.waitForTimeout(250);
    text = await messageText(message);
    if (text.length !== lastLength) {
      lastLength = text.length;
      lastChangedAt = Date.now();
      changes.push({ elapsedMs: lastChangedAt - sentAt, chars: lastLength });
    }
    if (lastLength >= minChars && Date.now() - lastChangedAt >= stableMs) {
      return { text, changes, finalObservedAt: lastChangedAt };
    }
  }

  const base = await dump(page, "preview-not-settled");
  throw new Error(
    `Preview did not reach ${minChars} chars and settle for ${stableMs}ms; last=${lastLength}; see ${base}.*`,
  );
}

module.exports = {
  SEL,
  dump,
  openChat,
  sendText,
  sendImage,
  sendCommand,
  incomingCount,
  incomingIds,
  waitForNewIncomingPhoto,
  countNewIncomingPhotos,
  waitForIncomingAfter,
  waitForIncomingContaining,
  waitForNewIncomingMatching,
  messageText,
  messageButtonTexts,
  clickMessageButtonAndWait,
  screenshotMessage,
  waitForTyping,
  waitForTextToSettle,
};
