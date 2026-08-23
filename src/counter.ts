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
 * Per §3.4:
 * - same fingerprint AND `codeChangedSinceFailure` ⇒ a genuine repair cycle
 *   failed: `repeats++` and clear the flag.
 * - same fingerprint WITHOUT a code change ⇒ do NOT count (Risk R3): repeats
 *   and the flag are unchanged.
 * - a different fingerprint ⇒ progress: `previousFailure = fingerprint`,
 *   `repeats = 1`, `codeChangedSinceFailure = false`.
 *
 * `escalate = repeats >= threshold` on the resulting state.
 */
export function recordFailure(
  state: StuckState,
  fingerprint: string,
  threshold: number,
): RecordFailureResult {
  const next: StuckState = { ...state };

  if (fingerprint === state.previousFailure) {
    if (state.codeChangedSinceFailure) {
      // A genuine repair cycle failed to the same fingerprint.
      next.repeats = state.repeats + 1;
      next.codeChangedSinceFailure = false;
    }
    // else: same failure, no fix attempted → ignore (Risk R3, FR-3).
  } else {
    // Failure changed → progress. Reset the count to 1 (FR-2, AC-3).
    next.previousFailure = fingerprint;
    next.repeats = 1;
    next.codeChangedSinceFailure = false;
  }

  return { state: next, escalate: next.repeats >= threshold };
}

/**
 * Mark that a `file.edited` fired since the last counted failure (FR-3).
 * Pure: returns the next state.
 */
export function markCodeChanged(state: StuckState): StuckState {
  return { ...state, codeChangedSinceFailure: true };
}

/**
 * A passing test clears the failure counters but preserves `stage` — no
 * in-task de-escalation (FR-6, AC-8). Pure: returns the next state.
 */
export function clearFailureState(state: StuckState): StuckState {
  return {
    stage: state.stage,
    previousFailure: undefined,
    repeats: 0,
    codeChangedSinceFailure: false,
  };
}

/**
 * A fresh per-session state at the cheapest stage (stage 0).
 */
export function initialState(stage = 0): StuckState {
  return {
    stage,
    previousFailure: undefined,
    repeats: 0,
    codeChangedSinceFailure: false,
  };
}
