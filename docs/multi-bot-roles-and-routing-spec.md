# Multi-Bot Roles, Handoff, and Routing — Product Spec

> Status: design settled in discussion 2026-09-01. Not implemented.
>
> Scope: the product/interaction layer that sits **above** the Core Router. This
> spec does not re-open transport, writer ownership, or delivery — those are
> settled in `docs/telecodex-app-server-shared-writer-architecture.md` and
> partly built (see §10).
>
> Assumes 技术路线 C: one Telegram worker per token, one Core Router owning all
> threads, shared Codex app-server.
>
> Body in English per the formal-deliverable convention; the source discussion
> was in Chinese.

---

## 0. Summary

A bot is **a set of defaults, not a set of permissions**. All bots share one
capability ceiling and one persona; they differ in working directory, loaded
skills, default output shape, and stated function.

Work moves between bots through two mechanisms that are halves of one design:

- **push** — a deliberately thin handoff document, and
- **pull** — on-demand read of another thread's transcript as *evidence*.

Pull is what lets push stay thin. Agent-to-agent dialogue is an explicit
non-goal.

One bot (the **secretary**) is the low-friction entry point. It keeps the daily
record and proposes routing. It is the only bot with a restricted write surface,
and the restriction exists to protect the entry point's usability, not to
contain risk.

---

## 1. Bot model

### 1.1 A bot is a bundle of defaults

A bot profile is exactly:

```
{ default_workspace, default_skill_set, default_output_shape, function_statement }
```

**The capability ceiling is identical across all bots.** A health-monitoring bot
that needs to write a script writes the script. Splitting capability by topic
produces absurd outcomes and was rejected.

Consequence: "I need to do something adjacent" never requires a handoff. Only
"I will be working in another domain for a while" does.

### 1.2 Persona binds to model, not to bot

One model maintains one stable persona (Claude → 桐沢昴). Bots are **working
surfaces of the same persona**, not separate characters. Register shifts by
surface — terse in the secretary, confirmation-heavy when writing, report-shaped
in engineering — the way one person's register shifts by setting.

Two reasons this is load-bearing rather than cosmetic:

1. A thin persona is a functional input to the model: "how do I talk to this
   user" becomes a known quantity instead of a per-turn inference.
2. In a multi-agent environment, "who is speaking" needs a stable anchor. Codex
   workers are not 昴. Binding persona to model rather than to bot keeps that
   distinction clean as more runtimes are added.

**Anti-goal:** per-bot names and personalities. Three faces means three tone
specifications to maintain, each drifting toward performance.

### 1.3 Identity is carried by surface, not by voice

Where "which mode am I in" needs to be visible, express it through the Telegram
bot's avatar, display name (`ops`, `life`), and command menu. Not
through personality.

---

## 2. Thread-level state

`workspace` is a property of the thread, not of the bot. This is already the
case in `context_bindings`. The bot profile supplies `default_workspace` at
thread creation only.

Consequences:

- Changing directory does not require changing bot.
- No stickiness: a temporary excursion into another repo does not persist into
  the next thread of the same bot.
- `/cd` must be driven by an inline keyboard over recent + bookmarked
  directories. Typing paths on a phone is not an acceptable interaction.

---

## 3. Handoff and spawn

### 3.1 Two distinct operations

| Op | Effect | Use |
| --- | --- | --- |
| `handoff <bot>` | current thread changes `bot_key` + profile; conversation continues | "we've been talking and now it needs code" |
| `spawn <bot>` | source thread stays live; new thread created with a handoff doc | "an idea surfaced here and should be worked elsewhere" |

Because the Core Router owns the thread and `bot_key` is only a delivery
channel, a handoff is a binding mutation. **No context is copied.** This is a
concrete dividend of 路线 C over per-bot bridges; the implementation must not
hard-code `bot_key` into thread creation paths.

The secretary's outbound routing is almost always **spawn**, not handoff. Its
value is being a line that carries no consequence; transferring it away destroys
that.

### 3.2 The handoff document is deliberately thin

Its correct failure mode is **too thin**, never too thick.

A self-contained handoff document must summarize, and summarization loss is
*invisible*: the receiving side gets something that looks complete and reasons
forward from a truncated premise. On a phone you will not audit it.

Structure — three parts, nothing else:

1. **Current concern** — one sentence.
2. **Settled decisions** — one line each, every line carrying `thread_id` +
   turn number.
3. **Open questions**.

Background is not written. It is *pointed at*. A receiving bot that finds itself
short on context reads the source thread (§4). This makes loss recoverable
instead of silent.

Secondary benefit: a thin document is cheap enough to generate mid-conversation.
An expensive one makes you avoid handing off at all.

### 3.3 Profile transition marker

When a handoff changes the profile, the prior conversation was produced under a
different skill set. Insert an explicit boundary item into the thread recording
who transferred, to which bot, and what capabilities changed.

Without it, the failure is: the model promised "I'll look that up with X" before
the handoff, X is gone afterward, and the model reasons as though a tool
vanished for no reason.

### 3.4 Storage

```
handoff/YYYYMMDD-HHMM-<from>-<to>.md
```

The target thread carries only a reference. Two reasons for a standalone file:
a rejected or unsatisfying handoff can be re-run because the document survives;
and "where did this piece of work come from" is a question worth being able to
answer months later.

Most handoff docs are procedural and are never archived. Load-bearing ones get
promoted into `docs/archive/` per the doc standard — which is then an `mv`, not
a rewrite.

---

## 4. Cross-thread read (pull)

### 4.1 Position

Bots may read one another's transcripts. Bots may **not** hold conversations
with one another.

This is a difference of kind, not degree. Agent dialogue generates new
assertions that enter both contexts unreviewed, and the errors compound — A's
guess becomes B's premise, B's inference flows back to A. Reading a transcript
retrieves content that already exists, cannot change by being read, and is
citable to a specific turn. Misreading is recoverable by looking again;
compounded negotiation error is not.

This is the same stance already fixed in the `codex-thread` skill: *evidence
source, not authority; conclusions treated as strawman; factual claims still go
through the verification pipeline; citations carry turn numbers.* Cross-bot read
is that pattern applied to a different source, and should reuse its shape rather
than invent one.

### 4.2 Carried over from `codex-thread`, mandatory

- **Map before reading.** Pulling tens of KB of tool output into context is the
  primary failure. A turn map (timestamps, tool-call counts, output byte sizes,
  first line of user input) is an admission requirement for cross-thread read,
  not an optimization. Engineering threads make this non-negotiable.
- **Privacy discipline.** Read only turns relevant to the current task; skip
  personal segments without quoting or paraphrasing. This matters *more* here
  than in the CLI case because domain separation is sharper — life/health
  threads carry emotional content and body data that an engineering bot has no
  reason to receive. The prompt-level convention that suffices for
  single-operator use is backstopped by the read topology in §5.
- **Cite by turn number.**

### 4.3 Not carried over

**`codex-thread` reads a settled artifact; bot threads are live.** A read may
occur while the source thread is being written.

Reads must therefore take a **snapshot upper bound**: fix a `seq` from
`turn_events` / `turn_requests.last_seq` at read start and read only up to it.
Never tail.

**`codex-thread` is human-triggered** — you supply the id. Agent-initiated pull
adds a problem it does not have: *how does the bot know which thread to read?*
That is retrieval, not reading, and it is specified in §4.4.

### 4.4 Retrieval — two layers, not three

1. **Pointers in the handoff document.** Primary path, covers most cases. The
   source bot writes "relevant material is thread X turns 12–18"; the receiving
   bot does not search.
2. **A cross-bot thread index.** One row per thread: `bot_key`, time window,
   one-line summary, workspace/project touched. The Core Router generates the
   summary row after a thread goes quiet. Covers retrieval with no handoff link
   ("that conversation about cycling last week").
3. **Full-text / embedding search: do not build.** Thread volume will not reach
   the scale that justifies it, and grep results are verifiable while vector
   results can only be trusted.

---

## 5. Read topology

Access is asymmetric by real need. Do not build an N×N ACL matrix.

Default grant:

- secretary → any bot
- any bot → secretary
- within-domain peers

Engineering ↔ health/life cross-reads have no real demand and carry a privacy
cost. They require a one-time explicit grant.

**Exception that carries its weight:** a pointer contained in a handoff document
automatically confers read access to the referenced thread and turn range.

This puts the cost in the right place — work you have already decided to move
flows without friction, while a bot deciding on its own initiative to go looking
through another domain requires one tap.

---

## 6. Secretary bot

### 6.1 Function

Reads, answers, records, routes. Its value is that a thought can be thrown at it
without being formed first.

### 6.2 Boundary: no consequences, not "no work"

"The secretary doesn't do work" is unenforceable — answering questions *is*
work, and it is the entirety of what a quick-ask bot does. That boundary erodes
within a month.

The enforceable boundary is **leaves no consequences**: does not write the
knowledge base, does not modify code, does not commit. Everything it produces is
discardable.

The reason is interaction cost, not risk. The moment it can write, you will
spend half a second considering the consequences before throwing a thought at
it, and the entry point is gone. Restricting its write surface is for its own
usability.

Note this is a narrower and differently-motivated rule than "partition bots by
consequence," which was considered and rejected for the general case (§1.1).

### 6.3 Session boundary

- One new session per day.
- **Day boundary at 04:00, not 00:00.** A calendar cut bisects a conversation
  still running at 1am, and this will be annoying the first time it happens.
- At session start, load the previous 3–7 days of daily records.

The daily cut severs the raw transcript, not continuity. Continuity moves to a
better carrier: a thin artifact the secretary wrote itself, costing almost
nothing to load. This is §3.2's principle again — thin push, retrievable pull.

**A daily record is a handoff document from yesterday's self to today's self.**
Reuse the structure; do not invent a second one.

---

## 7. Daily record

### 7.1 Two layers, strictly separated

**Raw layer — append-only.** Timestamp, what happened, pointer. No
interpretation, no merging, no importance judgment. *Summarizing in this layer
is prohibited.*

**Synthesis layer — optional, written at the top of the same file.** Generated
on request only. Nothing should auto-produce a daily narrative nobody reads.

Separation makes the failure recoverable: when synthesis judges wrong, the raw
entries are intact and can be re-read. A single-layer record fails invisibly.

### 7.2 Coverage — the largest hole in the design

**Most of a day's work does not happen in the secretary's line.** It happens in
the engineering bot, in CLI sessions, in Codex workers. A secretary recording
only what it can see produces a record that systematically omits the day's
heaviest work and retains only the loose questions — precisely the lower-value
half.

Three sources, in priority order:

1. **Skeleton generated from facts.** The Core Router already observes thread
   open/close/binding-change events. Same-day commits authored by the bot
   identity are a hard record of what was done. Aligning those two
   yields the skeleton with zero model judgment: cannot omit, cannot fabricate.
2. **Body pushed by each bot.** On thread close, each bot appends one line
   describing what that line of work did. Cheaper than cross-domain reads by the
   secretary, requires no cross-domain grant, and each bot knows its own
   salience.
3. **Synthesis on request only.**

**Governing rule: anything derivable from facts must not be derived from
summarization.** The summary layer will be wrong, and wrong in ways that do not
look wrong.

### 7.3 Audit trail

All write paths land under git, and the writing bot commits under a dedicated
author identity that is distinct from the human operator's.

This is not a permission control. The concern it addresses is that on a phone
you cannot see what was done — and restoring from backup requires first knowing
something needs restoring. `git log --author=<bot> --since=1.week` is then a
complete answer to "what did the bots touch," reusing a mechanism that already
exists and adding no friction.

---

## 8. Scattered-thought capture

Target: a dedicated **零碎想法整理** section inside the relevant project card.

- Agent may write freely into that section.
- Content **must not** enter the card body or any implementation document
  without a further round of discussion or manual editing.

This defers the *adoption* judgment while letting the agent make the *placement*
judgment — which is correctly assigned, since the agent knows what cards exist
and only the operator can decide what gets adopted.

Two implementation hazards worth pre-empting:

- **Duplication and fragmentation.** The same thought gets said twice, or
  amended later. Every entry carries a timestamp, is append-only, and amendments
  explicitly reference the prior entry. **No "smart merging"** — that is
  adoption-stage work.
- **Thoughts with no card.** The agent must not create cards; card creation has
  schema consequences and belongs to `/track-project`. Route to a single
  `未归类` card's idea section and let card creation wait for a terminal.

Notes are under git, so a genuine wreck is recoverable.

---

## 9. Routing

### 9.1 Cost asymmetry sets the default

- Routed too early or wrong → a thread you must go close, accumulating into a
  population of half-dead threads.
- Not routed → content stays with the secretary, indexed in the daily record,
  retrievable at any time. Cost ≈ 0.

Therefore the default is **strongly biased toward not routing**, and the
suggestion threshold is set well above intuition. This is dictated by the cost
structure, not by conservatism.

The reason single-message classification fails: fifteen characters cannot
separate "training question" from "I want to write a script to analyze this"
from — most commonly — "just asking, this belongs nowhere."

### 9.2 Three triggers

1. **End-of-day batch (primary).** Review the day's record, propose "these
   several should go to X / Y," accept in one pass. Highest classification
   quality because it has full-day context, and it interrupts nothing.
2. **Accumulation.** A thread of thought has gone several rounds, or the same
   topic recurs, before the bot says "this looks like it's becoming work — move
   it to X?"
3. **Explicit instruction.** Always available.

This is how an actual secretary works: not bursting in per message asking who
owns it, but batching and walking through at a fixed time.

### 9.3 Suggest, never auto-execute

Hard constraint. If the secretary can spawn on its own, throwing out one
sentence may silently create a thread elsewhere — and you will start
pre-judging whether it will misroute. That destroys the "throw it without
thinking" property. This is about the nature of the entry point, not a safety
preference.

Suggestions are delivered as inline keyboard buttons.

### 9.4 Target state is queryable

The Core Router owns all bindings and thread lifecycle, so target state is a
local SQLite query, not an unknown.

**Mechanical state — free.** Alive / busy (in-flight turn) / `workspace` / last
activity / pending outbox. Query on every suggestion.

**Semantic state — not free.** "How far along is it, can it be interrupted"
requires reading thread content, costing tokens and latency.

Layering: real-time suggestions consult mechanical state only; the end-of-day
batch reads semantic state, where one read amortizes across many suggestions.

Given available state, spawn-vs-handoff becomes conditional rather than fixed:

| Target state | Choice |
| --- | --- |
| idle, `workspace` already relevant | handoff into the existing thread — context continuous, nothing rebuilt |
| busy, in another workspace, or parked on an unanswered question | spawn |
| thread stale or topic unrelated | spawn |

### 9.5 Time-of-check to time-of-use

The gap between a suggestion being generated and a button being pressed on a
phone is unbounded. State shown in a suggestion is advisory.

**State must be re-queried at execution time.** If it changed — a handoff target
is now busy — degrading to spawn is correct, **but the degradation must be
reported.** Same discipline as the outbox rule: failures and downgrades are
never silent.

### 9.6 Busy is not a refusal

The Core Router needs a durable inbound queue. The `inbound_updates` schema is
reserved, but the worker has not wired polling/handlers through it yet. When a
target is busy the eventual options are *enqueue* or *open a new line* — never
*cannot route*.

Write this into the interface layer. The natural implementation is
`if busy: reject`, and it will block you exactly when you most need to move
something.

### 9.7 Self-alignment loop

The secretary records every routing decision into the daily record: what it
proposed, what you tapped, whether you overrode it.

The record is being written anyway, so the cost is near zero, but it gives the
secretary its own alignment material — next time it can see "last time this kind
of thing went to engineering, and it wasn't overridden."

This is one of the few parts of the design that improves on its own. Wire it
early.

---

## 10. Skills and Telegram surface

### 10.1 Bot profile layout

A profile is a directory, reusing the CLI skill format exactly:

```
profiles/<botKey>/
  SYSTEM.md      # function, boundaries, default output shape
  skills/        # same format as .claude/skills/
  commands/      # slash commands
```

The Core Router injects it at session creation. Existing skills
(`/track-project`, `/decode`, …) can be symlinked in. **Do not invent a second
skill format.**

### 10.2 Bot skills are not a subset of CLI skills

CLI skills assume you can read 200 lines of output, review a diff, and follow
up. None of that holds on a phone. The same `/track-project` needs a bot-side
wrapper: three-line summary in chat, full content to a file, a button attached.

This interaction layer is real work. Do not underestimate it.

### 10.3 Use Telegram's native affordances

Currently unused, and they are advantages over the CLI rather than limitations:

- **BotFather command menu.** One menu per token — aligned with 路线 C by
  construction. Slash commands save far more typing on a phone than in a CLI,
  but discoverability is far worse; the menu is what closes that gap, and it
  also isolates command namespaces across bots sharing a group.
- **Inline keyboards.** Directory selection, project-card selection, write
  confirmation, skill selection, routing acceptance — none of these should
  require typing.
- **Message editing.** Long-running task progress edits one message instead of
  flooding the chat.
- **Pin.** Current thread workspace/state pinned at the top, removing "where am
  I."

### 10.4 Multi-bot group rules (carried forward, unchanged)

- Only a genuine forum group treats `message_thread_id` as a topic. Do not split
  sessions merely because the field is present.
- With multiple bots in one group, respond only to commands, mentions, or
  replies; ignore unauthorized members silently.
- Topic delivery failure must never silently fall back to the main group and be
  marked successful. The outbox retains the full `{bot_key, chat_id, topic_id}`
  — already the case in `telegram_outbox`.

---

## 11. Mapping to what exists

Already built in `.telecodex/state.sqlite`:

| Table | Relevance |
| --- | --- |
| `context_bindings` | `bot_key`, `thread_id`, `workspace` — §2 and §3.1 handoff are binding mutations over this table |
| `turn_requests` / `turn_events` | `last_seq` / `seq` provide the §4.3 snapshot upper bound |
| `inbound_updates` | reserved schema only; worker integration is still required for §9.6 enqueue-when-busy |
| `telegram_outbox` | `{bot_key, chat_id, topic_id}` retained; §10.4 |
| `reply_routes` | reply-to-thread resolution |

New surface required by this spec:

- bot profile registry (§10.1) — filesystem, not a table
- cross-bot thread index (§4.4) — one summary row per thread, written by the
  Router after a thread goes quiet
- daily record files, two-layer (§7)
- handoff documents (§3.4)
- routing decision log (§9.7) — may live inside the daily record
- read-grant records for cross-domain exceptions (§5)

---

## 12. Non-goals

- Agent-to-agent dialogue.
- Per-bot personas.
- Capability partitioning by topic.
- Embedding / vector retrieval over threads.
- Automatic routing without confirmation.
- Automatic project-card creation.
- Redis / Postgres. Unix socket + SQLite remains sufficient at single-machine
  scale.

---

## 13. Open questions

1. Where do bot profiles live — inside this repository, or a separate repo shared
   with the CLI skill tree?
2. Which bots exist at first cut. Discussion converged on the secretary plus a
   small number of purpose-defined bots, but the concrete list is undecided;
   the recommendation is to let boundaries emerge from use rather than
   designing them up front.
3. Retention policy for the thread index and daily records.
4. Whether the synthesis layer (§7.1) is worth building at all in v1.
