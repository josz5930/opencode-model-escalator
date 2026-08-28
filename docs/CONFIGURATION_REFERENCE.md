# Configuration Reference — `opencode-model-escalator`

**Version:** 1.0 · **Date:** 2026-08-26 · **Status:** Implemented (v0.1.0)

This is the authoritative list of every configuration key, its type, default, and meaning.
Behavior is specified in [TECHNICAL_SPECIFICATION.md](./TECHNICAL_SPECIFICATION.md); requirements
in [REQUIREMENTS.md](./REQUIREMENTS.md). Defaults here are the single source of truth for NFR-5
(zero-config viability).

---

## 1. Where configuration lives

Two channels, in precedence order:

1. **Inline plugin `options`** — delivered **only** by a local `[path, options]` tuple in
   `opencode.json` (this repo dogsfoods `./src/plugin/model-escalator.ts` this way). A
   package-name or `github:` `[name, options]` tuple does **not** pass options.
2. **`.opencode/escalator.json` sidecar** — required for a bare-name / npm / `github:` load,
   where OpenCode invokes the plugin with `options === undefined`.

If neither supplies a config, load fails loudly with `` `models` is required `` (CFG-2,
AC-14). Do **not** place the adapter under `.opencode/plugin[s]/`: that directory is
auto-discovered with `options === undefined`.

```text
your-project/
├── opencode.json                 # bare name, or local [path, options] tuple
└── .opencode/
    └── escalator.json            # required for bare-name / npm / github: loads
```

The published package entry is `dist/plugin/model-escalator.js`.

## 2. Minimal (zero-config) example

Only a model chain is required; everything else defaults. There is **no shipped default
chain** (C-4 / OQ1) — the ids below are an **example**. A package-name tuple does not
deliver options; the equivalent sidecar is `.opencode/escalator.json`.

```jsonc
// .opencode/escalator.json  (bare-name / npm / github: load)
{
  "models": [
    { "model": "openrouter/google/gemini-2.5-flash-lite" },
    { "model": "openrouter/openai/gpt-4.1-nano" },
    { "model": "openrouter/openai/gpt-5-nano" }
  ]
}
```

```jsonc
// opencode.json — local path tuple (the only form that delivers inline options)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./src/plugin/model-escalator.ts", {
      "models": [
        { "model": "openrouter/google/gemini-2.5-flash-lite" },
        { "model": "openrouter/openai/gpt-4.1-nano" },
        { "model": "openrouter/openai/gpt-5-nano" }
      ]
    }]
  ]
}
```

## 3. Full example (all keys, at defaults)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/deepseek/deepseek-v4-flash-0731",
  "plugin": [
    ["./src/plugin/model-escalator.ts", {
      "enabled": true,

      "models": [
        { "model": "openrouter/google/gemini-2.5-flash-lite", "same_failure_threshold": 2 },
        { "model": "openrouter/openai/gpt-4.1-nano",          "same_failure_threshold": 2 },
        { "model": "openrouter/openai/gpt-5-nano",            "same_failure_threshold": 2 }
      ],

      "test_commands": [
        "pytest", "python -m pytest",
        "npm test", "npm run test", "pnpm test", "yarn test", "bun test",
        "vitest", "jest",
        "go test", "cargo test", "dotnet test", "mvn test", "gradle test"
      ],

      "require_code_change_between_failures": true,
      "reset_on_new_user_task": true,
      "stop_at_max_model": true,
      "notify_on_escalation": true,

      "retry_on_errors": [429, 500, 502, 503, 504],
      "retry_on_patterns": [],
      "provider_failover": true,
      "max_infra_retries": 2,
      "infra_retry_cooldown_ms": 1000,

      "fingerprint": {
        "normalize_durations": true,
        "normalize_line_numbers": true,
        "normalize_temp_paths": true,
        "normalize_addresses": true,
        "strip_ansi": true,
        "failure_markers": [
          "FAILED", "ERROR", "AssertionError", "Expected:", "Received:",
          "panic:", "Traceback", "--- FAIL:", "Tests failed", "✕", "✗"
        ]
      },

      "shell_tool_name": "bash",
      "mutating_tools": ["edit", "write", "patch", "multiedit", "apply_patch"],
      "idle_cleanup_ms": 600000,
      "notify": true,
      "debug": false
    }]
  ]
}
```

---

## 4. Key reference

### 4.1 Core

| Key | Type | Default | Requirement | Description |
|-----|------|---------|-------------|-------------|
| `enabled` | boolean | `true` | FR-13 | Master on/off. Also toggleable per-session via the control tool. |
| `models` | array<ModelStage> | **required** | FR-10 | Ordered chain, **cheapest first**. See §4.2. Must contain ≥ 1 entry; empty ⇒ load error (CFG-2). |
| `test_commands` | string[] | see §3 | FR-11 | Substring matchers identifying a test run in a `bash` command. Extend for custom runners. |

### 4.2 `ModelStage` object (each entry of `models`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | **required** | OpenCode model id, `provider/model` (OpenRouter ids add a nested `/`, e.g. `openrouter/deepseek/deepseek-v4-flash-0731`). Parsed on the **first** `/`. |
| `same_failure_threshold` | integer ≥ 1 | `2` | Consecutive identical failing **repair cycles** at this stage before escalating. Per-stage override of the default. |

### 4.3 Escalation policy toggles

| Key | Type | Default | Requirement | Description |
|-----|------|---------|-------------|-------------|
| `require_code_change_between_failures` | boolean | `true` | FR-3 | If true, an identical failure counts only when a `file.edited` occurred since the last counted failure (prevents premature escalation — Risk R3). |
| `reset_on_new_user_task` | boolean | `true` | FR-7 | If true, a new top-level user task resets to `models[0]` and clears failure state. |
| `stop_at_max_model` | boolean | `true` | FR-8 | Governs the terminal **latch only**. Reaching the top stage's threshold **always** aborts the runaway top-model run and notifies — bounded spend is a hard invariant per the canonical decisions table (abort + notify, never loop), so the abort is unconditional. If true (hard-recommended), the session then latches and stays inert until a new task/reset. If false, it is not latched, so a later genuinely-stuck cycle is aborted again rather than the automation shutting down — **discouraged** (noisy), but it never loops the model unattended. `false` can no longer request the old "let the top model keep looping" behavior; that violated bounded spend. |
| `notify_on_escalation` | boolean | `true` | FR-12 | Toast on each escalation and on terminal stop. |

### 4.4 Category A (infrastructure) handling

| Key | Type | Default | Requirement | Description |
|-----|------|---------|-------------|-------------|
| `retry_on_errors` | number[] | `[429, 500, 502, 503, 504]` | FR-9 | HTTP status codes treated as infrastructure failures (never capability). |
| `retry_on_patterns` | string[] | `[]` | FR-9 | Extra case-insensitive regex sources matched against error text (in addition to built-in phrases: "rate limit", "quota exceeded", "service unavailable", etc.). Bounded to 64 entries of ≤ 1000 chars each (ReDoS guard). |
| `provider_failover` | boolean | `true` | FR-9 | Master switch for automatic Category-A recovery. When `false`, an infrastructure failure is surfaced (notify) and **no** same-model retry is dispatched. |
| `max_infra_retries` | integer ≥ 0 | `2` | FR-9 | Bounded same-model retries for a single Category-A (infrastructure) failure before giving up and notifying. `0` disables automatic infra retry. Never touches capability/stage state. |
| `infra_retry_cooldown_ms` | integer ≥ 0 | `1000` | FR-9 | Base backoff between Category-A retries. The Nth retry waits `infra_retry_cooldown_ms × 2^(N−1)` (exponential). Applied by the adapter's side-effect layer, never in the deterministic decision path (NFR-1). |

### 4.5 Fingerprint tuning  *(NFR-2, Risk R6/R7)*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `fingerprint.normalize_durations` | boolean | `true` | Replace `2.13s`, `1m4s` → `<duration>`. |
| `fingerprint.normalize_line_numbers` | boolean | `true` | Replace `foo.py:183` → `foo.py:<line>`. |
| `fingerprint.normalize_temp_paths` | boolean | `true` | Replace `/tmp/...` → `<tmp>`. |
| `fingerprint.normalize_addresses` | boolean | `true` | Replace `0x71abc2` → `<addr>` (and hex/uuid/timestamps). |
| `fingerprint.strip_ansi` | boolean | `true` | Remove ANSI escape codes before hashing. |
| `fingerprint.failure_markers` | string[] | see §3 | Lines retained as the semantic failure content. Must be non-empty when supplied. |
| `fingerprint.project_root` | string | *(adapter-supplied)* | Absolute checkout path scrubbed to `<root>` before hashing so a checkout location never perturbs a fingerprint (AC-9). Left unset, the adapter fills it with OpenCode's live working directory; set it explicitly only to override. |

### 4.6 Operational

| Key | Type | Default | Requirement | Description |
|-----|------|---------|-------------|-------------|
| `shell_tool_name` | string | `"bash"` | FR-2 | Name of the tool whose commands are inspected for test runs. |
| `mutating_tools` | string[] | `["edit", "write", "patch", "multiedit", "apply_patch"]` | FR-3 | Tool names whose **successful** completion counts as a code change for the repair-cycle counter. Extend to recognize mutations made via non-default tools (formatters, generators, custom edit tools). Must be non-empty when supplied. |
| `idle_cleanup_ms` | integer | `600000` | NFR-4 | Idle session TTL before per-session state is GC'd. |
| `notify` | boolean | `true` | FR-12 | Master toggle for toasts (independent of escalation-specific `notify_on_escalation`). |
| `debug` | boolean | `false` | NFR-6 | Verbose per-decision logging via `client.app.log`. |

---

## 5. Control tool  *(FR-13)*

The plugin registers `model_escalator_control` with four actions:

| Action | Effect |
|--------|--------|
| `enable` | Activate escalation for the current session. |
| `disable` | Deactivate for the current session (agent stays on its current model). |
| `status` | Report current stage, active model, `repeats`, truncated `previousFailure`, `escalationInFlight`, `terminated`, and effective config. |
| `reset` | Clear session overrides and failure state; return to `models[0]` and config defaults (including restoring `enabled` to the configured baseline). |

> **Authorization (accepted risk).** The control tool has no built-in authorization: any actor
> that can invoke a tool in a session can `disable` escalation or `reset` it. This is intentional —
> the plugin does not implement its own permission layer. Operators who need to restrict who may
> toggle escalation **MUST** gate `model_escalator_control` through OpenCode's external tool-permission
> controls (e.g. the `permission` configuration in `opencode.json`). Because the tool is
> session-scoped and cannot alter another session's state, the blast radius of an unauthorized call
> is confined to the current session.

---

## 6. Validation rules  *(CFG-2)*

At load the plugin **MUST** reject and clearly report:

- an empty or missing `models` array;
- a `ModelStage` missing `model`, or a `model` string that does not parse as `provider/...`;
- a `same_failure_threshold < 1`;
- a non-array or empty `test_commands` when supplied;
- a non-array or empty `mutating_tools` when supplied, or a non-string element;
- an empty `fingerprint.failure_markers` when supplied;
- a negative `max_infra_retries` or `infra_retry_cooldown_ms`;
- a non-array `retry_on_errors`/`retry_on_patterns`, a non-HTTP `retry_on_errors` entry (not an integer in 100–599), an invalid/empty/match-all/nested-quantifier regex source, or `retry_on_patterns` exceeding the ReDoS bounds (64 × 1000 chars);
- a whitespace-only string in `test_commands`, `mutating_tools`, or `fingerprint.failure_markers`;
- a non-boolean value for any documented boolean key.

It **MUST NOT** silently disable escalation on invalid config.

---

## 7. Notes on the model chain

- There is **no shipped default chain** (C-4 / OQ1). The operator supplies `models[]`.
- Examples in this document use the live-verified OpenCode 1.18.21 OpenRouter ids; they are
  examples, not defaults. Swap any entry to match your provider/catalog.
- Do not list unverified ids (including any "Kimi K3 Max" variant) as a default.
