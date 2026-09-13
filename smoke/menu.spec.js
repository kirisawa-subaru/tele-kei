const fs = require("fs");
const path = require("path");

const { test, expect } = require("./fixtures");
const tg = require("./telegram-page");

// Guard rails for a live-account run: the spec refuses to touch anything
// except the group and thread the operator explicitly delegated to it.
const ALLOWED_CHAT = process.env.SMOKE_ALLOWED_CHAT;
const REQUIRED_ORIGINAL_THREAD = process.env.SMOKE_REQUIRED_ORIGINAL_THREAD;
const CANONICAL_WORKSPACE = process.env.SMOKE_CANONICAL_WORKSPACE ?? path.join(__dirname, "..");
const CHAT = process.env.SMOKE_CHAT;
const EXPECTED_THREAD = process.env.SMOKE_ORIGINAL_THREAD;
const CONTEXTS_PATH = path.join(__dirname, "..", ".telecodex", "contexts.json");
const RESULTS_TAG = (process.env.SMOKE_RESULTS_TAG ?? "a2-menu-results").replace(
  /[^a-zA-Z0-9_-]/g,
  "-",
);
const RESULTS_PATH = path.join(__dirname, "artifacts", `${RESULTS_TAG}.json`);
const MAX_UI_INTERACTIONS = Number.parseInt(process.env.SMOKE_MAX_UI_INTERACTIONS ?? "25", 10);
const PRIOR_UI_INTERACTIONS = Number.parseInt(process.env.SMOKE_PRIOR_INTERACTIONS ?? "0", 10);
const STDERR_PATHS = {
  bridge: process.env.SMOKE_BRIDGE_STDERR_LOG,
  appServer: process.env.SMOKE_APP_SERVER_STDERR_LOG,
};

function parseThreadId(text) {
  return text.match(/Thread ID:\s*([0-9a-f-]{36}|\(not started yet\))/i)?.[1] ?? null;
}

function parseWorkspace(text) {
  return text.match(
    /Workspace:\s*(.*?)(?=Launch profile:|Launch behavior:|Model:|Session tokens:|Thread ID:|$)/is,
  )?.[1]?.trim() ?? null;
}

function stripSessionPrefix(label) {
  return label.replace(/^(?:✅|📁)\s*/u, "").trim();
}

function sessionIdentity(label) {
  return stripSessionPrefix(label).split(" · ").slice(0, 2).join(" · ");
}

function readGroupBinding() {
  const parsed = JSON.parse(fs.readFileSync(CONTEXTS_PATH, "utf8"));
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.contexts)
      ? parsed.contexts
      : Object.values(parsed);
  return entries.find((entry) => entry?.contextKey === ALLOWED_CHAT) ?? null;
}

function logLineCount(file) {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, "utf8");
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function logLinesAfter(file, baseline) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .slice(baseline)
    .map((text, index) => ({
      line: baseline + index + 1,
      text: text.replace(/\u001b\[[0-9;]*m/g, ""),
    }))
    .filter(({ text }) => text.length > 0);
}

function callbackObservations(result) {
  const events = result.probe.events.filter((event) => event.at >= result.clickedAt);
  const callbackText = events.find((event) => event.type === "callback-text");
  const buttonMutation = events.find((event) => event.type === "button-state");
  const browserAck = callbackText ?? buttonMutation ?? null;
  return {
    clickDispatchMs: result.clickReturnedAt - result.clickedAt,
    browserAckSurface: callbackText
      ? "callback-text"
      : buttonMutation
        ? "button-state-mutation"
        : null,
    browserAckText: callbackText?.text ?? null,
    clickToBrowserAckMs: browserAck ? browserAck.at - result.clickedAt : null,
    clickToKeyboardUpdateMs: result.latencyMs,
    callbackProbeEvents: events,
  };
}

test("TeleCodex menus: list, paginate, create, switch, and restore", async ({
  page,
}) => {
  test.skip(!CHAT, "Set SMOKE_CHAT first");
  test.skip(!EXPECTED_THREAD, "Set SMOKE_ORIGINAL_THREAD first");

  if (CHAT !== ALLOWED_CHAT) {
    throw new Error(`Refusing to open any chat except the delegated test group ${ALLOWED_CHAT}`);
  }
  if (EXPECTED_THREAD !== REQUIRED_ORIGINAL_THREAD) {
    throw new Error(
      `Refusing to run without the delegated original thread ${REQUIRED_ORIGINAL_THREAD}`,
    );
  }

  const stderrBaselines = Object.fromEntries(
    Object.entries(STDERR_PATHS).map(([name, file]) => [name, logLineCount(file)]),
  );
  const metrics = {
    startedAt: new Date().toISOString(),
    chat: CHAT,
    expectedThread: EXPECTED_THREAD,
    maxUiInteractions: MAX_UI_INTERACTIONS,
    priorInteractions: PRIOR_UI_INTERACTIONS,
    interactions: PRIOR_UI_INTERACTIONS,
    interactionLedger: [],
    modelTurnsStarted: 0,
    operations: [],
    artifacts: [],
    artifactErrors: [],
    initialBinding: null,
    createdBinding: null,
    restoration: null,
    stderrBaselines,
    stderrDeltas: null,
    failure: null,
  };
  let originalSignature = null;
  let originalIdentity = null;
  let activeLabel = null;
  let primaryError = null;
  let restoreError = null;

  const chargeInteraction = (op, kind) => {
    if (metrics.interactions >= MAX_UI_INTERACTIONS) {
      throw new Error(`UI interaction budget exhausted before ${op}`);
    }
    metrics.interactions += 1;
    metrics.interactionLedger.push({ ordinal: metrics.interactions, op, kind });
  };

  const recordArtifactBase = (base) => {
    for (const extension of [".png", ".html"]) {
      const artifact = `${base}${extension}`;
      if (fs.existsSync(artifact)) metrics.artifacts.push(artifact);
    }
  };

  const screenshot = async (message, name) => {
    try {
      const artifact = await tg.screenshotMessage(message, `a2-${name}`);
      metrics.artifacts.push(artifact);
      return artifact;
    } catch (error) {
      metrics.artifactErrors.push({ name, error: error.message });
      return null;
    }
  };

  const command = async (
    op,
    text,
    matcher,
    { timeoutMs = 45_000, failureMatcher = /^Failed:/m } = {},
  ) => {
    chargeInteraction(op, "command");
    const startedAt = Date.now();
    const record = { op, command: text, verdict: "FAIL" };
    try {
      const reply = await tg.sendCommand(page, text, matcher, timeoutMs);
      for (let index = 0; index < reply.bottomRecoveryClicks; index += 1) {
        chargeInteraction(`${op}-bottom-recovery`, "button-click");
      }
      Object.assign(record, {
        commandToReplyMs: reply.latencyMs,
        bottomRecoveryClicks: reply.bottomRecoveryClicks,
        sentMessageId: reply.sentMessageId,
        replyMessageId: reply.messageId,
        outcome: reply.text,
      });
      if (failureMatcher?.test(reply.text)) {
        throw new Error(`${op} returned a user-visible failure: ${reply.text}`);
      }
      record.verdict = "PASS";
      return reply;
    } catch (error) {
      record.elapsedMs = Date.now() - startedAt;
      record.error = error.message;
      const base = await tg.dump(page, `${op}-failure`).catch(() => null);
      if (base) {
        record.failureArtifactBase = base;
        recordArtifactBase(base);
      }
      throw error;
    } finally {
      metrics.operations.push(record);
    }
  };

  const click = async (
    op,
    message,
    buttonName,
    stateMatcher,
    { timeoutMs = 30_000, failureMatcher = /^Failed:/m } = {},
  ) => {
    chargeInteraction(op, "button-click");
    const startedAt = Date.now();
    const record = { op, button: String(buttonName), verdict: "FAIL" };
    try {
      const result = await tg.clickMessageButtonAndWait(
        page,
        message,
        buttonName,
        stateMatcher,
        { timeoutMs, artifactName: `${op}-failure` },
      );
      Object.assign(record, {
        elapsedMs: Date.now() - startedAt,
        outcome: result.text,
        buttons: result.buttons,
        ...callbackObservations(result),
      });
      if (failureMatcher?.test(result.text)) {
        throw new Error(`${op} returned a user-visible failure: ${result.text}`);
      }
      record.verdict = "PASS";
      return result;
    } catch (error) {
      record.elapsedMs = Date.now() - startedAt;
      record.error = error.message;
      const base = await tg.dump(page, `${op}-failure`).catch(() => null);
      if (base) {
        record.failureArtifactBase = base;
        recordArtifactBase(base);
      }
      throw error;
    } finally {
      metrics.operations.push(record);
    }
  };

  const clickForReply = async (op, message, buttonName, matcher, timeoutMs = 4 * 60_000) => {
    chargeInteraction(op, "button-click");
    const beforeIds = await tg.incomingIds(page);
    const button = message.getByRole("button", { name: buttonName, exact: true }).first();
    const clickedAt = Date.now();
    await button.click({ timeout: 5_000 });
    const reply = await tg.waitForNewIncomingMatching(
      page,
      beforeIds,
      matcher,
      timeoutMs,
      `${op}-failure`,
    );
    metrics.operations.push({
      op,
      button: buttonName,
      clickedAt,
      replyMessageId: reply.messageId,
      clickToReplyMs: reply.seenAt - clickedAt,
      outcome: reply.text,
      verdict: "PASS",
    });
    return reply;
  };

  const newIncomingTexts = async (beforeIds) => {
    const rows = page.locator(tg.SEL.incoming);
    const texts = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const id =
        (await row.getAttribute("data-message-id")) ??
        (await row.getAttribute("data-mid")) ??
        `index-${index}`;
      if (!beforeIds.has(id)) texts.push(await tg.messageText(row));
    }
    return texts;
  };

  const restoreFromList = async (listMessage, opPrefix) => {
    for (let pageNumber = 1; pageNumber <= 9; pageNumber += 1) {
      const buttons = await tg.messageButtonTexts(listMessage);
      const candidates = buttons.filter((label) => /^(?:✅|📁)/u.test(label));
      const originalLabel =
        candidates.find((label) => stripSessionPrefix(label) === originalSignature) ??
        candidates.find((label) => sessionIdentity(label) === originalIdentity);
      if (originalLabel) {
        const switched = await click(
          `${opPrefix}-select-original`,
          listMessage,
          originalLabel,
          ({ text }) => /^(?:Switched session\.|Failed:)/m.test(text),
        );
        return { switched, selectedLabel: originalLabel, pageNumber };
      }

      const indicator = buttons.find((label) => /^\d+\/\d+$/.test(label));
      const nextLabel = buttons.find((label) => label === "Next ▶️");
      if (!indicator || !nextLabel) {
        throw new Error(
          `Original session identity ${originalIdentity} was not present in the paginated menu`,
        );
      }
      const [, current, total] = indicator.match(/^(\d+)\/(\d+)$/);
      const nextIndicator = `${Number(current) + 1}/${total}`;
      await click(
        `${opPrefix}-page-${pageNumber + 1}`,
        listMessage,
        nextLabel,
        ({ buttons: updated }) => updated.includes(nextIndicator),
        { timeoutMs: 15_000, failureMatcher: null },
      );
    }
    throw new Error("Original session was not found within the 9-page /sessions limit");
  };

  try {
    const initialBinding = readGroupBinding();
    metrics.initialBinding = {
      threadId: initialBinding?.threadId ?? null,
      workspace: initialBinding?.workspace ?? null,
      verifiedAt: new Date().toISOString(),
    };
    expect(initialBinding?.threadId).toBe(EXPECTED_THREAD);

    const opened = await tg.openChat(page, CHAT);
    for (let index = 0; index < opened.bottomRecoveryClicks; index += 1) {
      chargeInteraction("open-chat-bottom-recovery", "button-click");
    }

    let sessions = await command(
      "sessions-list",
      "/sessions",
      /^(?:Recent threads\s+\(\d+\):|No recent threads found\.|Failed:)/m,
      { failureMatcher: /^(?:No recent threads found\.|Failed:)/m },
    );
    let sessionButtons = await tg.messageButtonTexts(sessions.message);
    activeLabel = sessionButtons.find((label) => label.startsWith("✅"));
    expect(activeLabel, `session buttons: ${sessionButtons.join(" | ")}`).toBeTruthy();
    originalSignature = stripSessionPrefix(activeLabel);
    originalIdentity = sessionIdentity(activeLabel);
    const listRecord = metrics.operations.at(-1);
    listRecord.buttonCount = sessionButtons.length;
    listRecord.activeSessionIdentity = originalIdentity;
    await screenshot(sessions.message, "sessions-page-1");
    expect(sessionButtons).toContain("显示");
    if (!process.env.SMOKE_SKIP_DETAILS) {
      const details = await clickForReply(
        "sessions-show-page-1",
        sessions.message,
        "显示",
        /文件夹：\/.*名称：.*最后输入：/s,
      );
      expect(details.text).toMatch(/^1\. \d{4}-\d{2}-\d{2}T/m);
      expect(details.text).toContain("文件夹：/");
      expect(details.text).toContain("名称：");
      expect(details.text).toContain("最后输入：");
      await screenshot(details.message, "sessions-details-page-1");
    }

    const paginationFailures = [];
    if (!process.env.SMOKE_SKIP_PAGINATION) {
      const pageIndicator = sessionButtons.find((label) => /^\d+\/\d+$/.test(label));
      const nextLabel = sessionButtons.find((label) => label === "Next ▶️");
      if (!pageIndicator || !nextLabel) {
        const error = new Error(
          `Pagination was not exposed by /sessions; buttons=${sessionButtons.join(" | ")}`,
        );
        paginationFailures.push(error);
        metrics.operations.push({
          op: "sessions-pagination",
          verdict: "FAIL",
          error: error.message,
        });
      } else {
        const [, current, total] = pageIndicator.match(/^(\d+)\/(\d+)$/);
        const nextIndicator = `${Number(current) + 1}/${total}`;
        try {
          await click(
            "sessions-page-next",
            sessions.message,
            nextLabel,
            ({ buttons }) => buttons.includes(nextIndicator),
            { timeoutMs: 15_000, failureMatcher: null },
          );
          await screenshot(sessions.message, "sessions-page-2");
          await click(
            "sessions-page-prev",
            sessions.message,
            "◀️ Prev",
            ({ buttons }) => buttons.includes(pageIndicator),
            { timeoutMs: 15_000, failureMatcher: null },
          );
          await screenshot(sessions.message, "sessions-page-1-restored");
        } catch (error) {
          paginationFailures.push(error);
        }
      }
    }

    sessionButtons = await tg.messageButtonTexts(sessions.message).catch(() => []);
    const returnedActiveLabel = sessionButtons.find(
      (label) =>
        label.startsWith("✅") && sessionIdentity(label) === originalIdentity,
    );
    if (!returnedActiveLabel) {
      sessions = await command(
        "sessions-list-after-pagination-observability-loss",
        "/sessions",
        /^(?:Recent threads\s+\(\d+\):|No recent threads found\.|Failed:)/m,
        { failureMatcher: /^(?:No recent threads found\.|Failed:)/m },
      );
      sessionButtons = await tg.messageButtonTexts(sessions.message);
      activeLabel = sessionButtons.find((label) => label.startsWith("✅"));
      expect(activeLabel).toBeTruthy();
    } else {
      activeLabel = returnedActiveLabel;
    }

    const created = await command(
      "new-session-create",
      "/new",
      /^(?:New thread created(?: for this topic)?\.|Failed:)/m,
      { timeoutMs: 60_000 },
    );
    expect(await tg.messageButtonTexts(created.message)).toEqual([]);
    await screenshot(created.message, "new-session-created");
    const newThread = parseThreadId(created.text);
    const newWorkspace = parseWorkspace(created.text);
    expect(newThread).toMatch(/^[0-9a-f-]{36}$/i);
    expect(newThread).not.toBe(EXPECTED_THREAD);

    const createdBinding = readGroupBinding();
    metrics.createdBinding = {
      threadId: createdBinding?.threadId ?? null,
      expectedNewThreadId: newThread,
      workspace: newWorkspace,
      expectedWorkspace: CANONICAL_WORKSPACE,
      verifiedAt: new Date().toISOString(),
      verdict: createdBinding?.threadId === newThread ? "PASS" : "FAIL",
    };
    expect(createdBinding?.threadId).toBe(newThread);
    if (newWorkspace !== CANONICAL_WORKSPACE) {
      const semanticError =
        `Phone /new did not use the canonical workspace: ` +
        `${newWorkspace ?? "missing"} != ${CANONICAL_WORKSPACE}`;
      const createRecord = [...metrics.operations]
        .reverse()
        .find((operation) => operation.op === "new-session-create");
      if (createRecord) {
        createRecord.verdict = "FAIL";
        createRecord.semanticError = semanticError;
      }
      const base = await tg.dump(page, "new-session-workspace-mismatch").catch(() => null);
      if (base) {
        if (createRecord) createRecord.failureArtifactBase = base;
        recordArtifactBase(base);
      }
      throw new Error(semanticError);
    }

    const restored = await click(
      "switch-original",
      sessions.message,
      activeLabel,
      ({ text }) => /^(?:Switched session\.|Failed:)/m.test(text),
    );
    await screenshot(sessions.message, "switch-restored");
    expect(parseThreadId(restored.text)).toBe(EXPECTED_THREAD);

    chargeInteraction("past-full-five", "command");
    const beforePastIds = await tg.incomingIds(page);
    const pastSent = await tg.sendText(page, "/past");
    const pastReply = await tg.waitForNewIncomingMatching(
      page,
      beforePastIds,
      /stream-tail-\d+/,
      4 * 60_000,
      "past-full-five-failure",
    );
    await page.waitForTimeout(1_500);
    const pastTexts = await newIncomingTexts(beforePastIds);
    const pastText = pastTexts.join("");
    const roleBlocks = pastText.match(/(?:你（电脑）|Codex)：/g) ?? [];
    expect(roleBlocks).toHaveLength(5);
    expect(pastText.length).toBeGreaterThan(1_000);
    expect(pastText).not.toContain("中间内容已截断");
    metrics.operations.push({
      op: "past-full-five",
      command: "/past",
      sentMessageId:
        (await pastSent.message.getAttribute("data-message-id")) ??
        (await pastSent.message.getAttribute("data-mid")),
      replyMessageId: pastReply.messageId,
      commandToTailMs: pastReply.seenAt - pastSent.sentAt,
      replyMessages: pastTexts.length,
      replyCharacters: pastText.length,
      shownMessages: roleBlocks.length,
      verdict: "PASS",
    });
    await screenshot(pastReply.message, "past-full-five");

    if (paginationFailures.length > 0) {
      throw new Error(
        `Pagination acceptance failed: ${paginationFailures.map((error) => error.message).join("; ")}`,
      );
    }
  } catch (error) {
    primaryError = error;
    metrics.failure = { stage: "main", error: error.message, stack: error.stack };
  }

  try {
    const beforeRestore = readGroupBinding();
    let recovery = null;
    if (beforeRestore?.threadId !== EXPECTED_THREAD) {
      if (!originalIdentity) {
        throw new Error("Cannot restore: original session identity was never captured");
      }
      const recoveryMenu = await command(
        "restore-recovery-list",
        "/sessions",
        /^(?:Recent threads\s+\(\d+\):|No recent threads found\.|Failed:)/m,
        { failureMatcher: /^(?:No recent threads found\.|Failed:)/m },
      );
      recovery = await restoreFromList(recoveryMenu.message, "restore-recovery");
      await screenshot(recoveryMenu.message, "restore-recovery-complete");
    }
    const afterRestore = readGroupBinding();
    metrics.restoration = {
      beforeThreadId: beforeRestore?.threadId ?? null,
      afterThreadId: afterRestore?.threadId ?? null,
      expectedThreadId: EXPECTED_THREAD,
      menuRecoveryUsed: Boolean(recovery),
      recoveryPage: recovery?.pageNumber ?? null,
      selectedLabel: recovery?.selectedLabel ?? activeLabel ?? null,
      proofPath: CONTEXTS_PATH,
      verifiedAt: new Date().toISOString(),
      verdict: afterRestore?.threadId === EXPECTED_THREAD ? "PASS" : "FAIL",
    };
    if (afterRestore?.threadId !== EXPECTED_THREAD) {
      throw new Error(
        `Test-group binding remained ${afterRestore?.threadId ?? "missing"}; expected ${EXPECTED_THREAD}`,
      );
    }
  } catch (error) {
    restoreError = error;
    metrics.restoration = {
      ...(metrics.restoration ?? {}),
      verdict: "FAIL",
      error: error.message,
    };
    if (!metrics.failure) metrics.failure = { stage: "restore", error: error.message };
  }

  metrics.stderrDeltas = Object.fromEntries(
    Object.entries(STDERR_PATHS).map(([name, file]) => [
      name,
      logLinesAfter(file, stderrBaselines[name]),
    ]),
  );
  metrics.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(
    `MENU_METRIC interactions=${metrics.interactions}/${MAX_UI_INTERACTIONS} model_turns=${metrics.modelTurnsStarted} results=${RESULTS_PATH}`,
  );

  if (restoreError) throw restoreError;
  if (primaryError) throw primaryError;
});
