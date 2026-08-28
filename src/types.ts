/**
 * Shared vocabulary for the deterministic detection core.
 *
 * This module has NO runtime imports (in particular, nothing from
 * `@opencode-ai/plugin`) so the core stays unit-testable in isolation.
 */

/**
 * One entry in the escalation chain. See CONFIGURATION_REFERENCE.md §4.2.
 */
export type ModelStage = {
  /**
   * OpenCode model id, `provider/model`. OpenRouter ids add a nested `/`,
   * e.g. `openrouter/deepseek/deepseek-v4-flash-0731`. Parsed on the FIRST `/`.
   */
  model: string;
  /**
   * Consecutive identical failing repair cycles at this stage before
   * escalating. Per-stage override of the top-level default. Integer >= 1.
   */
  same_failure_threshold?: number;
};

/**
 * Fingerprint normalization toggles + failure markers.
 * See CONFIGURATION_REFERENCE.md §4.5 and TECHNICAL_SPECIFICATION.md §3.3.
 */
export type FingerprintConfig = {
  normalize_durations: boolean;
  normalize_line_numbers: boolean;
  normalize_temp_paths: boolean;
  normalize_addresses: boolean;
  strip_ansi: boolean;
  /** Lines retained as the semantic failure content before hashing. */
  failure_markers: string[];
  /**
   * Absolute project root, normalized to `<root>` before hashing so that a
   * checkout path never perturbs a fingerprint (AC-9). Optional; the adapter
   * supplies the live OpenCode working directory. Empty ⇒ no root scrub.
   */
  project_root?: string;
};

/**
 * The fully-resolved config shape (user options deep-merged over DEFAULTS).
 * Every field is present and valid after `resolveConfig`.
 * See CONFIGURATION_REFERENCE.md §3/§4.
 */
export type EscalatorConfig = {
  enabled: boolean;
  models: ModelStage[];
  test_commands: string[];

  require_code_change_between_failures: boolean;
  reset_on_new_user_task: boolean;
  stop_at_max_model: boolean;
  notify_on_escalation: boolean;

  retry_on_errors: number[];
  retry_on_patterns: string[];
  provider_failover: boolean;
  /**
   * Bounded same-model retries for a Category-A (infrastructure) failure before
   * giving up and notifying. `0` disables automatic infra retry. See
   * CONFIGURATION_REFERENCE.md §4.4 and FR-9.
   */
  max_infra_retries: number;
  /**
   * Base cooldown (ms) between Category-A retries. The Nth retry waits
   * `infra_retry_cooldown_ms * 2^(N-1)` (exponential backoff). Applied by the
   * adapter's `retry` effect, not the deterministic decision path (NFR-1).
   */
  infra_retry_cooldown_ms: number;

  fingerprint: FingerprintConfig;

  shell_tool_name: string;
  /**
   * Tool names whose SUCCESSFUL completion counts as a code change for the
   * repair-cycle counter (FR-3). Configurable so mutations via non-default tools
   * (formatters, generators, custom edit tools) can be recognized (finding 4).
   */
  mutating_tools: string[];
  idle_cleanup_ms: number;
  notify: boolean;
  debug: boolean;

  /** Top-level default threshold applied when a stage omits its own. */
  same_failure_threshold: number;
};

/**
 * Failure category. `"A"` = infrastructure (never escalates capability);
 * `"B"` = capability (the only thing that drives escalation).
 * See TECHNICAL_SPECIFICATION.md §3/§4.
 */
export type FailureCategory = 'A' | 'B';

/**
 * Per-session detection state (the subset the pure core reads/writes).
 * See TECHNICAL_SPECIFICATION.md §2.3. The integration spec owns the mutable
 * `Map<sessionID, StuckState>` and any additional runtime-only fields
 * (escalationInFlight, pendingModel, currentTaskId).
 */
export type StuckState = {
  /** Index into `models[]`; 0 = cheapest. */
  stage: number;
  /** Last failure fingerprint (Category B). */
  previousFailure?: string;
  /** Consecutive identical repair-cycle failures at this stage. */
  repeats: number;
  /** A `file.edited` fired since the last counted failure. */
  codeChangedSinceFailure: boolean;
};
