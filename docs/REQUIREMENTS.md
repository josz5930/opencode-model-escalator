# Requirements & Acceptance Criteria — `opencode-model-escalator`

**Version:** 1.0 · **Date:** 2026-08-22 · **Status:** Draft for review

Numbered requirements are traceable to product goals in [PRD.md](./PRD.md) (G-codes) and to
mechanisms in [TECHNICAL_SPECIFICATION.md](./TECHNICAL_SPECIFICATION.md) (§-refs).
Keywords **MUST / SHOULD / MAY** per RFC 2119.

---

## 1. Functional requirements

### FR-1 — Cheap-first per task  *(G1; spec §6)*
The plugin **MUST** run every new top-level user task on the cheapest model in the chain
(`models[0]`).

### FR-2 — Category B detection  *(G2; spec §3)*
The plugin **MUST** detect a "stuck" condition deterministically as: the **same normalized
failure fingerprint** recurring across repair cycles at the current stage, using test-command
exit codes as the primary signal. It **MUST NOT** consult an LLM to decide whether the agent is
stuck.

### FR-3 — Repair-cycle gating  *(G2; spec §3.4, Risk R3)*
An identical failure **MUST** count toward escalation **only if** at least one `file.edited`
occurred since the previously counted failure. Two identical test runs with no intervening code
change **MUST NOT** both count.

### FR-4 — Threshold escalation  *(G2; spec §2, §5)*
When `repeats >= same_failure_threshold` for the current stage, the plugin **MUST** escalate to
the next stronger model, unless already at the top of the chain (see FR-8).

### FR-5 — Same-session replay  *(G4; spec §5)*
On escalation, the plugin **MUST** replay the current task in the **same session**, preserving the
original user request, prior edits, and test output for the stronger model. It **MUST NOT** open a
new/clean session for the higher tier.

### FR-6 — Monotonic capability per task  *(G3; spec §2, §3.4)*
Within a single task, the stage index **MUST** only increase. A passing test **MUST** clear the
failure counters but **MUST NOT** reduce the stage (no in-task de-escalation).

### FR-7 — Reset on new task  *(G3; spec §6)*
On a genuine new top-level user task (when `reset_on_new_user_task` is true), the plugin **MUST**
reset to `models[0]` and clear failure state. Plugin-initiated replays **MUST NOT** be treated as
new tasks.

### FR-8 — Terminal stop  *(G5; spec §5)*
When the strongest model reaches its threshold, the plugin **MUST** abort and emit a terminal
notification ("Max escalation reached — automation stopped") and **MUST NOT** take further
automatic recovery action. It **MUST NOT** loop the top model unattended.

### FR-9 — Category A separation  *(G6; spec §4)*
Infrastructure failures (matching `retry_on_errors` status codes or `retry_on_patterns` text)
**MUST** be handled on a separate path (retry / provider failover) and **MUST NOT** increment
Category B failure counters or advance the stage.

### FR-10 — Configurable model chain  *(G8; config ref)*
The model chain **MUST** be configurable via `models[]`, each entry carrying at least a `model`
identifier and an optional per-stage `same_failure_threshold`. The plugin **MUST** function with
any chain length ≥ 1.

### FR-11 — Configurable test-command matchers  *(spec §3.2; Risk R1)*
The set of recognized test commands **MUST** be configurable via `test_commands`, with sensible
defaults covering common runners.

### FR-12 — Notifications  *(spec §9)*
When `notify_on_escalation` is true, the plugin **MUST** surface a toast on each escalation and on
terminal stop.

### FR-13 — Control tool  *(spec §7, §9)*
The plugin **MUST** register a session-scoped control tool (`model_escalator_control`) supporting
`enable`, `disable`, `status`, and `reset`. `status` **MUST** report current stage, active model,
repeat count, and effective configuration.

### FR-14 — Re-entrancy safety  *(spec §5.2, Risk R4)*
The plugin **MUST** guard against its own replay being misread as a manual model switch or a new
task, via in-flight and pending-model markers. Concurrent escalations for one session **MUST NOT**
occur.

### FR-15 — Graceful degradation on missing signal  *(Risk R1)*
If a test command is unrecognized or an exit code is unavailable, the plugin **MUST** degrade
safely — it **MUST NOT** manufacture an escalation from ambiguous or absent signal.

### FR-16 — Single recovery owner  *(spec §1; PRD §7)*
The plugin **MUST** own recovery for the sessions it manages and **SHOULD** document that it not
be run alongside another autonomous abort/replay plugin for the same sessions.

---

## 2. Non-functional requirements

### NFR-1 — Determinism
Given identical inputs, `failureFingerprint`, `classifyFailure`, and the counting logic **MUST**
produce identical outputs. No wall-clock, random, or network dependence in the decision path.

### NFR-2 — Fingerprint robustness  *(Risk R6/R7)*
Normalization **MUST** scrub durations, line numbers, temp paths, memory addresses, hex/uuid/
timestamp tokens, and ANSI codes before hashing, so that noise-only differences produce equal
fingerprints and genuinely different failures produce different fingerprints. Rules **MUST** be
unit-tested against fixtures and **SHOULD** be tunable without code changes.

### NFR-3 — Performance
Hook handlers **MUST** complete quickly relative to a tool call (target < ~50 ms typical) and
**MUST NOT** block the agent's main loop on network I/O except the deliberate abort/replay calls.

### NFR-4 — Bounded state
Per-session state **MUST** be bounded and idle sessions **MUST** be garbage-collected (~10 min
idle), matching `auto-resume`'s cleanup behavior.

### NFR-5 — Zero-config viability
The plugin **MUST** run with only a `models[]` chain supplied; every other option **MUST** have a
working default (see [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md)).

### NFR-6 — Observability
With `debug: true`, every decision **MUST** be logged (matched command, truncated fingerprint,
category, repeat count, action taken) via `client.app.log`.

### NFR-7 — Isolation
State **MUST** be per-session; one session's escalation **MUST NOT** affect another's stage.

---

## 3. Configuration requirements

- **CFG-1** — All keys in [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md) **MUST** be
  honored with the documented defaults.
- **CFG-2** — Invalid config (empty `models`, unparseable model id) **MUST** fail loudly at load
  with a clear message, not silently disable escalation.
- **CFG-3** — `require_code_change_between_failures`, `reset_on_new_user_task`,
  `stop_at_max_model`, and `notify_on_escalation` **MUST** be independently toggleable.

---

## 4. Constraints & assumptions (see PRD §8-9)

- **C-1** — Tests are executed via OpenCode's `bash`/shell tool with exit code in metadata
  (Assumption A1). Degrade per FR-15 if not.
- **C-2** — `file.edited` events fire for agent edits (Assumption A2).
- **C-3** — Default model IDs resolve on the operator's provider account (Assumption A3); the
  chain is user-swappable.
- **C-4** — No "Kimi K3 Max" variant is assumed (Open Question OQ1); only verified model IDs ship
  as defaults.

---

## 5. Acceptance scenarios

Each maps to a PRD use case (U-code). All **MUST** pass for the product Definition of Done.

### AC-1 — Routine task stays cheap  *(U1 → FR-1, FR-6)*
**Given** a fresh task, **when** the agent's tests pass on the first or second run,
**then** the plugin performs **zero** escalations and the task completes on `models[0]`.

### AC-2 — Escalate on repeated logical failure  *(U2 → FR-2..FR-5)*
**Given** stage 0, **when** the agent runs a test that fails, edits code, and re-runs to the
**same** normalized failure, twice (two repair cycles),
**then** the plugin escalates to `models[1]` **in the same session**, and the replay payload
includes the original user request and prior edits/output.

### AC-3 — Different failure resets counter  *(FR-2, spec §3.4)*
**Given** stage 0 with `repeats = 1`, **when** the next failure has a **different** fingerprint,
**then** `repeats` resets to 1 and **no** escalation occurs.

### AC-4 — No fix, no count  *(U-implicit → FR-3, Risk R3)*
**Given** a failing test at stage 0, **when** the identical test is re-run with **no** `file.edited`
in between, **then** the second run does **not** increment the counter and no escalation occurs.

### AC-5 — Rate limit does not escalate  *(U4 → FR-9)*
**Given** stage 0, **when** the model returns HTTP 429 (or matches a `retry_on_patterns` phrase),
**then** the plugin handles it via the Category A path, the Category B counter is **unchanged**,
and the stage remains 0.

### AC-6 — Reset on new task  *(U5 → FR-7)*
**Given** a session escalated to `models[1]`, **when** the user sends a new top-level task,
**then** the plugin resets to `models[0]` and clears failure state; a plugin replay in between
does **not** trigger this reset.

### AC-7 — Terminal stop at top  *(U3 → FR-8)*
**Given** the session is at the strongest model and reaches its threshold on the same failure,
**then** the plugin aborts, emits "Max escalation reached — automation stopped," and takes **no**
further automatic action (no loop, no new prompt).

### AC-8 — No in-task de-escalation  *(FR-6)*
**Given** a session escalated to `models[1]`, **when** a subsequent test passes,
**then** the failure counters clear but the stage stays at `models[1]` for the remainder of the
task.

### AC-9 — Fingerprint ignores noise  *(NFR-2)*
**Given** two failing outputs differing only in durations, line numbers, temp paths, addresses,
or ANSI codes, **then** `failureFingerprint` returns **equal** hashes.

### AC-10 — Fingerprint distinguishes real changes  *(NFR-2)*
**Given** two failing outputs with different failing test names or different assertion messages,
**then** `failureFingerprint` returns **different** hashes.

### AC-11 — Re-entrancy safety  *(FR-14, Risk R4)*
**Given** an escalation replay is dispatched, **when** the plugin's own hooks fire for that
replay, **then** no second escalation and no new-task reset are triggered by it.

### AC-12 — Zero-config run  *(NFR-5)*
**Given** only a `models[]` chain in config, **then** the plugin loads and operates with all
documented defaults.

### AC-13 — Control tool status  *(FR-13)*
**Given** an active session, **when** `model_escalator_control status` is invoked, **then** it
returns the current stage, active model, repeat count, and effective config.

### AC-14 — Invalid config fails loudly  *(CFG-2)*
**Given** an empty `models` array or an unparseable model id, **then** the plugin reports a clear
error at load and does not silently no-op.

### AC-15 — Missing signal degrades safely  *(FR-15, Risk R1)*
**Given** a matched test command that exits non-zero, **when** the process exit code is **absent**
from tool metadata **and** no failure marker is found in the output, **then** the plugin does
**not** increment any Category B counter and does **not** escalate (it MAY log the skipped signal
at `debug`). The same holds when the command is not recognized as a test command at all.

---

## 6. Traceability matrix (goals → requirements → acceptance)

| PRD Goal | Requirements | Acceptance |
|----------|--------------|------------|
| G1 Cheap-first | FR-1 | AC-1, AC-12 |
| G2 Evidence-based escalation | FR-2, FR-3, FR-4 | AC-2, AC-3, AC-4 |
| G3 Monotonic per task | FR-6, FR-7 | AC-6, AC-8 |
| G4 Context preservation | FR-5 | AC-2 |
| G5 Bounded spend | FR-8 | AC-7 |
| G6 Infra/capability separation | FR-9 | AC-5 |
| G7 Deterministic, no meta-LLM | FR-2, NFR-1, NFR-2 | AC-9, AC-10 |
| G8 Drop-in | FR-10, FR-11, NFR-5 | AC-12, AC-14 |
| (Safety) Re-entrancy | FR-14 | AC-11 |
| (Safety) Graceful degradation | FR-15 | AC-15 |
| (Ops) Observability/control | FR-12, FR-13, NFR-6 | AC-13 |

Every goal has at least one requirement and one acceptance scenario; every acceptance scenario
traces back to a goal. Gaps in this matrix are defects.
