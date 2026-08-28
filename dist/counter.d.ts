/**
 * The pure repair-cycle counter (TECHNICAL_SPECIFICATION.md §3.4).
 *
 * Closes FR-3 (repair-cycle gating) and FR-6 (a pass clears failure counters
 * but never the stage — counter portion).
 *
 * Every function is a pure reducer: it returns the NEXT state and never mutates
 * the caller's object. The integration spec owns the mutable
 * `Map<sessionID, StuckState>`. No runtime imports beyond the shared types.
 */
import type { StuckState } from './types.js';
/** Result of feeding one failure into the counter. */
export type RecordFailureResult = {
    /** The next state (a fresh object; the input is not mutated). */
    state: StuckState;
    /** `true` when `repeats >= threshold` after this failure. */
    escalate: boolean;
};
/**
 * Record a Category B failure and decide whether to escalate.
 *
 * Per §3.4, with the repair-cycle gate `requireCodeChange` (the resolved
 * `require_code_change_between_failures` policy, CFG-3):
 * - same fingerprint AND (`codeChangedSinceFailure` OR the gate is off) ⇒ a
 *   repair cycle failed: `repeats++` and clear the flag.
 * - same fingerprint, gate ON, WITHOUT a code change ⇒ do NOT count (Risk R3):
 *   repeats and the flag are unchanged.
 * - a different fingerprint ⇒ progress: `previousFailure = fingerprint`,
 *   `repeats = 1`, `codeChangedSinceFailure = false`.
 *
 * `escalate = repeats >= threshold` on the resulting state. `requireCodeChange`
 * defaults to `true` (the documented default) so existing callers are
 * unchanged.
 */
export declare function recordFailure(state: StuckState, fingerprint: string, threshold: number, requireCodeChange?: boolean): RecordFailureResult;
/**
 * Mark that a `file.edited` fired since the last counted failure (FR-3).
 * Pure: returns the next state.
 */
export declare function markCodeChanged(state: StuckState): StuckState;
/**
 * A passing test clears the failure counters but preserves `stage` — no
 * in-task de-escalation (FR-6, AC-8). Pure: returns the next state.
 */
export declare function clearFailureState(state: StuckState): StuckState;
/**
 * A fresh per-session state at the cheapest stage (stage 0).
 */
export declare function initialState(stage?: number): StuckState;
