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

  fingerprint: FingerprintConfig;

  shell_tool_name: string;
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
