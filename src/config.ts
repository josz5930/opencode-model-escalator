/**
 * Config defaults, resolution, and load-time validation.
 *
 * Closes CFG-1 (honor documented defaults), CFG-2 / AC-14 (fail loudly on
 * invalid config), NFR-5 (zero-config: only `models` required).
 *
 * No runtime imports beyond the shared types — keeps the core pure.
 */

import type {
  EscalatorConfig,
  FingerprintConfig,
  ModelStage,
} from './types.js';

/**
 * The default failure markers retained as semantic failure content.
 * Verbatim from CONFIGURATION_REFERENCE.md §3.
 */
const DEFAULT_FAILURE_MARKERS: string[] = [
  'FAILED',
  'ERROR',
  'AssertionError',
  'Expected:',
  'Received:',
  'panic:',
  'Traceback',
  '--- FAIL:',
  'Tests failed',
  '✕',
  '✗',
];

/**
 * The default test-command substring matchers.
 * Verbatim from CONFIGURATION_REFERENCE.md §3 / TECHNICAL_SPECIFICATION.md §3.2.
 */
const DEFAULT_TEST_COMMANDS: string[] = [
  'pytest',
  'python -m pytest',
  'npm test',
  'npm run test',
  'pnpm test',
  'yarn test',
  'bun test',
  'vitest',
  'jest',
  'go test',
  'cargo test',
  'dotnet test',
  'mvn test',
  'gradle test',
];

/**
 * Every documented default (CONFIGURATION_REFERENCE.md §3) EXCEPT `models`,
 * which is required from the user (empty ⇒ load error, CFG-2). `models` is
 * deliberately absent so no model id — verified or otherwise — ships as a
 * default (OQ1 / C-4).
 */
export const DEFAULTS: Omit<EscalatorConfig, 'models'> = {
  enabled: true,
  test_commands: DEFAULT_TEST_COMMANDS,

  require_code_change_between_failures: true,
  reset_on_new_user_task: true,
  stop_at_max_model: true,
  notify_on_escalation: true,

  retry_on_errors: [429, 500, 502, 503, 504],
  retry_on_patterns: [],
  provider_failover: true,

  fingerprint: {
    normalize_durations: true,
    normalize_line_numbers: true,
    normalize_temp_paths: true,
    normalize_addresses: true,
    strip_ansi: true,
    failure_markers: DEFAULT_FAILURE_MARKERS,
  },

  shell_tool_name: 'bash',
  idle_cleanup_ms: 600000,
  notify: true,
  debug: false,

  same_failure_threshold: 2,
};

/** Shape of the user-supplied options (all fields optional except `models`). */
export type UserConfig = {
  models?: unknown;
} & Partial<Omit<EscalatorConfig, 'models' | 'fingerprint'>> & {
    fingerprint?: Partial<FingerprintConfig>;
  };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/**
 * Parse an OpenCode model id `provider/model` on the FIRST `/`.
 * OpenRouter ids carry a nested `/` inside the model portion, e.g.
 * `openrouter/deepseek/deepseek-v4-flash-0731` → provider `openrouter`,
 * model `deepseek/deepseek-v4-flash-0731`. See TECHNICAL_SPECIFICATION.md §5.1.
 *
 * @returns `{ providerID, modelID }`, or `null` if it does not parse into a
 *          non-empty provider AND a non-empty model.
 */
export function parseModelId(
  id: string,
): { providerID: string; modelID: string } | null {
  if (typeof id !== 'string') return null;
  const slash = id.indexOf('/');
  if (slash <= 0) return null; // no `/`, or leading `/` (empty provider)
  const providerID = id.slice(0, slash);
  const modelID = id.slice(slash + 1);
  if (providerID.length === 0 || modelID.length === 0) return null;
  return { providerID, modelID };
}

/**
 * Resolve user options over the documented defaults and validate per
 * CONFIGURATION_REFERENCE.md §6. Throws an `Error` with a specific message on
 * any invalid input — never silently disables escalation (CFG-2, AC-14).
 */
export function resolveConfig(user: UserConfig | undefined): EscalatorConfig {
  const u: UserConfig = user ?? {};

  // --- models: required, non-empty array of valid ModelStage ---
  if (!Array.isArray(u.models)) {
    throw new Error(
      'opencode-model-escalator: `models` is required and must be a non-empty array (CFG-2).',
    );
  }
  if (u.models.length === 0) {
    throw new Error(
      'opencode-model-escalator: `models` must contain at least one entry; got an empty array (CFG-2, AC-14).',
    );
  }

  // --- test_commands: must be a NON-EMPTY array when supplied (P4) ---
  // An empty list matches nothing, silently disabling all detection — reject it
  // rather than let escalation quietly no-op.
  if (u.test_commands !== undefined) {
    if (!Array.isArray(u.test_commands)) {
      throw new Error(
        'opencode-model-escalator: `test_commands` must be an array of strings when supplied (CFG-2).',
      );
    }
    if (u.test_commands.length === 0) {
      throw new Error(
        'opencode-model-escalator: `test_commands` must not be empty — an empty list disables all test detection (CFG-2).',
      );
    }
  }

  // --- retry_on_errors: array of integers when supplied (CFG-2, P1) ---
  // An out-of-shape value here would otherwise blow up inside classifyFailure's
  // Set spread / RegExp interpolation at runtime; fail loudly at resolve.
  if (u.retry_on_errors !== undefined) {
    if (!Array.isArray(u.retry_on_errors)) {
      throw new Error(
        'opencode-model-escalator: `retry_on_errors` must be an array of integer status codes when supplied (CFG-2).',
      );
    }
    for (const code of u.retry_on_errors) {
      if (typeof code !== 'number' || !Number.isInteger(code)) {
        throw new Error(
          `opencode-model-escalator: \`retry_on_errors\` entries must be integers; got ${String(
            code,
          )} (CFG-2).`,
        );
      }
    }
  }

  // --- retry_on_patterns: array of compilable regex source strings (CFG-2, P1) ---
  if (u.retry_on_patterns !== undefined) {
    if (!Array.isArray(u.retry_on_patterns)) {
      throw new Error(
        'opencode-model-escalator: `retry_on_patterns` must be an array of regex source strings when supplied (CFG-2).',
      );
    }
    for (const source of u.retry_on_patterns) {
      if (typeof source !== 'string') {
        throw new Error(
          `opencode-model-escalator: \`retry_on_patterns\` entries must be strings; got ${String(
            source,
          )} (CFG-2).`,
        );
      }
      try {
        // eslint-disable-next-line no-new
        new RegExp(source);
      } catch (err) {
        throw new Error(
          `opencode-model-escalator: \`retry_on_patterns\` contains an invalid regular expression "${source}": ${
            (err as Error).message
          } (CFG-2).`,
        );
      }
    }
  }

  // --- top-level same_failure_threshold (if supplied) must be >= 1 ---
  const topThreshold =
    u.same_failure_threshold ?? DEFAULTS.same_failure_threshold;
  if (!Number.isInteger(topThreshold) || topThreshold < 1) {
    throw new Error(
      `opencode-model-escalator: \`same_failure_threshold\` must be an integer >= 1; got ${String(
        u.same_failure_threshold,
      )} (CFG-2).`,
    );
  }

  // --- validate + normalize each ModelStage ---
  const models: ModelStage[] = u.models.map((raw, i) => {
    if (!isPlainObject(raw)) {
      throw new Error(
        `opencode-model-escalator: models[${i}] must be an object with a \`model\` string (CFG-2, AC-14).`,
      );
    }
    const model = raw.model;
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error(
        `opencode-model-escalator: models[${i}] is missing a non-empty \`model\` id (CFG-2, AC-14).`,
      );
    }
    if (parseModelId(model) === null) {
      throw new Error(
        `opencode-model-escalator: models[${i}] has an unparseable model id "${model}" — expected \`provider/model\` (CFG-2, AC-14).`,
      );
    }
    const stage: ModelStage = { model };
    if (raw.same_failure_threshold !== undefined) {
      const t = raw.same_failure_threshold;
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 1) {
        throw new Error(
          `opencode-model-escalator: models[${i}].same_failure_threshold must be an integer >= 1; got ${String(
            t,
          )} (CFG-2).`,
        );
      }
      stage.same_failure_threshold = t;
    }
    return stage;
  });

  // --- fingerprint.failure_markers: NON-EMPTY array when supplied (P4) ---
  // No markers ⇒ nothing is ever retained ⇒ every failure collapses to the
  // command alone; reject rather than silently disable Category-B detection.
  if (u.fingerprint?.failure_markers !== undefined) {
    const markers = u.fingerprint.failure_markers;
    if (!Array.isArray(markers)) {
      throw new Error(
        'opencode-model-escalator: `fingerprint.failure_markers` must be an array of strings when supplied (CFG-2).',
      );
    }
    if (markers.length === 0) {
      throw new Error(
        'opencode-model-escalator: `fingerprint.failure_markers` must not be empty — no markers disables failure detection (CFG-2).',
      );
    }
  }

  // --- deep-merge the fingerprint block (nested object) ---
  const fingerprint: FingerprintConfig = {
    ...DEFAULTS.fingerprint,
    ...(u.fingerprint ?? {}),
  };

  const resolved: EscalatorConfig = {
    ...DEFAULTS,
    ...stripUndefined(u),
    // arrays/objects that need explicit handling override the spread above:
    models,
    test_commands: u.test_commands ?? DEFAULTS.test_commands,
    retry_on_errors: u.retry_on_errors ?? DEFAULTS.retry_on_errors,
    retry_on_patterns: u.retry_on_patterns ?? DEFAULTS.retry_on_patterns,
    fingerprint,
    same_failure_threshold: topThreshold,
  };

  return resolved;
}

/**
 * Return the per-stage threshold for `stage`, falling back to the top-level
 * default. See TECHNICAL_SPECIFICATION.md §2, §5.
 */
export function thresholdForStage(
  cfg: EscalatorConfig,
  stage: number,
): number {
  const entry = cfg.models[stage];
  return entry?.same_failure_threshold ?? cfg.same_failure_threshold;
}

/** Drop keys whose value is `undefined` so they don't clobber defaults. */
function stripUndefined<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
