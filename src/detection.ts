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
import type { EscalatorConfig, FailureCategory, FingerprintConfig } from './types.js';

/**
 * Does `cmd` look like a test run? Substring, case-sensitive match against
 * `cfg.test_commands` (TECHNICAL_SPECIFICATION.md §3.2, FR-11). The caller MUST
 * NOT fingerprint or count a command for which this returns `false` (FR-15).
 */
export function looksLikeTestCommand(
  cmd: string,
  cfg: Pick<EscalatorConfig, 'test_commands'>,
): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  for (const token of cfg.test_commands) {
    if (token.length > 0 && cmd.includes(token)) return true;
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
export function normalizeOutput(text: string, fp: FingerprintConfig): string {
  if (typeof text !== 'string') return '';
  let out = text;

  // ANSI first, so markers underneath become detectable.
  if (fp.strip_ansi) out = out.replace(RE_ANSI, '');

  if (fp.normalize_addresses) {
    out = out
      .replace(RE_UUID, '<uuid>')
      .replace(RE_TS, '<ts>')
      .replace(RE_ADDR, '<addr>')
      .replace(RE_HEX, '<hex>');
  }

  // Temp paths before durations/line-numbers so path contents don't get
  // partially rewritten first.
  if (fp.normalize_temp_paths) out = out.replace(RE_TMP, '<tmp>');

  if (fp.normalize_durations) out = out.replace(RE_DURATION, '<duration>');

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

/**
 * Retain only lines carrying a known failure marker (the semantic content).
 * See TECHNICAL_SPECIFICATION.md §3.3 step 2. Input should already be
 * normalized.
 */
function retainFailureLines(
  normalized: string,
  markers: string[],
): string[] {
  const lines = normalized.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    for (const marker of markers) {
      if (marker.length > 0 && line.includes(marker)) {
        kept.push(line.trim());
        break;
      }
    }
  }
  return kept;
}

/**
 * Extract failing-test identifiers from retained lines, deduped and sorted so
 * that ordering-only differences collapse (TECHNICAL_SPECIFICATION.md §3.3).
 */
function extractFailingTestNames(retained: string[]): string[] {
  const names = new Set<string>();
  for (const line of retained) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/FAILED\s+(\S+)/))) {
      names.add(m[1]!);
    } else if ((m = line.match(/---\s*FAIL:\s+(\S+)/))) {
      names.add(m[1]!);
    } else if ((m = line.match(/^[✕✗]\s+(.+?)\s*$/))) {
      names.add(m[1]!);
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
export function failureFingerprint(
  cmd: string,
  output: string,
  cfg: Pick<EscalatorConfig, 'fingerprint'>,
): string {
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
const BUILTIN_INFRA_PHRASES: string[] = [
  'rate limit',
  'too many requests',
  'quota exceeded',
  'all credentials for model exhausted',
  'model unsupported',
  'service unavailable',
  'overloaded',
  'temporarily unavailable',
  'try again',
];

/** Bare status codes always treated as infra, per §4 ("bare 429/503/529"). */
const BUILTIN_INFRA_CODES: number[] = [429, 503, 529];

/**
 * Classify failure text as Category A (infrastructure — never escalates
 * capability) or Category B (capability). Returns `"A"` when the text carries a
 * `retry_on_errors` status code, a built-in infra phrase, a bare infra code, or
 * matches a `retry_on_patterns` source; otherwise `"B"` (FR-9).
 *
 * This is the tool-output text path of §4; the session-error HTTP path belongs
 * to the integration spec.
 */
export function classifyFailure(
  text: string,
  cfg: Pick<EscalatorConfig, 'retry_on_errors' | 'retry_on_patterns'>,
): FailureCategory {
  if (typeof text !== 'string' || text.length === 0) return 'B';
  const lower = text.toLowerCase();

  for (const phrase of BUILTIN_INFRA_PHRASES) {
    if (lower.includes(phrase)) return 'A';
  }

  const codes = new Set<number>([
    ...cfg.retry_on_errors,
    ...BUILTIN_INFRA_CODES,
  ]);
  for (const code of codes) {
    if (new RegExp(`\\b${code}\\b`).test(text)) return 'A';
  }

  for (const source of cfg.retry_on_patterns) {
    try {
      if (new RegExp(source, 'i').test(text)) return 'A';
    } catch {
      // An invalid user pattern must not crash classification; ignore it.
    }
  }

  return 'B';
}
