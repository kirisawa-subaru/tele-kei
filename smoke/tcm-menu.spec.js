const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { test } = require("./fixtures");
const tg = require("./telegram-page");

// Guard rails for a live-account run: the spec refuses to touch anything
// except the group and thread the operator explicitly delegated to it.
const ALLOWED_CHAT = process.env.SMOKE_ALLOWED_CHAT;
const REQUIRED_ORIGINAL_THREAD = process.env.SMOKE_REQUIRED_ORIGINAL_THREAD;
const CANONICAL_WORKSPACE = process.env.SMOKE_CANONICAL_WORKSPACE ?? path.join(__dirname, "..");
const CHAT = process.env.SMOKE_CHAT;
const EXPECTED_THREAD = process.env.SMOKE_ORIGINAL_THREAD;
const CONTEXTS_PATH = path.join(__dirname, "..", ".telecodex", "contexts.json");
const ARTIFACTS_DIR = path.join(__dirname, "artifacts");
const RESULTS_TAG = (process.env.SMOKE_RESULTS_TAG ?? "tcm-menu-results").replace(
  /[^a-zA-Z0-9_-]/g,
  "-",
);
const RESULTS_PATH = path.join(ARTIFACTS_DIR, `${RESULTS_TAG}.json`);
const MAX_UI_INTERACTIONS = Number.parseInt(
  process.env.SMOKE_MAX_UI_INTERACTIONS ?? "40",
  10,
);
const PRIOR_UI_INTERACTIONS = Number.parseInt(
  process.env.SMOKE_PRIOR_INTERACTIONS ?? "0",
  10,
);
const STDERR_PATHS = {
  bridge: process.env.SMOKE_BRIDGE_STDERR_LOG,
  appServer: process.env.SMOKE_APP_SERVER_STDERR_LOG,
};
const DISABLED_COMMANDS = ["/retry", "/auth", "/voice", "/sessions", "/session", "/abort"];
const DISABLED_REPLY = "未知或已停用的命令。用 /help 查看当前命令。";
const REGISTERED_COMMANDS = [
  ["past", "Show 1-19 unseen desktop messages (default 5)"],
  ["view", "Browse interactive and automation threads"],
  ["status", "Current thread details"],
  ["rewind", "Undo recent rounds"],
  ["skill", "Choose a skill for the next message"],
  ["new", "Start a new thread"],
  ["compact", "Compact the current thread"],
  ["model", "View and change model"],
  ["handback", "Hand thread to Codex CLI"],
  ["help", "Command reference"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function newIncomingRows(page, beforeIds) {
  const rows = page.locator(tg.SEL.incoming);
  const messages = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    const id =
      (await row.getAttribute("data-message-id")) ??
      (await row.getAttribute("data-mid")) ??
      `index-${index}`;
    if (beforeIds.has(id)) continue;
    messages.push({ id, text: await tg.messageText(row), message: row });
  }
  return messages;
}

async function domHasMessage(page, selector, id) {
  if (id === null || id === undefined) return false;
  return page.locator(selector).evaluateAll(
    (rows, expected) =>
      rows.some(
        (row) =>
          row.getAttribute("data-message-id") === expected ||
          row.getAttribute("data-mid") === expected,
      ),
    String(id),
  );
}

async function observeBestEffortDeletion(
  page,
  outgoingId,
  incomingId,
  initiallyVisible,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();
  const removedAtMs = { outgoing: null, incoming: null };
  while (Date.now() - startedAt <= timeoutMs) {
    if (
      removedAtMs.outgoing === null &&
      initiallyVisible.outgoing &&
      !(await domHasMessage(page, tg.SEL.outgoing, outgoingId))
    ) {
      removedAtMs.outgoing = Date.now() - startedAt;
    }
    if (
      removedAtMs.incoming === null &&
      initiallyVisible.incoming &&
      !(await domHasMessage(page, tg.SEL.incoming, incomingId))
    ) {
      removedAtMs.incoming = Date.now() - startedAt;
    }
    if (
      (!initiallyVisible.outgoing || removedAtMs.outgoing !== null) &&
      (!initiallyVisible.incoming || removedAtMs.incoming !== null)
    ) {
      break;
    }
    await page.waitForTimeout(200);
  }
  return {
    timeoutMs,
    initiallyVisible,
    removedAtMs,
    outgoingRemoved: initiallyVisible.outgoing && removedAtMs.outgoing !== null,
    incomingRemoved: initiallyVisible.incoming && removedAtMs.incoming !== null,
  };
}

test("TCM consolidated command surface on Telegram Web A", async ({ page }) => {
  test.setTimeout(15 * 60_000);
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
  if (!Number.isInteger(MAX_UI_INTERACTIONS) || MAX_UI_INTERACTIONS < 1) {
    throw new Error(`Invalid SMOKE_MAX_UI_INTERACTIONS=${MAX_UI_INTERACTIONS}`);
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
    modelTurnLedger: [],
    operations: [],
    artifacts: [],
    artifactErrors: [],
    initialBinding: null,
    restoration: null,
    stderrBaselines,
    stderrDeltas: null,
    failure: null,
  };
  const failures = [];
  let probeSentMessageId = null;
  let probeReplyMessageId = null;
  let probeMarker = null;
  let probeDomBeforeRewind = { outgoing: false, incoming: false };
  let rewindSucceeded = false;
  let chatOpened = false;

  const chargeInteraction = (op, kind) => {
    if (metrics.interactions >= MAX_UI_INTERACTIONS) {
      throw new Error(`UI interaction budget exhausted before ${op}`);
    }
    metrics.interactions += 1;
    metrics.interactionLedger.push({ ordinal: metrics.interactions, op, kind });
  };

  const chargeRecoveries = (op, count) => {
    for (let index = 0; index < count; index += 1) {
      chargeInteraction(`${op}-bottom-recovery`, "button-click");
    }
  };

  const recordArtifactBase = (base) => {
    for (const extension of [".png", ".html"]) {
      const artifact = `${base}${extension}`;
      if (fs.existsSync(artifact)) metrics.artifacts.push(artifact);
    }
  };

  const screenshotPage = async (name) => {
    try {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const output = path.join(ARTIFACTS_DIR, `${stamp}-tcm-${name}.png`);
      await page.screenshot({ path: output, fullPage: false, timeout: 10_000 });
      metrics.artifacts.push(output);
      return output;
    } catch (error) {
      metrics.artifactErrors.push({ name, error: error.message });
      return null;
    }
  };

  const screenshotMessage = async (message, name) => {
    try {
      const artifact = await tg.screenshotMessage(message, `tcm-${name}`);
      metrics.artifacts.push(artifact);
      return artifact;
    } catch (error) {
      metrics.artifactErrors.push({ name, error: error.message });
      return null;
    }
  };

  const runPhase = async (name, action) => {
    try {
      return await action();
    } catch (error) {
      failures.push({ phase: name, error: error.message, stack: error.stack });
      if (!metrics.operations.some((operation) => operation.op === name && operation.verdict === "FAIL")) {
        metrics.operations.push({ op: name, verdict: "FAIL", error: error.message });
      }
      return null;
    }
  };

  const command = async (
    op,
    text,
    matcher,
    { timeoutMs = 45_000, validate = null, modelTurn = false } = {},
  ) => {
    chargeInteraction(op, "command");
    if (modelTurn) {
      metrics.modelTurnsStarted += 1;
      metrics.modelTurnLedger.push({
        ordinal: metrics.modelTurnsStarted,
        op,
        startedAt: new Date().toISOString(),
      });
    }
    const startedAt = Date.now();
    const record = { op, command: text, verdict: "FAIL" };
    try {
      const reply = await tg.sendCommand(page, text, matcher, timeoutMs);
      chargeRecoveries(op, reply.bottomRecoveryClicks);
      Object.assign(record, {
        commandToReplyMs: reply.latencyMs,
        bottomRecoveryClicks: reply.bottomRecoveryClicks,
        sentMessageId: reply.sentMessageId,
        replyMessageId: reply.messageId,
        outcome: reply.text,
      });
      if (validate) await validate(reply);
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

  const click = async (op, message, buttonName, stateMatcher, timeoutMs = 20_000) => {
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
      });
      record.verdict = "PASS";
      return result;
    } catch (error) {
      record.elapsedMs = Date.now() - startedAt;
      record.error = error.message;
      throw error;
    } finally {
      metrics.operations.push(record);
    }
  };

  const assertStatus = (text, { numericContext }) => {
    assert.match(text, new RegExp(`^Thread ID:\\s*${escapeRegExp(EXPECTED_THREAD)}$`, "m"));
    assert.match(text, new RegExp(`^Workspace:\\s*${escapeRegExp(CANONICAL_WORKSPACE)}$`, "m"));
    assert.match(text, /^Model:\s*\S.+$/m);
    assert.match(text, /^Weekly usage:\s*.+$/m);
    assert.match(text, /^Context:\s*.+$/m);
    assert.match(text, /^Auth:\s*.+$/m);
    if (numericContext) {
      assert.match(
        text,
        /^Context:\s*\d+(?:\.\d+)?[km]?\s*\/\s*\d+(?:\.\d+)?[km]?$/im,
      );
    }
  };

  try {
    const initialBinding = readGroupBinding();
    metrics.initialBinding = {
      threadId: initialBinding?.threadId ?? null,
      workspace: initialBinding?.workspace ?? null,
      model: initialBinding?.model ?? null,
      proofPath: CONTEXTS_PATH,
      verifiedAt: new Date().toISOString(),
    };
    assert.strictEqual(initialBinding?.threadId, EXPECTED_THREAD);
    assert.strictEqual(initialBinding?.workspace, CANONICAL_WORKSPACE);

    await runPhase("login-and-open-delegated-chat", async () => {
      const opened = await tg.openChat(page, CHAT);
      chargeRecoveries("open-chat", opened.bottomRecoveryClicks);
      await page.locator(tg.SEL.loggedIn).waitFor({ timeout: 5_000 });
      chatOpened = true;
      const artifact = await screenshotPage("login-chat-list-at-delegated-chat");
      metrics.operations.push({
        op: "login-and-open-delegated-chat",
        verdict: "PASS",
        resolvedUrl: page.url(),
        bottomRecoveryClicks: opened.bottomRecoveryClicks,
        screenshot: artifact,
        safetyNote: "navigation starts at the hard-pinned chat hash; no unpinned chat URL is opened",
      });
    });
    if (!chatOpened) {
      throw new Error("Delegated chat did not open safely; refusing every send operation");
    }

    await runPhase("view-list", async () => {
      const view = await command(
        "view-list",
        "/view",
        /^(?:Recent threads \(\d+\):|No recent threads found\.|Cannot browse threads|Failed:)/m,
        {
          validate: ({ text }) => {
            assert.match(text, /^Recent threads \(\d+\):\nTap to switch\.$/m);
          },
        },
      );
      let buttons = await tg.messageButtonTexts(view.message);
      const firstIndicator = buttons.find((label) => /^1\/\d+$/.test(label));
      assert(firstIndicator, `Expected paginated /view menu; buttons=${buttons.join(" | ")}`);
      const totalPages = Number(firstIndicator.split("/")[1]);
      assert(totalPages >= 2, `Expected /view pagination, got ${firstIndicator}`);

      let currentPage = 1;
      let activeLabel = buttons.find((label) => /^✅\s/u.test(label)) ?? null;
      let activePage = activeLabel ? 1 : null;

      while (!activeLabel && currentPage < totalPages) {
        const nextPage = currentPage + 1;
        const nextIndicator = `${nextPage}/${totalPages}`;
        await click(
          `view-page-${nextPage}`,
          view.message,
          "Next ▶️",
          ({ buttons: updated }) => updated.includes(nextIndicator),
        );
        currentPage = nextPage;
        buttons = await tg.messageButtonTexts(view.message);
        activeLabel = buttons.find((label) => /^✅\s/u.test(label)) ?? null;
        if (activeLabel) activePage = currentPage;
      }

      assert(activeLabel, `Pinned active thread was absent from all ${totalPages} /view pages`);
      const activeCount = buttons.filter((label) => /^✅\s/u.test(label)).length;
      assert.strictEqual(activeCount, 1, `Expected one active /view row, got ${activeCount}`);
      await screenshotMessage(view.message, `view-active-page-${activePage}`);

      if (currentPage === 1) {
        await click(
          "view-roundtrip-next",
          view.message,
          "Next ▶️",
          ({ buttons: updated }) => updated.includes(`2/${totalPages}`),
        );
        await click(
          "view-roundtrip-prev",
          view.message,
          "◀️ Prev",
          ({ buttons: updated }) => updated.includes(`1/${totalPages}`),
        );
      } else {
        const previousPage = currentPage - 1;
        await click(
          "view-roundtrip-prev",
          view.message,
          "◀️ Prev",
          ({ buttons: updated }) => updated.includes(`${previousPage}/${totalPages}`),
        );
        await click(
          "view-roundtrip-next",
          view.message,
          "Next ▶️",
          ({ buttons: updated }) => updated.includes(`${currentPage}/${totalPages}`),
        );
      }
      await screenshotMessage(view.message, `view-roundtrip-page-${currentPage}`);
      metrics.operations.push({
        op: "view-active-thread",
        verdict: "PASS",
        activeLabel,
        activePage,
        totalPages,
        evidenceSemantics:
          "the unique check-mark row is the current binding; /status separately proves its pinned UUID",
      });
    });
    await runPhase("status-before-probe", async () => {
      const status = await command(
        "status-before-probe",
        "/status",
        /^(?:Chat session:|Topic session:|Failed:)/m,
        {
          validate: ({ text }) => assertStatus(text, { numericContext: false }),
        },
      );
      const contextLine = status.text.match(/^Context:\s*(.+)$/m)?.[1] ?? null;
      metrics.operations.at(-1).contextObservation = contextLine;
      metrics.operations.at(-1).contextKind = /^unavailable/i.test(contextLine ?? "")
        ? "unavailable-before-first-turn"
        : "already-observed";
      await screenshotMessage(status.message, "status-before-probe");
    });

    await runPhase("rewind-probe-turn", async () => {
      chargeInteraction("rewind-probe-turn", "model-prompt");
      probeMarker = `REWIND-PROBE-${Date.now()}`;
      const record = {
        op: "rewind-probe-turn",
        prompt: `Reply exactly: ${probeMarker}`,
        verdict: "FAIL",
      };
      const startedAt = Date.now();
      try {
        const beforeIds = await tg.incomingIds(page);
        const sent = await tg.sendText(page, record.prompt);
        probeSentMessageId =
          (await sent.message.getAttribute("data-message-id")) ??
          (await sent.message.getAttribute("data-mid"));
        metrics.modelTurnsStarted += 1;
        metrics.modelTurnLedger.push({
          ordinal: metrics.modelTurnsStarted,
          op: "rewind-probe-turn",
          startedAt: new Date(sent.sentAt).toISOString(),
        });
        const reply = await tg.waitForNewIncomingMatching(
          page,
          beforeIds,
          probeMarker,
          4 * 60_000,
          "rewind-probe-turn-failure",
          null,
          null,
          probeSentMessageId,
        );
        chargeRecoveries("rewind-probe-turn", reply.bottomRecoveryClicks);
        probeReplyMessageId = reply.messageId;
        probeDomBeforeRewind = {
          outgoing: await domHasMessage(page, tg.SEL.outgoing, probeSentMessageId),
          incoming: await domHasMessage(page, tg.SEL.incoming, probeReplyMessageId),
        };
        Object.assign(record, {
          sentMessageId: probeSentMessageId,
          replyMessageId: probeReplyMessageId,
          sendToReplyMs: reply.seenAt - sent.sentAt,
          outcome: reply.text,
        });
        assert.strictEqual(reply.text.trim(), probeMarker);
        record.verdict = "PASS";
        await screenshotMessage(reply.message, "rewind-probe-reply");
      } catch (error) {
        record.elapsedMs = Date.now() - startedAt;
        record.error = error.message;
        throw error;
      } finally {
        metrics.operations.push(record);
      }
    });

    if (probeReplyMessageId !== null) {
      await runPhase("status-after-probe", async () => {
        const status = await command(
          "status-after-probe",
          "/status",
          /^(?:Chat session:|Topic session:|Failed:)/m,
          {
            validate: ({ text }) => assertStatus(text, { numericContext: true }),
          },
        );
        metrics.operations.at(-1).contextObservation =
          status.text.match(/^Context:\s*(.+)$/m)?.[1] ?? null;
        await screenshotMessage(status.message, "status-after-probe");
      });
    } else {
      metrics.operations.push({
        op: "status-after-probe",
        verdict: "SKIP",
        reason: "probe reply was not observed",
      });
    }

    if (probeSentMessageId !== null) {
      await runPhase("rewind-one", async () => {
        const rewind = await command(
          "rewind-one",
          "/rewind 1",
          /^(?:已回滚|正在回滚|当前正在切换|当前轮次在|回滚失败：|Failed:)/m,
          {
            timeoutMs: 6 * 60_000,
            validate: ({ text }) => {
              assert.match(text, /^已回滚 1 轮。\n\n当前对话停在：\n[\s\S]+$/);
              assert(!text.includes(probeMarker), "rewind position still contains the probe marker");
              assert(!text.includes("（线程已回到开头）"), "rewind did not retain an older tail echo");
              assert(
                !text.includes("（回滚已完成，但暂时无法读取当前尾部）"),
                "rewind succeeded but failed to echo the retained tail",
              );
            },
          },
        );
        rewindSucceeded = true;
        const retainedTail = rewind.text.split("当前对话停在：\n").slice(1).join("当前对话停在：\n");
        metrics.operations.at(-1).retainedTailCharacters = retainedTail.length;
        await screenshotMessage(rewind.message, "rewind-success");

        const deletion = await observeBestEffortDeletion(
          page,
          probeSentMessageId,
          probeReplyMessageId,
          probeDomBeforeRewind,
        );
        metrics.operations.push({
          op: "rewind-best-effort-telegram-deletion",
          verdict:
            deletion.outgoingRemoved && deletion.incomingRemoved ? "PASS" : "OBSERVED",
          ...deletion,
          contract: "best-effort; non-removal is not a test failure",
        });
      });
    } else {
      metrics.operations.push({
        op: "rewind-one",
        verdict: "SKIP",
        reason: "probe prompt was not sent",
      });
    }

    if (rewindSucceeded) {
      await runPhase("past-after-rewind", async () => {
        chargeInteraction("past-after-rewind", "command");
        const record = { op: "past-after-rewind", command: "/past", verdict: "FAIL" };
        const startedAt = Date.now();
        try {
          const beforeIds = await tg.incomingIds(page);
          const sent = await tg.sendText(page, "/past");
          const sentMessageId =
            (await sent.message.getAttribute("data-message-id")) ??
            (await sent.message.getAttribute("data-mid"));
          const reply = await tg.waitForNewIncomingMatching(
            page,
            beforeIds,
            /(?:你（电脑）|Codex)：|没有尚未同步到 Telegram 的完整对话。|读取历史失败：/,
            4 * 60_000,
            "past-after-rewind-failure",
            null,
            null,
            sentMessageId,
          );
          chargeRecoveries("past-after-rewind", reply.bottomRecoveryClicks);
          await page.waitForTimeout(1_500);
          const rows = await newIncomingRows(page, beforeIds);
          const combined = rows.map(({ text }) => text).join("\n");
          Object.assign(record, {
            sentMessageId,
            replyMessageId: reply.messageId,
            commandToFirstReplyMs: reply.seenAt - sent.sentAt,
            replyMessages: rows.length,
            replyCharacters: combined.length,
            outcome: combined,
          });
          assert(combined.length > 0, "/past returned an empty list");
          assert(!combined.includes("没有尚未同步到 Telegram 的完整对话。"));
          assert(!combined.includes("读取历史失败："));
          assert(!combined.includes(probeMarker), "/past still contains the rewound probe marker");
          record.verdict = "PASS";
          await screenshotMessage(reply.message, "past-after-rewind-tail");
        } catch (error) {
          record.elapsedMs = Date.now() - startedAt;
          record.error = error.message;
          throw error;
        } finally {
          metrics.operations.push(record);
        }
      });
    } else {
      metrics.operations.push({
        op: "past-after-rewind",
        verdict: "SKIP",
        reason: "rewind did not complete successfully",
      });
    }

    await runPhase("skill-picker", async () => {
      const picker = await command(
        "skill-picker",
        "/skill",
        /^(?:用户 Skills \(\d+\)|没有找到已启用的用户自定义 skill。|当前 turn 仍在运行|读取 skills 失败：|Failed:)/m,
        {
          validate: ({ text }) => assert.match(text, /^用户 Skills \(\d+\)\n选择一个：$/m),
        },
      );
      let buttons = await tg.messageButtonTexts(picker.message);
      const firstIndicator = buttons.find((label) => /^1\/\d+$/.test(label));
      assert(firstIndicator, `Expected paginated /skill menu; buttons=${buttons.join(" | ")}`);
      const totalPages = Number(firstIndicator.split("/")[1]);
      assert(totalPages >= 2, `Expected /skill pagination, got ${firstIndicator}`);
      await screenshotMessage(picker.message, "skill-picker-page-1");

      await click(
        "skill-page-next",
        picker.message,
        "Next ▶️",
        ({ buttons: updated }) => updated.includes(`2/${totalPages}`),
      );
      await screenshotMessage(picker.message, "skill-picker-page-2");
      await click(
        "skill-page-prev",
        picker.message,
        "◀️ Prev",
        ({ buttons: updated }) => updated.includes(`1/${totalPages}`),
      );

      buttons = await tg.messageButtonTexts(picker.message);
      const skillLabel = buttons.find(
        (label) =>
          !/^\d+\/\d+$/.test(label) && label !== "◀️ Prev" && label !== "Next ▶️",
      );
      assert(skillLabel, `No selectable skill button found: ${buttons.join(" | ")}`);
      const skillName = skillLabel.split(" — ")[0];
      const beforeIds = await tg.incomingIds(page);
      chargeInteraction("skill-select-for-cancel", "button-click");
      await picker.message
        .getByRole("button", { name: skillLabel, exact: true })
        .first()
        .click({ timeout: 5_000 });
      const pending = await tg.waitForNewIncomingMatching(
        page,
        beforeIds,
        new RegExp(
          `^${escapeRegExp(skillName)}\\n[\\s\\S]*下一条普通消息会作为参数，与这个 skill 一起发送。$`,
        ),
        30_000,
        "skill-pending-card-failure",
      );
      chargeRecoveries("skill-select-for-cancel", pending.bottomRecoveryClicks);
      metrics.operations.push({
        op: "skill-select-for-cancel",
        verdict: "PASS",
        selectedSkill: skillName,
        pendingMessageId: pending.messageId,
        outcome: pending.text,
      });
      await screenshotMessage(pending.message, "skill-pending-before-cancel");

      const cancelled = await click(
        "skill-cancel",
        pending.message,
        "取消",
        ({ text, buttons: updated }) =>
          new RegExp(`^已取消：\\s*${escapeRegExp(skillName)}$`).test(text) &&
          updated.length === 0,
      );
      assert.match(cancelled.text, new RegExp(`^已取消：\\s*${escapeRegExp(skillName)}$`));
      await screenshotMessage(pending.message, "skill-cancelled");
    });

    for (const disabledCommand of DISABLED_COMMANDS) {
      await runPhase(`disabled-${disabledCommand.slice(1)}`, async () => {
        await command(
          `disabled-${disabledCommand.slice(1)}`,
          disabledCommand,
          /^(?:未知或已停用的命令。用 \/help 查看当前命令。|Failed:)/m,
          {
            validate: ({ text }) => assert.strictEqual(text.trim(), DISABLED_REPLY),
          },
        );
      });
    }

    await runPhase("registered-command-menu", async () => {
      chargeInteraction("registered-command-menu", "composer-input");
      const composer = page.locator(tg.SEL.composer);
      await composer.click();
      await composer.fill("/");
      await page.waitForTimeout(1_000);
      const observation = await page.evaluate((definitions) => {
        const visible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const candidates = [...document.querySelectorAll("body *")]
          .filter(visible)
          .map((element) => {
            const text = (element.innerText ?? "").trim();
            const observed = definitions.filter(
              ([name, description]) => text.includes(`/${name}`) && text.includes(description),
            );
            return {
              element,
              text,
              observed,
              score: observed.length,
            };
          })
          .filter(({ score }) => score > 0)
          .sort((left, right) => right.score - left.score || left.text.length - right.text.length);
        const best = candidates[0];
        if (!best) return { observedCommands: [], text: null, tag: null, className: null };
        return {
          observedCommands: best.observed.map(([name]) => name),
          text: best.text,
          tag: best.element.tagName,
          className: String(best.element.className ?? ""),
        };
      }, REGISTERED_COMMANDS);
      const artifact = await screenshotPage("registered-command-menu");
      const expectedNames = REGISTERED_COMMANDS.map(([name]) => name);
      const allCommandsVisible = observation.observedCommands.length === expectedNames.length;
      if (allCommandsVisible) {
        assert.deepStrictEqual(observation.observedCommands, expectedNames);
        const positions = expectedNames.map((name) => observation.text.indexOf(`/${name}`));
        assert(positions.every((position) => position >= 0));
        assert(positions.every((position, index) => index === 0 || position > positions[index - 1]));
      }
      metrics.operations.push({
        op: "registered-command-menu",
        verdict: allCommandsVisible ? "PASS" : "EVIDENCE_ONLY",
        expectedCommands: expectedNames,
        observedCommands: observation.observedCommands,
        domSurface: {
          tag: observation.tag,
          className: observation.className,
          text: observation.text,
        },
        screenshot: artifact,
        note: allCommandsVisible
          ? "all ten registered commands and their order were asserted from one visible DOM surface"
          : "Telegram did not expose all ten commands on one visible DOM surface; screenshot retained for review",
      });
      await composer.fill("");
      await composer.press("Escape").catch(() => {});
    });
    if (probeSentMessageId === null || rewindSucceeded) {
      await runPhase("compact", async () => {
        const compact = await command(
          "compact",
          "/compact",
          /^(?:✅ 当前 thread 已完成 compact。|当前 turn 仍在运行|当前没有可 compact 的 thread。|Compact 未确认完成：|Failed:)/m,
          {
            timeoutMs: 4 * 60_000,
            modelTurn: true,
            validate: ({ text }) => assert.strictEqual(text.trim(), "✅ 当前 thread 已完成 compact。"),
          },
        );
        await screenshotMessage(compact.message, "compact-complete");
      });

      await runPhase("status-after-compact", async () => {
        const status = await command(
          "status-after-compact",
          "/status",
          /^(?:Chat session:|Topic session:|Failed:)/m,
          {
            validate: ({ text }) => assertStatus(text, { numericContext: true }),
          },
        );
        metrics.operations.at(-1).contextObservation =
          status.text.match(/^Context:\s*(.+)$/m)?.[1] ?? null;
        await screenshotMessage(status.message, "status-after-compact");
      });
    } else {
      metrics.operations.push({
        op: "compact",
        verdict: "SKIP",
        reason: "probe was sent but could not be rewound; refusing to compact contaminated history",
      });
      metrics.operations.push({
        op: "status-after-compact",
        verdict: "SKIP",
        reason: "compact was skipped",
      });
    }
  } catch (error) {
    failures.push({ phase: "main-guard", error: error.message, stack: error.stack });
    metrics.operations.push({ op: "main-guard", verdict: "FAIL", error: error.message });
  } finally {
    try {
      const finalBinding = readGroupBinding();
      metrics.restoration = {
        beforeThreadId: metrics.initialBinding?.threadId ?? null,
        afterThreadId: finalBinding?.threadId ?? null,
        expectedThreadId: EXPECTED_THREAD,
        workspace: finalBinding?.workspace ?? null,
        menuRecoveryUsed: false,
        proofPath: CONTEXTS_PATH,
        verifiedAt: new Date().toISOString(),
        verdict: finalBinding?.threadId === EXPECTED_THREAD ? "PASS" : "FAIL",
        note: "this spec never invokes /new and never clicks a thread row",
      };
      metrics.operations.push({ op: "final-binding", ...metrics.restoration });
      if (finalBinding?.threadId !== EXPECTED_THREAD) {
        failures.push({
          phase: "final-binding",
          error: `Test-group binding is ${finalBinding?.threadId ?? "missing"}; expected ${EXPECTED_THREAD}`,
        });
      }
    } catch (error) {
      metrics.restoration = {
        beforeThreadId: metrics.initialBinding?.threadId ?? null,
        afterThreadId: null,
        expectedThreadId: EXPECTED_THREAD,
        proofPath: CONTEXTS_PATH,
        verifiedAt: new Date().toISOString(),
        verdict: "FAIL",
        error: error.message,
      };
      metrics.operations.push({ op: "final-binding", ...metrics.restoration });
      failures.push({ phase: "final-binding", error: error.message });
    }

    metrics.stderrDeltas = Object.fromEntries(
      Object.entries(STDERR_PATHS).map(([name, file]) => [
        name,
        logLinesAfter(file, stderrBaselines[name]),
      ]),
    );
    const codexStateErrors = metrics.stderrDeltas.bridge.filter(({ text }) =>
      /TeleCodex codex-state:|ERR_DLOPEN(?:_FAILED)?/i.test(text),
    );
    metrics.operations.push({
      op: "bridge-codex-state-stderr",
      verdict: codexStateErrors.length === 0 ? "PASS" : "FAIL",
      matchingLines: codexStateErrors,
      bridgeDeltaLines: metrics.stderrDeltas.bridge.length,
    });
    if (codexStateErrors.length > 0) {
      failures.push({
        phase: "bridge-codex-state-stderr",
        error: `Bridge stderr gained ${codexStateErrors.length} codex-state or ERR_DLOPEN error line(s)`,
      });
    }

    metrics.operations.push({
      op: "screenshot-artifacts",
      verdict: metrics.artifactErrors.length === 0 ? "PASS" : "FAIL",
      errors: metrics.artifactErrors,
      artifactCount: metrics.artifacts.length,
    });
    if (metrics.artifactErrors.length > 0) {
      failures.push({
        phase: "screenshot-artifacts",
        error: `${metrics.artifactErrors.length} requested screenshot artifact(s) failed`,
      });
    }

    metrics.finishedAt = new Date().toISOString();
    metrics.failure = failures.length > 0 ? { count: failures.length, items: failures } : null;
    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(
      `TCM_MENU_METRIC interactions=${metrics.interactions}/${MAX_UI_INTERACTIONS} model_turns=${metrics.modelTurnsStarted} failures=${failures.length} results=${RESULTS_PATH}`,
    );
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => new Error(error)),
      `${failures.length} TCM menu acceptance phase(s) failed`,
    );
  }
});
