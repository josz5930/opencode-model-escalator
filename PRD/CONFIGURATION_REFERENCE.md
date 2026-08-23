# Configuration Reference — `opencode-model-escalator`

**Version:** 1.0 · **Date:** 2026-08-22 · **Status:** Draft for review

This is the authoritative list of every configuration key, its type, default, and meaning.
Behavior is specified in [TECHNICAL_SPECIFICATION.md](./TECHNICAL_SPECIFICATION.md); requirements
in [REQUIREMENTS.md](./REQUIREMENTS.md). Defaults here are the single source of truth for NFR-5
(zero-config viability).

---

## 1. Where configuration lives

The plugin reads its options from the `plugin` array in the project's `opencode.json`. Placement
of the plugin file (v0, no npm publish):

```text
your-project/
├── opencode.json
└── .opencode/
    └── plugins/
        └── model-escalator.ts        # or reference a published package
```

## 2. Minimal (zero-config) example

Only a model chain is required; everything else defaults.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/deepseek/deepseek-v4-flash-0731",
  "plugin": [
    ["opencode-model-escalator", {
      "models": [
        { "model": "openrouter/deepseek/deepseek-v4-flash-0731" },
        { "model": "openrouter/deepseek/deepseek-v4-pro-0813" },
        { "model": "openrouter/moonshotai/kimi-k3" }
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
    ["opencode-model-escalator", {
      "enabled": true,

      "models": [
        { "model": "openrouter/deepseek/deepseek-v4-flash-0731", "same_failure_threshold": 2 },
        { "model": "openrouter/deepseek/deepseek-v4-pro-0813",   "same_failure_threshold": 2 },
        { "model": "openrouter/moonshotai/kimi-k3",              "same_failure_threshold": 2 }
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
| `stop_at_max_model` | boolean | `true` | FR-8 | If true, reaching the top stage's threshold aborts + notifies and stops (hard-recommended). If false, the top model simply keeps trying — **discouraged** (runaway risk). |
| `notify_on_escalation` | boolean | `true` | FR-12 | Toast on each escalation and on terminal stop. |

### 4.4 Category A (infrastructure) handling

| Key | Type | Default | Requirement | Description |
|-----|------|---------|-------------|-------------|
| `retry_on_errors` | number[] | `[429, 500, 502, 503, 504]` | FR-9 | HTTP status codes treated as infrastructure failures (never capability). |
| `retry_on_patterns` | string[] | `[]` | FR-9 | Extra case-insensitive regex sources matched against error text (in addition to built-in phrases: "rate limit", "quota exceeded", "service unavailable", etc.). |
| `provider_failover` | boolean | `true` | FR-9 | Prefer letting the provider (e.g. OpenRouter) do upstream endpoint failover for Category A before the plugin retries the same model. |

### 4.5 Fingerprint tuning  *(NFR-2, Risk R6/R7)*

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `fingerprint.normalize_durations` | boolean | `true` | Replace `2.13s`, `1m4s` → `<duration>`. |
| `fingerprint.normalize_line_numbers` | boolean | `true` | Replace `foo.py:183` → `foo.py:<line>`. |
| `fingerprint.normalize_temp_paths` | boolean | `true` | Replace `/tmp/...` → `<tmp>`. |
| `fingerprint.normalize_addresses` | boolean | `true` | Replace `0x71abc2` → `<addr>` (and hex/uuid/timestamps). |
| `fingerprint.strip_ansi` | boolean | `true` | Remove ANSI escape codes before hashing. |
| `fingerprint.failure_markers` | string[] | see §3 | Lines retained as the semantic failure content. |

### 4.6 Operational

| Key | Type | Default | Requirement | Description |
|-----|------|---------|-------------|-------------|
| `shell_tool_name` | string | `"bash"` | FR-2 | Name of the tool whose commands are inspected for test runs. |
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
| `status` | Report current stage, active model, `repeats`, truncated `previousFailure`, `escalationInFlight`, and effective config. |
| `reset` | Clear session overrides and failure state; return to `models[0]` and config defaults. |

---

## 6. Validation rules  *(CFG-2)*

At load the plugin **MUST** reject and clearly report:

- an empty or missing `models` array;
- a `ModelStage` missing `model`, or a `model` string that does not parse as `provider/...`;
- a `same_failure_threshold < 1`;
- a non-array `test_commands` when supplied.

It **MUST NOT** silently disable escalation on invalid config.

---

## 7. Notes on the default chain

- The default chain uses OpenRouter as the provider; each model id is `openrouter/<or-model-id>`.
- Swap any entry to match your provider/catalog. The plugin is provider-agnostic — only the ids
  change.
- **Kimi K3 "Max":** not assumed to exist (Open Question OQ1). If your `/models` catalog exposes a
  stronger `max` variant, append it as an additional `ModelStage` **after** `kimi-k3`. Do not add
  it speculatively.
