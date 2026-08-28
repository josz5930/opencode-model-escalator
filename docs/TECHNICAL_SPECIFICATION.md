# Technical Specification — `opencode-model-escalator`

**Version:** 1.0 · **Date:** 2026-08-22 · **Status:** Draft for review

This document specifies the architecture and internal behavior of the plugin. It is written to
be directly implementable against the OpenCode plugin API. Product context lives in
[PRD.md](./PRD.md); numbered requirements and acceptance tests in
[REQUIREMENTS.md](./REQUIREMENTS.md); the full config schema in
[CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md).

---

## 1. Design principles

1. **Deterministic detection.** No LLM call decides whether the agent is stuck. Decisions derive
   from exit codes and normalized text.
2. **Single owner of recovery.** Exactly one state machine issues abort/replay. Do not run this
   plugin alongside another autonomous abort/replay plugin (e.g. `auto-resume`) for the same
   sessions — borrow its ideas, not a second running loop.
3. **Two failure categories, never conflated:**
   - **Category A — infrastructure:** 429, 5xx, timeouts, "unavailable", quota. Handled by
     retry / provider failover. **Never** increments capability counters.
   - **Category B — capability:** the same normalized failure persists across repair cycles.
     The only thing that drives model escalation.
4. **Monotonic capability per task.** Within a task, the stage index only increases. Reset to
   stage 0 happens only on a new top-level user task.
5. **Preserve context.** Escalation replays the current task **in the same session** so the
   stronger model inherits all prior work.
6. **Bounded spend.** The chain has a top. Past the top, stop and notify.

---

## 2. The escalation state machine

### 2.1 States

Stage index `n` selects `models[n]` from the configured chain. Default chain:

```text
stage 0: openrouter/deepseek/deepseek-v4-flash-0731   (cheapest)
stage 1: openrouter/deepseek/deepseek-v4-pro-0813
stage 2: openrouter/moonshotai/kimi-k3                (strongest)
```

### 2.2 State diagram

```text
NEW TASK
   │  (reset → stage 0)
   ▼
┌─────────────────────────── stage n ───────────────────────────┐
│  run test command                                              │
│                                                                │
│  exit == 0 ─────────────► success: clear failure state, stay   │
│                                                                │
│  exit != 0 ─► fingerprint F                                    │
│        F != previous  ─► progress: previous=F, repeats=1,      │
│                          codeChanged=false  (stay at stage n)  │
│        F == previous:                                          │
│            codeChanged? ─ no ─► do NOT count (stay)            │
│                          ─ yes ─► repeats++, codeChanged=false │
│                                                                │
│  repeats >= threshold(n) ─────────────► ESCALATE               │
└────────────────────────────────────────────────────────────────┘
        │ escalate
        ▼
   n < last?  ── yes ──► stage n+1  (abort current gen, replay in
        │                 same session, reset repeats/previous)
        │
        └── no ──► STOP: abort, toast "Max escalation reached",
                   hand back to human. No further auto-action.
```

### 2.3 Per-session state object

```ts
type StuckState = {
  stage: number;                    // index into models[]; 0 = cheapest
  previousFailure?: string;         // last failure fingerprint (Category B)
  repeats: number;                  // consecutive identical repair-cycle failures at this stage
  codeChangedSinceFailure: boolean; // a file.edited fired since the last counted failure
  escalationInFlight: boolean;      // guard: an abort+replay is underway
  pendingModel?: string;            // set to the target model id while a plugin-initiated replay
                                    // is in flight; lets the chat.message / tool hooks recognize
                                    // the plugin's *own* switch and skip user-switch / new-task
                                    // handling. Set in escalate() (§5), consumed and cleared by
                                    // the chat.message hook when it observes the replay (§6).
  currentTaskId?: string;           // identity of the active top-level user task (for reset)
};
```

State is **per-session**, held in an in-memory `Map<sessionID, StuckState>`. No persistence in
v1. Idle sessions are garbage-collected (mirror `auto-resume`'s ~10-minute idle cleanup).

---

## 3. Category B: detecting "logically stuck"

### 3.1 Signal source

Hook: **`tool.execute.after`**. For each completed tool call:

1. If `input.tool !== "bash"` (or configured shell tool) → ignore.
2. If the command does not match a `test_commands` entry → ignore.
3. Read the process **exit code** from tool metadata (`output.metadata?.exit`).
   - `exit === 0` → **success** → `clearFailureState(session)` and return.
   - `exit !== 0` → compute a **failure fingerprint** (§3.3) and feed the counter (§3.4).

> **Graceful degradation (Risk R1).** If exit code is unavailable in metadata for a build, fall
> back to scanning output for failure markers (§3.3, retained lines). If neither a matched
> command nor a usable signal is present, the plugin does nothing — it must never manufacture a
> false escalation from ambiguity.

### 3.2 Recognizing test commands

A command matches if it contains any configured `test_commands` token. Defaults:

```text
pytest · python -m pytest · npm test · npm run test · pnpm test · yarn test ·
bun test · vitest · jest · go test · cargo test · dotnet test · mvn test · gradle test
```

Matching is substring-based and case-sensitive by default; operators may extend the list.

### 3.3 Failure fingerprint (the core of the design)

**Do not hash raw output.** These are logically identical but textually different:

```text
FAILED test_auth.py::test_expiry - 2.13s
FAILED test_auth.py::test_expiry - 2.46s
```

**Step 1 — Normalize.** Scrub volatile tokens from the output:

| Volatile token | Example → replacement |
|----------------|-----------------------|
| Durations | `2.13s`, `1m4s` → `<duration>` |
| Line numbers | `foo.py:183` → `foo.py:<line>` |
| Temp paths | `/tmp/a81x/...` → `<tmp>` |
| Memory addresses | `0x71abc2` → `<addr>` |
| Hex/uuids/timestamps | → `<hex>` / `<uuid>` / `<ts>` |
| ANSI escape codes | removed |
| Absolute CWD prefixes | project root → `<root>` |

**Step 2 — Retain meaningful failure lines.** Keep only lines matching known failure markers,
which carry the semantic content:

```text
FAILED · ERROR · AssertionError · Expected: · Received: · panic: ·
Traceback · --- FAIL: · Tests failed · ✕ / ✗ (test-runner fail glyphs)
```

**Step 3 — Compose and hash.** The fingerprint is:

```text
SHA256(
    normalized-test-command
  + "\n"
  + sorted(failing-test-names)
  + "\n"
  + normalized-assertion/error-block
)
```

This yields *semantic-ish* equality: same command, same failing tests, same underlying error →
same fingerprint, regardless of run-to-run noise.

Normalization rules are **configurable and unit-tested against fixtures** so they can be tuned
without code changes (see Risk R6/R7 and REQUIREMENTS §NFR).

### 3.4 Counting — repair cycles, not raw commands

Escalation counts **failed repair cycles**, defined as: *the same failure fingerprint observed
again after the agent modified code.* This prevents two back-to-back identical `pytest` runs
(with no fix attempt between them) from counting as two failures (Risk R3).

Two hooks cooperate:

**`event` hook — track code changes:**

```ts
event: async ({ event }) => {
  if (event.type === "file.edited") {
    const s = getState(sessionIdOf(event));
    s.codeChangedSinceFailure = true;
  }
}
```

**`tool.execute.after` hook — counting logic (Category B):**

```ts
"tool.execute.after": async (input, output) => {
  if (input.tool !== config.shell_tool_name) return;   // "bash" by default (CONFIG §4.6)
  const command = String(input.args?.command ?? "");
  if (!looksLikeTestCommand(command)) return;

  const exit = Number(output.metadata?.exit);
  if (exit === 0) { clearFailureState(input.sessionID); return; }  // success

  // Category A guard: infra phrases surfacing in *test output* must not count as capability
  // failures. (Model-API Category A — 429/5xx — arrives via the `session.error` hook, §4;
  // this secondary scan catches infra that shows up as tool stdout, and returns before the
  // Category B counter so the failure is handled by exactly one path.)
  if (classifyFailure(output) === "A") { handleCategoryA(input, output); return; }

  const fingerprint = failureFingerprint(command, String(output.output ?? ""));
  const s = getState(input.sessionID);

  if (fingerprint === s.previousFailure) {
    if (s.codeChangedSinceFailure) {       // a genuine repair cycle failed
      s.repeats++;
      s.codeChangedSinceFailure = false;
    }
    // else: same failure, no fix attempted → ignore (Risk R3)
  } else {
    s.previousFailure = fingerprint;        // failure changed → progress
    s.repeats = 1;
    s.codeChangedSinceFailure = false;
  }

  if (s.repeats >= thresholdFor(s.stage)) scheduleEscalation(input.sessionID);
}
```

`clearFailureState` resets `previousFailure`, `repeats`, and `codeChangedSinceFailure` (but
**not** `stage` — a passing test does not de-escalate within a task; see G3/N3).

---

## 4. Category A: infrastructure failures

Category A is deliberately **separate** from escalation.

**Detection ownership (two entry points, never double-counted).** Model-API infrastructure
failures — HTTP 429/5xx, "unavailable", quota — arrive as **session errors** and are owned by the
**`session.error` hook** (§7); this is the *primary* Category A path and the one AC-5's "model
returns HTTP 429" exercises. The `tool.execute.after` path (§3.4) *additionally* scans a matched
test command's **own output** for the same infra phrases, catching the case where an infra failure
surfaces as tool stdout rather than a session error; on a match it routes to `handleCategoryA` and
**returns before** the Category B counter. A given failure is therefore handled by exactly one path,
and neither path ever touches `previousFailure` / `repeats`.

Signals (from `opencode-model-fallback`, which we reuse):

- **Status codes:** `429, 500, 502, 503, 504` (configurable via `retry_on_errors`).
- **Text patterns (case-insensitive):** "rate limit", "too many requests", "quota exceeded",
  "all credentials for model exhausted", "model unsupported", "service unavailable",
  "overloaded", "temporarily unavailable", transient "try again" phrasing, bare `429/503/529`.
  Extendable via `retry_on_patterns`.

**Handling:**

1. Prefer letting the **provider** (e.g. OpenRouter) do upstream endpoint failover.
2. If the plugin acts, it **retries the same model** (with backoff / cooldown), optionally moving
   to a *sibling* provider route — **without** advancing the capability stage.
3. A Category A event **never** touches `previousFailure` / `repeats`. A rate-limited Flash is
   still Flash; it is not "too dumb."

This preserves the invariant: *only demonstrated capability failure escalates capability.*

---

## 5. Escalation mechanics (same-session replay)

Reuses `opencode-model-fallback`'s proven replay engine. On escalation:

```ts
async function escalate(sessionID: string) {
  const s = getState(sessionID);
  if (s.escalationInFlight) return;                 // guard R4

  if (s.stage >= models.length - 1) {               // top of chain
    await client.session.abort({ path: { id: sessionID } });
    await notify("Max escalation reached — automation stopped.");
    return;                                          // hard stop (G5)
  }

  s.escalationInFlight = true;
  s.pendingModel = models[s.stage + 1].model;        // mark the plugin-initiated switch (§5.2, §6)
  try {
    s.stage++;                                       // monotonic up
    await client.session.abort({ path: { id: sessionID } });
    await retryWithModel(sessionID, models[s.stage]);// replay, SAME session
    s.previousFailure = undefined;                   // fresh count at new stage
    s.repeats = 0;
    s.codeChangedSinceFailure = false;
    if (config.notify_on_escalation)
      await notify(`Escalated to ${models[s.stage].model}`);
  } finally {
    s.escalationInFlight = false;
    // NOTE: pendingModel is NOT cleared here — the replay's hooks fire after promptAsync
    // returns. It is consumed and cleared by the chat.message hook that observes the replay
    // (§6), so that message is not misread as a new user task.
  }
}
```

`retryWithModel` mirrors the fallback plugin's replay:

```ts
const messages = await client.session.messages({ path: { id: sessionID }, query: { directory } });
const payload  = getLastUserPayload(messages);       // last real user message + parts
await client.session.promptAsync({
  path: { id: sessionID },
  query: { directory },
  body: {
    model: parseModel(nextModel),                    // "openrouter/deepseek/..." → {providerID, modelID}
    parts: payload.parts,
    agent: payload.agent,                            // preserve the original message's agent
    messageID: payload.messageID,
  },
});
```

**Critical:** replay uses the **existing** session, so the stronger model sees the original
request, every prior edit, all test output, and the failed attempts. **Never open a fresh clean
session for the higher tier** — the whole point of pulling in a stronger model is to let it
inspect what the cheaper one already tried (PRD U2, G4).

### 5.1 Model identifier parsing

OpenCode model IDs are `provider_id/model_id`, and OpenRouter model IDs themselves contain a `/`.
Thus `openrouter/deepseek/deepseek-v4-flash-0731` parses as:

```text
providerID = "openrouter"
modelID    = "deepseek/deepseek-v4-flash-0731"
```

Split on the **first** `/` only.

### 5.2 Re-entrancy guards (Risk R4)

`promptAsync` causes the plugin's own hooks (`chat.message`, tool hooks) to fire for the
escalation it just initiated. Without guards, the plugin can mistake its **own** automatic
escalation for a **manual** model switch, corrupting state or double-escalating. Retain the
fallback plugin's `pendingModel` / `inFlight` guards:

- `escalationInFlight` blocks a second concurrent escalate.
- A `pendingModel` marker lets hooks recognize a plugin-initiated switch and skip user-switch
  handling.

---

## 6. Reset on new user task (monotonic-per-task boundary)

Capability moves **up within a task** and resets **between tasks**.

**Detecting a new top-level task:** on the `chat.message` hook, a genuine user message that is
**not** a plugin-initiated replay marks a new task. On such a message:

```text
on chat.message(message):
    if state.pendingModel is set and message is the plugin's replay for it:
        state.pendingModel = undefined   // consume the marker — this is NOT a new task
        return                           // skip reset / user-switch handling entirely

    if reset_on_new_user_task and message is a real new user task:
        state.stage = 0                 // back to cheapest
        clearFailureState(session)
        state.currentTaskId = newTaskId
```

`pendingModel` (set in `escalate()`, §5) is the marker that distinguishes a real user task from
the plugin's own replay (§5.2): the escalation's replay message clears the marker and returns, so
it can **never** trigger a reset. If a replay is aborted before its message is observed, the marker
is superseded the next time `escalate()` runs; a genuine new user task (no marker set) always
resets normally.

Result — the cost policy:

```text
every new task:      cheapest model first
within a hard task:  capability only moves upward
top of chain stuck:  stop + notify
```

---

## 7. OpenCode integration surface

| Concern | Mechanism |
|---------|-----------|
| Test result observation | `tool.execute.after` (bash tool, exit code in `output.metadata`) |
| Code-change tracking | `event` hook, `file.edited` event |
| New-task / manual-switch detection | `chat.message` hook |
| Infra failure classification | `session.error` + error text/status inspection |
| Abort current generation | `client.session.abort(...)` |
| Read session for replay | `client.session.messages(...)` |
| Replay in same session | `client.session.promptAsync(...)` with new `model` |
| Notifications | toast via `tui.toast.show` / SDK toast |
| Debug logging | `client.app.log({ service, level, message, extra })` |
| Control tool | registered tool `model_escalator_control` (enable/disable/status/reset) |

### 7.1 Plugin skeleton

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const ModelEscalator: Plugin = async ({ client, directory, $ }) => {
  const state = new Map<string, StuckState>();
  return {
    "tool.execute.after": async (input, output) => { /* §3.4 */ },
    event:                async ({ event })      => { /* §3.4 file.edited; §6 resets */ },
    "chat.message":       async (input, output)  => { /* §6 new-task reset, guarded by pendingModel */ },
    tool: { /* model_escalator_control: enable | disable | status | reset */ },
  };
};
```

Placement: the npm package entry is `dist/plugin/model-escalator.js` (source
`src/plugin/model-escalator.ts`). Local dogfood uses a `[path, options]` tuple.
Do **not** put the adapter under `.opencode/plugin[s]/` — OpenCode auto-discovers
that directory with `options === undefined` and load would throw `models is required`.
Bare-name / npm loads require `.opencode/escalator.json`.

```text
your-project/
├── opencode.json                 # local [path, options] OR bare package name
└── .opencode/
    └── escalator.json            # required when options are not delivered
```

---

## 8. Concurrency, guards & edge cases

| Case | Behavior |
|------|----------|
| Escalation already in flight | Second `escalate()` is a no-op (`escalationInFlight`) |
| Plugin's replay fires hooks | Recognized via `pendingModel`; not treated as user switch or new task (R4) |
| Same failing test run twice, no edit | Not counted (R3) — needs `codeChangedSinceFailure` |
| Failure changes between runs | Counter resets to 1 (progress) — do not escalate on *different* failures |
| Test passes after N failures | `clearFailureState`; **stage unchanged** (no in-task de-escalation) |
| 429 during a task | Category A path; capability counters untouched (R2) |
| Top of chain still failing | Abort + notify; no further automatic action (G5) |
| Test command not recognized | Ignored; operator can extend `test_commands` |
| Exit code missing from metadata | Fallback to failure-marker scan; else no-op (R1) |
| Subagent sessions | Track per-session; do not let subagent noise escalate the parent falsely (mirror auto-resume's false-positive guards) |
| Session idle | GC state after idle timeout (~10 min) |

---

## 9. Observability

- **Toasts** (`notify_on_escalation`): on each escalation ("Escalated to <model>") and on terminal
  stop ("Max escalation reached — automation stopped").
- **Debug log** (`debug: true`): every decision — matched test command, computed fingerprint
  (truncated), repeat count, category classification, escalate/stop actions — via
  `client.app.log`.
- **Control tool `model_escalator_control` → `status`:** returns current stage, active model,
  `repeats`, `previousFailure` (truncated), `escalationInFlight`, and effective config, mirroring
  fallback's `model_fallback_control status`.

---

## 10. Testability

The detection core is pure and unit-testable in isolation:

- `looksLikeTestCommand(cmd)` — matcher table.
- `failureFingerprint(cmd, output)` — deterministic; tested against fixture pairs that must be
  equal (noise-only differences) and must differ (different failing test / assertion).
- `classifyFailure(output)` — Category A vs. B.
- Counting logic — property test: identical fingerprint + `codeChanged` twice ⇒ escalate;
  without `codeChanged` ⇒ no escalate; changed fingerprint ⇒ reset.

Acceptance-level scenarios (session replay, reset, terminal stop) are enumerated in
[REQUIREMENTS.md](./REQUIREMENTS.md) §5.
