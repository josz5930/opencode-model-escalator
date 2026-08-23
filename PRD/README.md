# opencode-model-escalator — Documentation Set

> An OpenCode plugin that escalates through a **cheap → progressively stronger** model chain when a coding agent gets *logically stuck* (the same test keeps failing) or when the current model is *rate-limited / unavailable*.

This folder contains the full specification and product documentation for the plugin.
It is the authoritative reference for anyone building, reviewing, or evaluating the plugin.

## Reading order

| # | Document | Purpose | Primary audience |
|---|----------|---------|------------------|
| 1 | [PRD.md](./PRD.md) | Product Requirements — problem, goals, users, scope, success metrics, prior art. | Product, stakeholders |
| 2 | [REQUIREMENTS.md](./REQUIREMENTS.md) | Numbered functional & non-functional requirements with acceptance criteria and test scenarios. | Engineering, QA |
| 3 | [TECHNICAL_SPECIFICATION.md](./TECHNICAL_SPECIFICATION.md) | Architecture, state machine, failure fingerprinting, escalation mechanics, OpenCode hook usage. | Engineering |
| 4 | [CONFIGURATION_REFERENCE.md](./CONFIGURATION_REFERENCE.md) | Complete configuration schema, every key, defaults, examples. | Engineering, users |
| 5 | [ATTRIBUTION.md](./ATTRIBUTION.md) | Third-party attribution, upstream licenses (MIT vs. GPLv3), the copyleft boundary, and this project's own license. | Engineering, legal |

## The one-paragraph summary

A coding agent driven by OpenCode normally runs on a single model. This plugin makes the
*model itself* an escalating resource. New tasks always start on the cheapest model. The
plugin watches deterministic signals — test-command exit codes and a normalized failure
**fingerprint** — and when the *same* logical failure survives repeated repair attempts, it
**escalates one step up a configured model chain**, replaying the task **in the same session**
so the stronger model inherits all prior context. It separately handles transient
infrastructure failures (429 / 5xx / unavailable) as a distinct concern. Capability only ever
moves **upward within a task**; each **new user task resets to the cheapest model**. When the
strongest model is also stuck, the plugin **stops and notifies** rather than burning tokens.

## Canonical decisions (single source of truth)

These values are fixed across all documents in this set. If a document appears to contradict
this table, this table wins and the document is a defect.

| Decision | Value |
|----------|-------|
| Plugin / package name | `opencode-model-escalator` |
| Default model chain (cheap → strong) | `openrouter/deepseek/deepseek-v4-flash-0731` → `openrouter/deepseek/deepseek-v4-pro-0813` → `openrouter/moonshotai/kimi-k3` |
| Default escalation threshold | 2 consecutive identical failing **repair cycles** per stage |
| Escalation requires code change between failures | Yes (default `true`) |
| De-escalation within a task | Never (capability only moves up) |
| Reset trigger | New top-level user task → back to cheapest model |
| Terminal behavior | Strongest model stuck → abort + notify, do not loop |
| Session strategy | Replay in the **same** session (preserve context) — never a fresh session |
| Two failure categories | A = infrastructure (429/5xx/unavailable) · B = capability (same failure persists) |
| Project license | **MIT** (compatible with the forked MIT upstream) — see [ATTRIBUTION.md](./ATTRIBUTION.md) |
| Upstream code we may fork | `opencode-model-fallback` only (**MIT**) |
| Upstream we may copy code from | Never `opencode-auto-resume` (**GPLv3**, copyleft) — concepts only |

## Prior art this design builds on

- **[`@shutovks/opencode-model-fallback`](https://github.com/ShutovKS/opencode-model-fallback)** by ShutovKS — licensed **MIT**. Provides the proven model-switch / same-session replay machinery, but triggers only on **provider/API failures** (Category A). We **fork its code** — the replay engine and `pendingModel` / `inFlight` guard patterns — and must retain its MIT notice.
- **[`opencode-auto-resume`](https://github.com/Mte90/opencode-auto-resume)** by Mte90 — licensed **GPL-3.0** (copyleft). Provides battle-tested **stall / loop / hallucination** detection ideas, but recovers with the *same* model. We **borrow concepts only, never its code** — copying GPLv3 code would force this whole plugin under GPLv3.

The novel contribution of `opencode-model-escalator` is the **Category B capability
circuit-breaker**: "same logical failure across repair cycles → next, stronger model."

**Attribution and licensing details — including the redistribution notices we must ship and the
hard rule against copying GPLv3 code — are in [ATTRIBUTION.md](./ATTRIBUTION.md).**

## Status

Specification stage. No implementation is included in this folder; these documents define
what will be built and how its behavior will be judged complete.
