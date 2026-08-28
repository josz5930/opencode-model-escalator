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
import type { EscalatorConfig, FailureCategory, FingerprintConfig } from './types.js';
/**
 * Did `text` exceed the analysis bound (finding 7)? An over-sized output cannot
 * be fingerprinted without risking a false-equal hash (two outputs sharing a
 * prefix but differing in the excised middle would collide and manufacture a
 * false repeat). The orchestrator uses this to DEGRADE — skip counting the
 * failure — rather than count a fingerprint it cannot trust (NFR-2, AC-10, P2).
 */
export declare function isOversizedOutput(text: string): boolean;
/**
 * Does `cmd` look like a test run? Substring, case-sensitive match against
 * `cfg.test_commands` (TECHNICAL_SPECIFICATION.md §3.2, FR-11). The caller MUST
 * NOT fingerprint or count a command for which this returns `false` (FR-15).
 */
export declare function looksLikeTestCommand(cmd: string, cfg: Pick<EscalatorConfig, 'test_commands'>): boolean;
/**
 * Scrub volatile tokens from `text` per the TECHNICAL_SPECIFICATION.md §3.3
 * scrub table. Each rule is gated by its `fingerprint.*` toggle so the rules
 * are tunable without code changes (NFR-2). Deterministic: same input ⇒ same
 * output.
 */
export declare function normalizeOutput(text: string, fp: FingerprintConfig): string;
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
export declare function failureFingerprint(cmd: string, output: string, cfg: Pick<EscalatorConfig, 'fingerprint'>): string;
/**
 * Classify failure text as Category A (infrastructure — never escalates
 * capability) or Category B (capability). Returns `"A"` when the text carries a
 * `retry_on_errors` status code, a built-in infra phrase, a bare infra code, or
 * matches a `retry_on_patterns` source; otherwise `"B"` (FR-9).
 *
 * This is the tool-output text path of §4; the session-error HTTP path belongs
 * to the integration spec.
 */
export declare function classifyFailure(text: string, cfg: Pick<EscalatorConfig, 'retry_on_errors' | 'retry_on_patterns'>, opts?: {
    requireHttpContext?: boolean;
}): FailureCategory;
