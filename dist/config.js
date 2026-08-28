/**
 * Config defaults, resolution, and load-time validation.
 *
 * Closes CFG-1 (honor documented defaults), CFG-2 / AC-14 (fail loudly on
 * invalid config), NFR-5 (zero-config: only `models` required).
 *
 * No runtime imports beyond the shared types — keeps the core pure.
 */
/**
 * The default failure markers retained as semantic failure content.
 * Verbatim from CONFIGURATION_REFERENCE.md §3.
 */
const DEFAULT_FAILURE_MARKERS = [
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
const DEFAULT_TEST_COMMANDS = [
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
export const DEFAULTS = {
    enabled: true,
    test_commands: DEFAULT_TEST_COMMANDS,
    require_code_change_between_failures: true,
    reset_on_new_user_task: true,
    stop_at_max_model: true,
    notify_on_escalation: true,
    retry_on_errors: [429, 500, 502, 503, 504],
    retry_on_patterns: [],
    provider_failover: true,
    max_infra_retries: 2,
    infra_retry_cooldown_ms: 1000,
    fingerprint: {
        normalize_durations: true,
        normalize_line_numbers: true,
        normalize_temp_paths: true,
        normalize_addresses: true,
        strip_ansi: true,
        failure_markers: DEFAULT_FAILURE_MARKERS,
    },
    shell_tool_name: 'bash',
    mutating_tools: ['edit', 'write', 'patch', 'multiedit', 'apply_patch'],
    idle_cleanup_ms: 600000,
    notify: true,
    debug: false,
    same_failure_threshold: 2,
};
function isPlainObject(value) {
    return (typeof value === 'object' && value !== null && !Array.isArray(value));
}
/** ReDoS bounds for user-supplied `retry_on_patterns` (finding 19). */
const MAX_RETRY_PATTERNS = 64;
const MAX_RETRY_PATTERN_LEN = 1000;
/**
 * Largest delay Node's timers represent without overflow/immediate-fire
 * (2^31 - 1 ms ≈ 24.8 days). Cooldowns and cleanup intervals are bounded to
 * this so a huge configured value can neither overflow a `setTimeout` nor,
 * after exponential backoff, wrap to a negative/zero delay (2026-08-25 finding
 * 13). The orchestrator additionally clamps the backed-off delay to this bound.
 */
export const MAX_TIMER_MS = 2_147_483_647;
/**
 * Upper bound on `max_infra_retries` (2026-08-25 finding 13). Beyond this the
 * exponential backoff `cooldown * 2^(n-1)` is meaningless (every delay is
 * clamped to {@link MAX_TIMER_MS}) and the retry budget stops being a bound.
 */
const MAX_INFRA_RETRIES = 1000;
/**
 * Upper bound on any escalation `same_failure_threshold` (top-level or per-stage)
 * (P8). Below `1` escalation is meaningless; above this a threshold is so large
 * escalation becomes effectively unreachable, silently disabling the feature —
 * bound it like the timer integers rather than accepting an unusable value.
 */
const MAX_SAME_FAILURE_THRESHOLD = 1000;
/**
 * Reject a configured regex source that is empty or carries a nested-quantifier
 * construct prone to catastrophic backtracking (2026-08-25 finding 12). Count,
 * length, and input bounds do not make JS regex evaluation safe; a short
 * `(a+)+$` still backtracks exponentially over bounded input. This is a
 * conservative heuristic: it rejects a quantified group whose body itself
 * contains a quantifier (the classic ReDoS shape). It errs toward rejection —
 * an operator can always express the same intent literally.
 */
const RE_QUANTIFIER = '(?:[+*]|\\{(?:\\d+)?,(?:\\d+)?\\})';
const RE_NESTED_QUANTIFIER = new RegExp(`\\((?:[^()\\\\]|\\\\.)*${RE_QUANTIFIER}[^()]*\\)\\s*${RE_QUANTIFIER}`);
function assertSafeRegexSource(source) {
    if (source.length === 0) {
        throw new Error('opencode-model-escalator: a `retry_on_patterns` entry is an empty string — an empty regex matches everything and would classify every failure as Category A (CFG-2).');
    }
    if (RE_NESTED_QUANTIFIER.test(source)) {
        throw new Error(`opencode-model-escalator: \`retry_on_patterns\` entry "${source}" contains a nested-quantifier construct prone to catastrophic backtracking (ReDoS); rewrite it without a quantifier inside a quantified group, or match literally (CFG-2).`);
    }
}
/**
 * Ordinary, infrastructure-free text a Category-B failure might contain (P4).
 * Holds only letters, a space, and benign punctuation and NO infrastructure
 * vocabulary, so a targeted infra pattern (`rate limit`, `overloaded`,
 * `HTTP \d{3}`) never matches it — but the match-any-character shapes that the
 * empty-string probe misses (`.`, `.+`, `\w`, `\S`, `[\s\S]`, `[^]`, …) do.
 */
const MATCH_ALL_PROBE = 'abc xyz .,:;';
/**
 * A pattern that matches the empty string OR arbitrary ordinary text classifies
 * (almost) every failure as Category A — silently disabling capability
 * escalation, the exact failure §6 forbids.
 */
function assertNotMatchAll(source) {
    try {
        const re = new RegExp(source, 'i');
        if (re.test('')) {
            throw new Error(`opencode-model-escalator: \`retry_on_patterns\` entry "${source}" matches the empty string and would classify every failure as Category A (CFG-2).`);
        }
        if (re.test(MATCH_ALL_PROBE)) {
            throw new Error(`opencode-model-escalator: \`retry_on_patterns\` entry "${source}" is over-broad — it matches ordinary non-infrastructure text and would classify nearly every failure as Category A, disabling capability escalation; write a more specific pattern (CFG-2).`);
        }
    }
    catch (err) {
        if (err instanceof Error && err.message.startsWith('opencode-model-escalator:')) {
            throw err;
        }
        // Compile failures are reported by the caller.
    }
}
/** Assert a supplied value is a boolean, or throw a clear load error (CFG-2). */
function assertBoolean(value, key) {
    if (value !== undefined && typeof value !== 'boolean') {
        throw new Error(`opencode-model-escalator: \`${key}\` must be a boolean when supplied; got ${String(value)} (CFG-2).`);
    }
}
/** Assert a supplied value is an integer in `[min, max]`, or throw (CFG-2). */
function assertIntInRange(value, key, min, max) {
    if (value !== undefined &&
        (typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < min ||
            value > max)) {
        throw new Error(`opencode-model-escalator: \`${key}\` must be an integer in [${min}, ${max}] when supplied; got ${String(value)} (CFG-2).`);
    }
}
/** Assert a supplied value is an array whose every element is a non-empty string. */
function assertStringArray(value, key) {
    if (value === undefined)
        return;
    if (!Array.isArray(value)) {
        throw new Error(`opencode-model-escalator: \`${key}\` must be an array of strings when supplied (CFG-2).`);
    }
    for (const el of value) {
        if (typeof el !== 'string' || el.trim().length === 0) {
            throw new Error(`opencode-model-escalator: \`${key}\` entries must be non-empty strings; got ${String(el)} (CFG-2).`);
        }
    }
}
/** Trim every string in a validated string array. */
function trimmedStringArray(value) {
    return value.map((el) => el.trim());
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
export function parseModelId(id) {
    if (typeof id !== 'string')
        return null;
    const slash = id.indexOf('/');
    if (slash <= 0)
        return null; // no `/`, or leading `/` (empty provider)
    const providerID = id.slice(0, slash);
    const modelID = id.slice(slash + 1);
    if (providerID.length === 0 || modelID.length === 0)
        return null;
    return { providerID, modelID };
}
/**
 * Resolve user options over the documented defaults and validate per
 * CONFIGURATION_REFERENCE.md §6. Throws an `Error` with a specific message on
 * any invalid input — never silently disables escalation (CFG-2, AC-14).
 */
export function resolveConfig(user) {
    const u = user ?? {};
    // --- models: required, non-empty array of valid ModelStage ---
    if (!Array.isArray(u.models)) {
        throw new Error('opencode-model-escalator: `models` is required and must be a non-empty array (CFG-2).');
    }
    if (u.models.length === 0) {
        throw new Error('opencode-model-escalator: `models` must contain at least one entry; got an empty array (CFG-2, AC-14).');
    }
    // --- test_commands: must be a NON-EMPTY array when supplied (P4) ---
    // An empty list matches nothing, silently disabling all detection — reject it
    // rather than let escalation quietly no-op.
    if (u.test_commands !== undefined) {
        if (!Array.isArray(u.test_commands)) {
            throw new Error('opencode-model-escalator: `test_commands` must be an array of strings when supplied (CFG-2).');
        }
        if (u.test_commands.length === 0) {
            throw new Error('opencode-model-escalator: `test_commands` must not be empty — an empty list disables all test detection (CFG-2).');
        }
        // Every element must be a non-empty string; `[null]` etc. would otherwise
        // slip through and later throw inside matching (finding 12).
        assertStringArray(u.test_commands, 'test_commands');
    }
    // --- mutating_tools: non-empty array of non-empty strings when supplied ---
    if (u.mutating_tools !== undefined) {
        if (!Array.isArray(u.mutating_tools) || u.mutating_tools.length === 0) {
            throw new Error('opencode-model-escalator: `mutating_tools` must be a non-empty array of tool names when supplied (CFG-2).');
        }
        assertStringArray(u.mutating_tools, 'mutating_tools');
    }
    // --- documented booleans, numbers, and strings (finding 12) ---
    assertBoolean(u.enabled, 'enabled');
    assertBoolean(u.require_code_change_between_failures, 'require_code_change_between_failures');
    assertBoolean(u.reset_on_new_user_task, 'reset_on_new_user_task');
    assertBoolean(u.stop_at_max_model, 'stop_at_max_model');
    assertBoolean(u.notify_on_escalation, 'notify_on_escalation');
    assertBoolean(u.provider_failover, 'provider_failover');
    assertBoolean(u.notify, 'notify');
    assertBoolean(u.debug, 'debug');
    // Bound timer-valued integers to Node's safe timer range so a huge value can
    // neither overflow setTimeout nor, after exponential backoff, wrap negative
    // (2026-08-25 finding 13).
    assertIntInRange(u.idle_cleanup_ms, 'idle_cleanup_ms', 1, MAX_TIMER_MS);
    assertIntInRange(u.max_infra_retries, 'max_infra_retries', 0, MAX_INFRA_RETRIES);
    assertIntInRange(u.infra_retry_cooldown_ms, 'infra_retry_cooldown_ms', 0, MAX_TIMER_MS);
    if (u.shell_tool_name !== undefined &&
        (typeof u.shell_tool_name !== 'string' || u.shell_tool_name.trim().length === 0)) {
        throw new Error('opencode-model-escalator: `shell_tool_name` must be a non-empty string when supplied (CFG-2).');
    }
    const shellName = typeof u.shell_tool_name === 'string'
        ? u.shell_tool_name.trim()
        : DEFAULTS.shell_tool_name;
    const mutatingTools = trimmedStringArray((u.mutating_tools ?? DEFAULTS.mutating_tools));
    // Reject shell/mutating-tool overlap explicitly (2026-08-25 finding 11): the
    // adapter's shell branch returns before mutation handling, so a shell tool
    // listed in `mutating_tools` would silently never arm a repair cycle. Fail
    // loudly rather than accept an unusable, misleading combination.
    {
        if (mutatingTools.includes(shellName)) {
            throw new Error(`opencode-model-escalator: \`shell_tool_name\` ("${shellName}") must not also appear in \`mutating_tools\` — the shell tool is the test-runner channel and cannot double as a mutation signal (CFG-2).`);
        }
    }
    // --- fingerprint block: booleans + non-empty string markers (finding 12) ---
    if (u.fingerprint !== undefined) {
        if (!isPlainObject(u.fingerprint)) {
            throw new Error('opencode-model-escalator: `fingerprint` must be an object when supplied (CFG-2).');
        }
        const fpKeys = [
            'normalize_durations',
            'normalize_line_numbers',
            'normalize_temp_paths',
            'normalize_addresses',
            'strip_ansi',
        ];
        for (const k of fpKeys) {
            assertBoolean(u.fingerprint[k], `fingerprint.${k}`);
        }
        if (u.fingerprint.project_root !== undefined) {
            const pr = u.fingerprint.project_root;
            if (typeof pr !== 'string') {
                throw new Error('opencode-model-escalator: `fingerprint.project_root` must be a string when supplied (CFG-2).');
            }
            // An empty string means "unset" (the adapter fills in the live directory).
            // A non-empty value is scrubbed globally out of every fingerprint, so a
            // degenerate root like "/" or a relative fragment would collapse distinct
            // failures to one hash — require a real, absolute, non-bare path (P9).
            const trimmed = pr.trim();
            if (trimmed.length > 0) {
                const isAbsolute = trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed);
                const isBareRoot = /^[\\/]+$/.test(trimmed) || /^[A-Za-z]:[\\/]*$/.test(trimmed);
                if (!isAbsolute || isBareRoot || trimmed.length < 2) {
                    throw new Error(`opencode-model-escalator: \`fingerprint.project_root\` must be an absolute, non-degenerate path when supplied; got "${pr}" (a bare or relative root would scrub distinct failures into one fingerprint) (CFG-2).`);
                }
            }
        }
    }
    // --- retry_on_errors: array of integers when supplied (CFG-2, P1) ---
    // An out-of-shape value here would otherwise blow up inside classifyFailure's
    // Set spread / RegExp interpolation at runtime; fail loudly at resolve.
    if (u.retry_on_errors !== undefined) {
        if (!Array.isArray(u.retry_on_errors)) {
            throw new Error('opencode-model-escalator: `retry_on_errors` must be an array of integer status codes when supplied (CFG-2).');
        }
        for (const code of u.retry_on_errors) {
            if (typeof code !== 'number' ||
                !Number.isInteger(code) ||
                code < 100 ||
                code > 599) {
                throw new Error(`opencode-model-escalator: \`retry_on_errors\` entries must be HTTP status codes in [100, 599]; got ${String(code)} (CFG-2).`);
            }
        }
    }
    // --- retry_on_patterns: array of compilable regex source strings (CFG-2, P1) ---
    // Bounded in count and length to limit event-loop ReDoS exposure from
    // arbitrary configured regexes (finding 19); the scan input is also capped in
    // `classifyFailure`.
    if (u.retry_on_patterns !== undefined) {
        if (!Array.isArray(u.retry_on_patterns)) {
            throw new Error('opencode-model-escalator: `retry_on_patterns` must be an array of regex source strings when supplied (CFG-2).');
        }
        if (u.retry_on_patterns.length > MAX_RETRY_PATTERNS) {
            throw new Error(`opencode-model-escalator: \`retry_on_patterns\` may contain at most ${MAX_RETRY_PATTERNS} entries; got ${u.retry_on_patterns.length} (CFG-2, ReDoS bound).`);
        }
        for (const source of u.retry_on_patterns) {
            if (typeof source !== 'string') {
                throw new Error(`opencode-model-escalator: \`retry_on_patterns\` entries must be strings; got ${String(source)} (CFG-2).`);
            }
            if (source.length > MAX_RETRY_PATTERN_LEN) {
                throw new Error(`opencode-model-escalator: a \`retry_on_patterns\` entry exceeds ${MAX_RETRY_PATTERN_LEN} characters (CFG-2, ReDoS bound).`);
            }
            // Reject empty, nested-quantifier (ReDoS), and match-all sources before
            // compiling (2026-08-25 finding 12, P9).
            assertSafeRegexSource(source);
            assertNotMatchAll(source);
            try {
                // eslint-disable-next-line no-new
                new RegExp(source);
            }
            catch (err) {
                throw new Error(`opencode-model-escalator: \`retry_on_patterns\` contains an invalid regular expression "${source}": ${err.message} (CFG-2).`);
            }
        }
    }
    // --- top-level same_failure_threshold (if supplied): integer in [1, max] ---
    const topThreshold = u.same_failure_threshold ?? DEFAULTS.same_failure_threshold;
    if (!Number.isInteger(topThreshold) ||
        topThreshold < 1 ||
        topThreshold > MAX_SAME_FAILURE_THRESHOLD) {
        throw new Error(`opencode-model-escalator: \`same_failure_threshold\` must be an integer in [1, ${MAX_SAME_FAILURE_THRESHOLD}]; got ${String(u.same_failure_threshold)} (CFG-2).`);
    }
    // --- validate + normalize each ModelStage ---
    const models = u.models.map((raw, i) => {
        if (!isPlainObject(raw)) {
            throw new Error(`opencode-model-escalator: models[${i}] must be an object with a \`model\` string (CFG-2, AC-14).`);
        }
        const model = raw.model;
        if (typeof model !== 'string' || model.length === 0) {
            throw new Error(`opencode-model-escalator: models[${i}] is missing a non-empty \`model\` id (CFG-2, AC-14).`);
        }
        // Reject whitespace-padded ids (2026-08-25 finding 13): the components were
        // trim-checked but the ORIGINAL string is stored and later handed to the
        // SDK verbatim, so `" provider / model "` would dispatch a bad id. Require a
        // clean, whitespace-free id rather than silently normalizing it.
        if (/\s/.test(model)) {
            throw new Error(`opencode-model-escalator: models[${i}] model id "${model}" contains whitespace — supply a clean \`provider/model\` id with no surrounding or interior spaces (CFG-2, AC-14).`);
        }
        const parsed = parseModelId(model);
        if (parsed === null ||
            parsed.providerID.length === 0 ||
            parsed.modelID.length === 0) {
            throw new Error(`opencode-model-escalator: models[${i}] has an unparseable model id "${model}" — expected non-empty \`provider/model\` (CFG-2, AC-14).`);
        }
        const stage = { model };
        if (raw.same_failure_threshold !== undefined) {
            const t = raw.same_failure_threshold;
            if (typeof t !== 'number' ||
                !Number.isInteger(t) ||
                t < 1 ||
                t > MAX_SAME_FAILURE_THRESHOLD) {
                throw new Error(`opencode-model-escalator: models[${i}].same_failure_threshold must be an integer in [1, ${MAX_SAME_FAILURE_THRESHOLD}]; got ${String(t)} (CFG-2).`);
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
            throw new Error('opencode-model-escalator: `fingerprint.failure_markers` must be an array of strings when supplied (CFG-2).');
        }
        if (markers.length === 0) {
            throw new Error('opencode-model-escalator: `fingerprint.failure_markers` must not be empty — no markers disables failure detection (CFG-2).');
        }
        assertStringArray(markers, 'fingerprint.failure_markers');
    }
    // --- deep-merge the fingerprint block (nested object) ---
    // stripUndefined so `strip_ansi: undefined` cannot clobber the default (P9).
    const fingerprint = {
        ...DEFAULTS.fingerprint,
        ...stripUndefined((u.fingerprint ?? {})),
    };
    if (u.fingerprint?.failure_markers !== undefined) {
        fingerprint.failure_markers = trimmedStringArray(u.fingerprint.failure_markers);
    }
    const resolved = {
        ...DEFAULTS,
        ...stripUndefined(u),
        // arrays/objects that need explicit handling override the spread above:
        models,
        test_commands: u.test_commands !== undefined
            ? trimmedStringArray(u.test_commands)
            : DEFAULTS.test_commands,
        mutating_tools: mutatingTools,
        shell_tool_name: shellName,
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
export function thresholdForStage(cfg, stage) {
    const entry = cfg.models[stage];
    return entry?.same_failure_threshold ?? cfg.same_failure_threshold;
}
/** Drop keys whose value is `undefined` so they don't clobber defaults. */
function stripUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
//# sourceMappingURL=config.js.map