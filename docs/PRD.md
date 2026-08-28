# Product Requirements Document — `opencode-model-escalator`

**Status:** Draft for review · **Version:** 1.0 · **Date:** 2026-08-22
**Owner:** antr0p1c@tuttosulgsm.com

---

## 1. Overview

`opencode-model-escalator` is an [OpenCode](https://opencode.ai) plugin that turns the model
running a coding agent into an **escalating resource**. Instead of committing an entire task to
one model, the plugin starts every task on the **cheapest capable model** and automatically
**escalates to progressively stronger (and more expensive) models** only when the agent proves
it is *logically stuck* — the same test failure survives repeated repair attempts — or when the
current model is *rate-limited or unavailable*.

The design goal is a **capability circuit-breaker**, not a generic API-failover router: spend
the least money that gets the job done, escalate only on evidence of genuine difficulty, and
**stop before an unattended token-burning loop can form**.

## 2. Problem statement

Teams running autonomous coding agents face a three-way tension:

1. **Cost.** Always using the strongest model is expensive; most coding steps are routine and a
   cheap model handles them perfectly well.
2. **Capability.** Always using a cheap model means hard tasks stall — the agent loops on the
   same failing test, editing code and re-running tests without ever converging.
3. **Reliability.** Transient provider problems (rate limits, 5xx, endpoint outages) look, from
   the agent's seat, like the model "not working," and can strand a session entirely.

Existing OpenCode plugins each solve *one slice*:

- `opencode-model-fallback` recovers from **infrastructure** failures (429/5xx/quota) but has no
  notion of "the model tried and genuinely could not solve this."
- `opencode-auto-resume` recovers from **stalls and loops** but retries with the **same** model,
  so a genuinely-too-hard task loops forever at the same capability tier.

**No existing plugin implements "logical coding failure → progressively stronger model."** That
is the gap this product fills.

## 3. Goals & non-goals

### 3.1 Goals

- **G1 — Cheap-first.** Every new task begins on the cheapest configured model.
- **G2 — Evidence-based escalation.** Escalate only on a *deterministic* signal that the agent
  is stuck: the **same normalized test failure** persisting across repair attempts.
- **G3 — Monotonic capability within a task.** Within one task, capability only moves **up**,
  never down — no oscillation.
- **G4 — Context preservation.** The stronger model inherits the full session: original request,
  prior edits, test output, and failed attempts. Escalation replays **in the same session**.
- **G5 — Bounded spend.** When the strongest model is also stuck, **stop and notify** — never
  loop the most expensive model unattended.
- **G6 — Separate infra failures from capability failures.** Treat 429/5xx/unavailable
  (Category A) distinctly from "same failure persists" (Category B).
- **G7 — Deterministic, no meta-LLM.** Detection uses exit codes and text normalization, not a
  second LLM call asking "are you stuck?".
- **G8 — Drop-in.** Installable as a single local plugin file with zero required config beyond a
  model chain; sensible defaults for everything else.

### 3.2 Non-goals

- **N1** — Not a general request router / load balancer across providers for cost arbitrage on
  *every* call. Escalation is reactive to difficulty, not predictive per-prompt routing.
- **N2** — Not a replacement for OpenRouter's own upstream endpoint failover. Category A relies
  on the provider where possible.
- **N3** — Not automatic **de-escalation** within a task. Once escalated, the task stays at the
  higher tier until it ends.
- **N4** — Not a test framework. The plugin observes test commands the agent already runs; it
  does not define, discover, or run tests itself.
- **N5** — No cross-session or persisted learning in v1 (state is per-session, in-memory).

## 4. Users & use cases

### 4.1 Primary persona — "Autonomous-agent operator"

Runs OpenCode agents to implement features / fix bugs largely unattended, and is cost-sensitive.
Wants cheap models to do the bulk of the work and a stronger model to be pulled in *only* when a
task is genuinely hard — without babysitting the model picker.

**Use case U1 — Routine task.** Agent implements a small change on Flash; tests pass first or
second try. Plugin never escalates. Cost stays minimal.

**Use case U2 — Hard bug.** Flash edits code, re-runs `pytest`, same assertion fails; edits
again, same assertion fails. Plugin escalates to Pro **in the same session**. Pro sees Flash's
attempts and the failing output, and fixes it. Cost incurred only for the hard part.

**Use case U3 — Genuinely too hard / spec bug.** Flash → Pro → Kimi all keep hitting the same
failure. Plugin **stops**, emits "Max escalation reached — automation stopped," and hands back to
the human instead of burning Kimi tokens overnight.

**Use case U4 — Rate limit.** Flash returns 429 mid-task. This is **Category A**: the plugin
retries / lets provider failover handle it, and does **not** mistake a rate limit for the model
being "too dumb." No capability escalation is charged against Flash.

**Use case U5 — New task after a hard one.** After U2 escalated to Pro, the operator sends "Now
add OAuth support." Plugin **resets to Flash** and starts the cheap-first cascade again.

### 4.2 Secondary persona — "Plugin maintainer"

Wants a small, well-bounded state machine that owns recovery, with clear config, debug logging,
and no race conditions from two competing autonomous recovery loops.

## 5. Product scope

### 5.1 In scope (v1)

- Cheap-first model selection per task.
- Category B detection: normalized failure fingerprinting on test-command exit codes.
- "Repair cycle" gating: only count a repeat when a **code change occurred** between two
  identical failures.
- Per-stage escalation threshold (default 2).
- Same-session replay on escalation, reusing the proven fallback replay engine.
- Terminal stop + notification at the top of the chain.
- Category A handling: retry / defer to provider failover for 429/5xx/unavailable, kept separate
  from Category B counters.
- Reset-to-cheapest on new user task.
- Configurable model chain, test-command matchers, thresholds, and toggles.
- Toast notifications on escalation and terminal stop; debug logging.
- A session-scoped control tool (enable / disable / status / reset).

### 5.2 Out of scope (v1)

- Automatic de-escalation within a task (N3).
- Cross-session / persistent learning (N5).
- LLM-based "are you stuck?" judgment (G7).
- Non-`bash`/non-shell test execution paths (see Risk R1).
- Distinct "Max"/premium **variants** of a model unless present in the user's own catalog
  (see §8, Kimi K3 Max uncertainty).

## 6. Success metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Cost efficiency** | Share of completed tasks finished entirely on the cheapest model | ≥ 70% of routine tasks never escalate |
| **Escalation precision** | Escalations that were *justified* (a real repeated failure) vs. spurious | ≥ 95% justified; ~0 escalations from transient/infra causes |
| **Runaway prevention** | Unattended sessions that loop the top model without stopping | 0 (hard requirement — see G5) |
| **Context continuity** | Escalations that preserve prior session context | 100% (same-session replay) |
| **Resolution lift** | Hard tasks (U2-class) resolved after escalation that a cheap-only run would not resolve | Positive; measured in dogfooding |
| **False de-escalation** | In-task drops back to a cheaper model | 0 |

## 7. Prior art & differentiation

| Capability | model-fallback | auto-resume | **model-escalator (this)** |
|------------|:--:|:--:|:--:|
| Recover from 429 / 5xx / unavailable (Category A) | ✅ | ✅ (streaming) | ✅ (delegates + retries) |
| Same-session replay of last user request | ✅ | ✅ | ✅ (reuses fallback engine) |
| Stall / loop / hallucination detection | ❌ | ✅ | ➖ (borrows ideas, single owner) |
| **Escalate to a stronger model on repeated logical failure (Category B)** | ❌ | ❌ | ✅ **(novel)** |
| Normalized test-failure fingerprinting | ❌ | ➖ (loop hashing) | ✅ |
| Monotonic cheap→strong per task, reset on new task | ❌ | ❌ | ✅ |
| Terminal stop at top of chain | ➖ | ➖ | ✅ |

**Build recommendation (from planning):** fork `opencode-model-fallback` for its replay engine
and guard patterns; add the Category B detector and the escalation state machine; borrow
detection *concepts* (not a second running loop) from `opencode-auto-resume`. A **single state
machine owns recovery** to avoid abort/replay race conditions.

## 8. Key assumptions & open questions

- **A1** — The agent executes tests through OpenCode's normal `bash`/shell tool, and tool
  metadata exposes the process **exit code**. (Confidence: medium-high. See Risk R1.)
- **A2** — `file.edited` events fire for the agent's code edits, enabling "code changed between
  failures" gating. (Confidence: high — event is documented.)
- **A3** — The default model IDs resolve on the user's OpenRouter account. Operators may swap the
  chain freely; nothing is hard-coded beyond defaults.
- **OQ1 — "Kimi K3 Max."** A distinct OpenRouter model named *Kimi K3 Max* could **not** be
  verified; only `moonshotai/kimi-k3` is confirmed. If the operator's `/models` catalog exposes a
  `max` variant, it can be appended to the chain — but v1 does **not** assume it exists.
- **OQ2** — Optimal default threshold. Default is 2 repair cycles per stage; may be tuned after
  dogfooding.

## 9. Risks & mitigations

| ID | Risk | Impact | Mitigation |
|----|------|--------|------------|
| **R1** | Tests are not run via the `bash` tool, or exit code is absent from metadata | Category B never triggers | Configurable `test_commands` matchers; fall back to parsing failure markers in output; document the requirement; degrade gracefully (no false escalations) |
| **R2** | Infra hiccup misread as capability failure | Wasteful/incorrect escalation | Strict Category A/B separation; infra signals never increment the Category B counter |
| **R3** | Two identical `pytest` runs with no edit between them counted as two failures | Premature escalation | `require_code_change_between_failures` gate (default on) — count **repair cycles**, not raw commands |
| **R4** | Plugin's own escalation replay re-fires `chat.message`/tool hooks and is mistaken for a manual switch | Corrupted state / double escalation | Reuse fallback plugin's `pendingModel` / `inFlight` guards; single-owner state machine |
| **R5** | Unattended loop at the top model | Cost blowout | Terminal **stop + notify** at chain top (hard requirement G5) |
| **R6** | Fingerprint too strict (never matches) or too loose (always matches) | Missed or spurious escalation | Documented, testable normalization rules; tunable; unit-tested against fixture outputs |
| **R7** | Non-determinism in test output (timestamps, addresses, durations) breaks equality | Missed escalation | Normalization step scrubs volatile tokens before hashing |

## 10. Rollout

1. **v0 — local plugin.** Source adapter at `src/plugin/model-escalator.ts`, loaded via a
   `[path, options]` tuple (never auto-discovered `.opencode/plugins/`, which gets
   `options === undefined` and would throw `models is required`). Dogfood on real tasks with
   `debug: true`.
2. **v1 — npm package.** `opencode-model-escalator` publishes `dist/plugin/model-escalator.js`.
   Bare-name / GitHub loads require `.opencode/escalator.json`; a package-name `[name, options]`
   tuple does not deliver options.

## 11. Definition of done (product)

- A routine task completes on the cheapest model with zero escalations (U1).
- A hard task escalates cheap→strong **in one session**, preserving context, and resolves at a
  higher tier (U2).
- A rate limit does **not** cause capability escalation (U4).
- A new user task resets to the cheapest model (U5).
- An unsolvable task **stops** at the top of the chain with a clear notification and never loops
  (U3).
- Every behavior above is covered by an acceptance scenario in
  [REQUIREMENTS.md](./REQUIREMENTS.md).
