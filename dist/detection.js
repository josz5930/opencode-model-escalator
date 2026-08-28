/**
 * The deterministic, LLM-free detection core.
 *
 * Closes FR-2 (Category B detection), FR-9 (Category A separation, text path),
 * FR-11 (configurable matchers), NFR-1 (determinism: no wall-clock, random, or
 * network), NFR-2 (fingerprint robustness).
 *
 * The only import is Node's `crypto` (SHA-256) — no `@opencode-ai/plugin`, so
 * the core stays unit-testable in isolation.
 */
import { createHash } from 'node:crypto';
// --- resource bounds (finding 18/19): cap the work any single output can cause
// in the awaited host hook, so oversized/adversarial output degrades safely
// instead of exhausting CPU/memory. All deterministic (NFR-1). ---
/** Max characters of any single output/text analyzed before it is truncated. */
const MAX_ANALYSIS_CHARS = 256 * 1024;
/** Max characters retained from any single line (long minified/base64 lines). */
const MAX_LINE_CHARS = 4096;
/** Max failure/detail lines retained for the fingerprint error block. */
const MAX_RETAINED_LINES = 500;
/**
 * Marker inserted between the retained head and tail of an over-sized output
 * (finding 7). Test runners emit their decisive failure summary at the END, so
 * a head-only clamp would silently drop the very line that distinguishes two
 * failures. A head+tail window keeps both extremities under a fixed bound.
 */
const TRUNCATION_MARKER = '\n…<output-truncated>…\n';
/**
 * Bound `text` to a fixed size before any scanning (finding 7/18/19). Under the
 * bound the text is returned verbatim; over the bound a deterministic head+tail
 * window is returned so decisive tail failure evidence survives while CPU/memory
 * stay bounded. Callers that must NOT act on a truncated output should first
 * consult {@link isOversizedOutput} and degrade (never fabricate — P2).
 */
function clampAnalysis(text) {
    if (text.length <= MAX_ANALYSIS_CHARS)
        return text;
    const budget = MAX_ANALYSIS_CHARS - TRUNCATION_MARKER.length;
    const head = Math.ceil(budget / 2);
    const tail = budget - head;
    return text.slice(0, head) + TRUNCATION_MARKER + text.slice(text.length - tail);
}
/**
 * Did `text` exceed the analysis bound (finding 7)? An over-sized output cannot
 * be fingerprinted without risking a false-equal hash (two outputs sharing a
 * prefix but differing in the excised middle would collide and manufacture a
 * false repeat). The orchestrator uses this to DEGRADE — skip counting the
 * failure — rather than count a fingerprint it cannot trust (NFR-2, AC-10, P2).
 */
export function isOversizedOutput(text) {
    return typeof text === 'string' && text.length > MAX_ANALYSIS_CHARS;
}
/** Escape a literal string for safe insertion into a `RegExp` source. */
function escapeRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Does `cmd` look like a test run? Substring, case-sensitive match against
 * `cfg.test_commands` (TECHNICAL_SPECIFICATION.md §3.2, FR-11). The caller MUST
 * NOT fingerprint or count a command for which this returns `false` (FR-15).
 */
export function looksLikeTestCommand(cmd, cfg) {
    if (typeof cmd !== 'string' || cmd.length === 0)
        return false;
    for (const token of cfg.test_commands) {
        if (token.length > 0 && cmd.includes(token))
            return true;
    }
    return false;
}
// --- normalization regexes (module-level: compiled once, deterministic) ---
// ANSI escape / control sequences.
const RE_ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// 0x-prefixed memory addresses.
const RE_ADDR = /\b0x[0-9a-fA-F]+\b/g;
// UUIDs (8-4-4-4-12 hex).
const RE_UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// ISO-8601-ish timestamps, e.g. 2026-08-22T13:45:07.123Z or 2026-08-22 13:45:07.
const RE_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
// Long bare hex runs (>= 8 hex digits) — content hashes, ids, etc.
const RE_HEX = /\b[0-9a-fA-F]{8,}\b/g;
// Unix/pytest temp paths: /tmp/... up to whitespace or a `::` test-id sep.
const RE_TMP = /(?:\/tmp|\/var\/folders|\/private\/var\/folders)\/[^\s:]*/g;
// Windows temp paths: any `X:\...\Temp\...` run (AppData\Local\Temp, Windows\Temp).
const RE_TMP_WIN = /[A-Za-z]:\\(?:[^\s\\]+\\)*Temp\\[^\s]*/gi;
// Durations: number+unit, possibly compound (1m4s, 2.13s, 123ms, 1h2m3s).
const RE_DURATION = /\b\d+(?:\.\d+)?\s*(?:ms|h|m|s)(?:\s*\d+(?:\.\d+)?\s*(?:ms|h|m|s))*\b/g;
// Line numbers after a file extension: foo.py:183 or foo.py:183:5 → foo.py:<line>.
const RE_LINE = /(\.[A-Za-z0-9_]+):\d+(?::\d+)?/g;
// Python-traceback line refs: `line 183` → `line <line>` (File "foo.py", line 183).
const RE_LINE_WORD = /\bline \d+/g;
/**
 * Scrub volatile tokens from `text` per the TECHNICAL_SPECIFICATION.md §3.3
 * scrub table. Each rule is gated by its `fingerprint.*` toggle so the rules
 * are tunable without code changes (NFR-2). Deterministic: same input ⇒ same
 * output.
 */
export function normalizeOutput(text, fp) {
    if (typeof text !== 'string')
        return '';
    let out = clampAnalysis(text);
    // ANSI first, so markers underneath become detectable.
    if (fp.strip_ansi)
        out = out.replace(RE_ANSI, '');
    // Project root before other path rules so a checkout path never leaks into
    // the fingerprint (finding 16). Escaped literal replace — no user-driven regex.
    if (typeof fp.project_root === 'string' && fp.project_root.length > 0) {
        out = out.replace(new RegExp(escapeRegExp(fp.project_root), 'g'), '<root>');
    }
    if (fp.normalize_addresses) {
        out = out
            .replace(RE_UUID, '<uuid>')
            .replace(RE_TS, '<ts>')
            .replace(RE_ADDR, '<addr>')
            .replace(RE_HEX, '<hex>');
    }
    // Temp paths before durations/line-numbers so path contents don't get
    // partially rewritten first. Both Unix and Windows temp roots (finding 16).
    if (fp.normalize_temp_paths) {
        out = out.replace(RE_TMP, '<tmp>').replace(RE_TMP_WIN, '<tmp>');
    }
    if (fp.normalize_durations)
        out = out.replace(RE_DURATION, '<duration>');
    if (fp.normalize_line_numbers) {
        out = out
            .replace(RE_LINE, '$1:<line>')
            .replace(RE_LINE_WORD, 'line <line>');
    }
    // Normalize line endings (CRLF and lone CR) and trailing whitespace so
    // line-ending noise never perturbs the hash.
    out = out.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
    return out;
}
// Assertion/error detail lines that carry NO configured marker but distinguish
// two otherwise-identical failures — e.g. pytest's `E   assert 1 == 2`. Without
// these, when a marker line (`FAILED …`) is shared, differing assertion values
// collapse to one fingerprint (finding 10). Bounded, literal patterns only.
const RE_PYTEST_DETAIL = /^E\b/; // pytest failure-detail prefix ("E   assert …")
const RE_ASSERT_WORD = /\bassert\b/i;
// Typed error/exception/panic detail lines that carry no configured marker but
// still distinguish two otherwise-identical failures across common runner
// formats — e.g. `ValueError: one` vs `ValueError: two`, Rust `thread '…'
// panicked at …`, Go/JS `panic:`/`Uncaught` lines (2026-08-25 finding 6). The
// input is already normalized, so retaining these ADDS only already-scrubbed
// distinguishing content: noise-only differences still collapse (AC-9) while
// genuinely different errors stay distinct (AC-10, NFR-2). Bounded, literal.
const RE_ERROR_DETAIL = /\b[A-Z][A-Za-z0-9_]*(?:Error|Exception|Warning|Failure|Fault)\b|\b(?:panicked|Uncaught|Unhandled|Caused by|Reason)\b/;
/**
 * Retain the semantic failure content: lines carrying a known failure marker,
 * PLUS bounded assertion/error-detail lines so differing assertions on a shared
 * marker line stay distinct (finding 10). See TECHNICAL_SPECIFICATION.md §3.3
 * step 2. Input should already be normalized. Bounded to `MAX_RETAINED_LINES`
 * and `MAX_LINE_CHARS` so oversized output can't blow up the hash step
 * (finding 18).
 */
function retainFailureLines(normalized, markers) {
    const lines = normalized.split('\n');
    const kept = [];
    for (const raw of lines) {
        const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
        const trimmed = line.trim();
        let isMarker = false;
        for (const marker of markers) {
            if (marker.length > 0 && line.includes(marker)) {
                isMarker = true;
                break;
            }
        }
        if (isMarker) {
            kept.push(trimmed);
            continue;
        }
        // Detail line: keep the assertion/error evidence even with no marker.
        if (RE_PYTEST_DETAIL.test(trimmed) ||
            RE_ASSERT_WORD.test(trimmed) ||
            RE_ERROR_DETAIL.test(trimmed)) {
            kept.push(trimmed);
        }
    }
    // Head+tail window (mirrors clampAnalysis): a long dump of matching warnings
    // must not evict the trailing failure summary that distinguishes two
    // failures (AC-9/AC-10, P10).
    if (kept.length <= MAX_RETAINED_LINES)
        return kept;
    const head = Math.ceil(MAX_RETAINED_LINES / 2);
    const tail = MAX_RETAINED_LINES - head;
    return [...kept.slice(0, head), ...kept.slice(kept.length - tail)];
}
/**
 * Extract failing-test identifiers from retained lines, deduped and sorted so
 * that ordering-only differences collapse (TECHNICAL_SPECIFICATION.md §3.3).
 */
function extractFailingTestNames(retained) {
    const names = new Set();
    for (const line of retained) {
        let m;
        if ((m = line.match(/FAILED\s+(\S+)/))) {
            names.add(m[1]);
        }
        else if ((m = line.match(/---\s*FAIL:\s+(\S+)/))) {
            names.add(m[1]);
        }
        else if ((m = line.match(/^[✕✗]\s+(.+?)\s*$/))) {
            names.add(m[1]);
        }
    }
    return [...names].sort();
}
/**
 * The failure fingerprint — the crux of the design (TECHNICAL_SPECIFICATION.md
 * §3.3). Deterministic SHA-256 (Node `crypto`) of:
 *
 *   normalize(cmd) + "\n" + sorted(failingTestNames) + "\n" + normErrorBlock
 *
 * Noise-only differences (durations, line numbers, temp paths, addresses,
 * ANSI) hash EQUAL (AC-9); a different failing test name or assertion message
 * hashes DIFFERENT (AC-10).
 */
export function failureFingerprint(cmd, output, cfg) {
    const fp = cfg.fingerprint;
    const normCmd = normalizeOutput(cmd, fp).trim();
    const normOutput = normalizeOutput(output ?? '', fp);
    const retained = retainFailureLines(normOutput, fp.failure_markers);
    const testNames = extractFailingTestNames(retained);
    // The error block: retained failure-marker lines, deduped and sorted so that
    // print-ordering-only differences among failure lines collapse (P3).
    let errorBlock = [...new Set(retained)].sort().join('\n');
    // Degrade, never fabricate (P2): when NO failure-marker line is retained, the
    // command alone would make two genuinely different marker-less failures hash
    // EQUAL and manufacture a false repeat. Fall back to the FULL normalized
    // output so distinct failures stay distinct.
    if (retained.length === 0) {
        errorBlock = normOutput.trim();
    }
    const composed = `${normCmd}\n${testNames.join('\n')}\n${errorBlock}`;
    return createHash('sha256').update(composed, 'utf8').digest('hex');
}
// --- Category A: infrastructure phrase / status detection (text path) ---
/**
 * Built-in infrastructure phrases (case-insensitive). See
 * TECHNICAL_SPECIFICATION.md §4. Extendable via `retry_on_patterns`.
 */
const BUILTIN_INFRA_PHRASES = [
    'rate limit',
    'too many requests',
    'quota exceeded',
    'all credentials for model exhausted',
    'model unsupported',
    'service unavailable',
    'overloaded',
    'temporarily unavailable',
    // "try again LATER" is an infra retry hint; a bare "try again" is ordinary
    // test/CLI guidance and must NOT classify as infrastructure (finding 9).
    'try again later',
];
/** Bare status codes always treated as infra, per §4 ("bare 429/503/529"). */
const BUILTIN_INFRA_CODES = [429, 503, 529];
/**
 * HTTP/status context that must accompany a bare status number for it to count
 * as infrastructure (finding 9). Without this, ordinary assertion output like
 * `Expected: 500 Received: 400` was misclassified as Category A, silently
 * bypassing all capability counting. A code qualifies as infra only when it is
 * introduced by a status verb/noun, or immediately followed by a status reason.
 */
const CTX_BEFORE = '(?:http[\\s\\/][\\d.\\s]*|status(?:\\s*code)?\\s*[:=]?\\s*|code\\s*[:=]?\\s*|returned\\s+|response\\s+|replied\\s+|reply\\s+)';
const CTX_AFTER = '(?:\\s*(?:internal|service|gateway|bad\\s+gateway|unavailable|too\\s+many|overloaded|temporarily|server\\s+error))';
/**
 * Cache of the two compiled context regexes per status code (P6). `codes` come
 * from validated config + built-ins (a small, bounded set), so without this
 * `classifyFailure` recompiled ~2×N RegExp on every awaited hook call. `code` is
 * always a number, so `String(code)` is digits-only and safe to interpolate.
 */
const codeContextCache = new Map();
function contextRegexesFor(code) {
    let hit = codeContextCache.get(code);
    if (hit === undefined) {
        const c = String(code);
        hit = {
            before: new RegExp(`${CTX_BEFORE}${c}\\b`, 'i'),
            after: new RegExp(`\\b${c}${CTX_AFTER}`, 'i'),
        };
        codeContextCache.set(code, hit);
    }
    return hit;
}
/** Does `text` carry `code` in a genuine HTTP/status context (finding 9)? */
function codeInHttpContext(text, code) {
    const { before, after } = contextRegexesFor(code);
    return before.test(text) || after.test(text);
}
/**
 * Strong provider/HTTP framing that must accompany a built-in infra PHRASE in
 * shell/tool output before it counts as Category A (2026-08-25 finding 8).
 * Ordinary capability output that merely asserts text like
 * `Expected: rate limit exceeded` carries no such framing, so it stays
 * Category B and keeps flowing through capability/terminal accounting. The
 * structured `session.error` path does NOT require this — it is the
 * authoritative Category-A source and calls this classifier without the gate.
 */
const RE_PROVIDER_CONTEXT = /\bhttp\/\d|\bhttps?:\/\/|\bx-ratelimit|\bretry-after\b|\bwww-authenticate\b|\bstatus\s*code\b|\bhttp\s*status\b|\b(?:provider|upstream|gateway|endpoint|openrouter|anthropic|openai)\b/i;
/**
 * Does shell output carry strong provider/HTTP context for an infra phrase
 * (finding 8)? True when HTTP framing is present, or any candidate status code
 * appears in a genuine HTTP context.
 */
function hasProviderContext(scan, codes) {
    if (RE_PROVIDER_CONTEXT.test(scan))
        return true;
    for (const code of codes) {
        if (codeInHttpContext(scan, code))
            return true;
    }
    return false;
}
/**
 * Cache of compiled, validated `retry_on_patterns` sources (2026-08-25 finding
 * 12). Config validation rejects empty/unsafe/uncompilable sources at load, so
 * every source reaching here is safe; compiling once (rather than per failure)
 * keeps the awaited hook cheap. `null` marks a source that failed to compile
 * defensively, so a malformed pattern never crashes classification.
 */
const userPatternCache = new Map();
function compileUserPattern(source) {
    const cached = userPatternCache.get(source);
    if (cached !== undefined)
        return cached;
    let re;
    try {
        re = new RegExp(source, 'i');
    }
    catch {
        re = null;
    }
    userPatternCache.set(source, re);
    return re;
}
/**
 * Classify failure text as Category A (infrastructure — never escalates
 * capability) or Category B (capability). Returns `"A"` when the text carries a
 * `retry_on_errors` status code, a built-in infra phrase, a bare infra code, or
 * matches a `retry_on_patterns` source; otherwise `"B"` (FR-9).
 *
 * This is the tool-output text path of §4; the session-error HTTP path belongs
 * to the integration spec.
 */
export function classifyFailure(text, cfg, opts) {
    if (typeof text !== 'string' || text.length === 0)
        return 'B';
    // Bound the scanned text so an oversized/adversarial output can't drive
    // pathological regex work in the awaited host hook (finding 18/19).
    const scan = clampAnalysis(text);
    const lower = scan.toLowerCase();
    const requireCtx = opts?.requireHttpContext === true;
    // A bare status number is infrastructure ONLY in a genuine HTTP/status
    // context (finding 9), never merely because the digits appear in the output.
    const codes = new Set([
        ...cfg.retry_on_errors,
        ...BUILTIN_INFRA_CODES,
    ]);
    // Built-in phrases: authoritative on the structured session.error path, but
    // spoofable in raw shell output. In shell mode (requireHttpContext) a phrase
    // counts as infra only alongside strong provider/HTTP context (finding 8).
    for (const phrase of BUILTIN_INFRA_PHRASES) {
        if (lower.includes(phrase)) {
            if (!requireCtx || hasProviderContext(scan, codes))
                return 'A';
            break; // phrase present but unqualified in shell mode → keep checking codes
        }
    }
    for (const code of codes) {
        if (codeInHttpContext(scan, code))
            return 'A';
    }
    // User-configured patterns are trusted operator intent (compiled once,
    // finding 12) and apply in both modes.
    for (const source of cfg.retry_on_patterns) {
        const re = compileUserPattern(source);
        if (re !== null && re.test(scan))
            return 'A';
    }
    return 'B';
}
//# sourceMappingURL=detection.js.map