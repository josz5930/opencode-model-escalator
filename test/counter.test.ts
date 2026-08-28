import { describe, it, expect } from 'vitest';
import {
  recordFailure,
  markCodeChanged,
  clearFailureState,
  initialState,
} from '../src/counter.js';
import type { StuckState } from '../src/types.js';

const THRESHOLD = 2;
const FP_A = 'fingerprint-a';
const FP_B = 'fingerprint-b';

describe('recordFailure — AC-2 unit part: escalate after repeated repair cycles', () => {
  it('same fingerprint with a code change between each ⇒ escalate at threshold', () => {
    let s: StuckState = initialState();

    // first failure: new fingerprint → repeats = 1, no escalate
    let r = recordFailure(s, FP_A, THRESHOLD);
    expect(r.state.repeats).toBe(1);
    expect(r.escalate).toBe(false);
    s = r.state;

    // agent edits code, re-runs to the SAME failure → repair cycle #2
    s = markCodeChanged(s);
    r = recordFailure(s, FP_A, THRESHOLD);
    expect(r.state.repeats).toBe(2);
    expect(r.escalate).toBe(true); // repeats >= threshold
  });
});

describe('recordFailure — AC-4: no fix, no count', () => {
  it('same fingerprint without a code change ⇒ repeats unchanged, escalate false', () => {
    let s: StuckState = initialState();
    s = recordFailure(s, FP_A, THRESHOLD).state; // repeats = 1

    // re-run identical failure with NO file.edited in between
    const r = recordFailure(s, FP_A, THRESHOLD);
    expect(r.state.repeats).toBe(1); // unchanged
    expect(r.escalate).toBe(false);
  });
});

describe('recordFailure — AC-3: different failure resets counter', () => {
  it('new fingerprint while repeats=1 ⇒ repeats resets to 1, escalate false', () => {
    let s: StuckState = initialState();
    s = recordFailure(s, FP_A, THRESHOLD).state; // repeats = 1, prev = A
    s = markCodeChanged(s);

    const r = recordFailure(s, FP_B, THRESHOLD);
    expect(r.state.previousFailure).toBe(FP_B);
    expect(r.state.repeats).toBe(1);
    expect(r.state.codeChangedSinceFailure).toBe(false);
    expect(r.escalate).toBe(false);
  });
});

describe('recordFailure — purity (spec Design Notes)', () => {
  it('never mutates the input state', () => {
    const s: StuckState = initialState();
    const frozen = Object.freeze({ ...s });
    const r = recordFailure(frozen, FP_A, THRESHOLD);
    expect(frozen.repeats).toBe(0);
    expect(r.state).not.toBe(frozen);
    expect(s.repeats).toBe(0);
    expect(r.state).not.toBe(s);
  });
});

describe('recordFailure — requireCodeChange=false counts without an edit (P28)', () => {
  it('two identical fingerprints with the gate off escalate at threshold', () => {
    let s: StuckState = initialState();
    let r = recordFailure(s, FP_A, THRESHOLD, false);
    expect(r.escalate).toBe(false);
    r = recordFailure(r.state, FP_A, THRESHOLD, false);
    expect(r.escalate).toBe(true);
    expect(r.state.repeats).toBe(2);
  });
});

describe('clearFailureState — AC-8: pass clears counters, keeps stage', () => {
  it('clears previousFailure/repeats/codeChanged but preserves stage', () => {
    const s: StuckState = {
      stage: 1,
      previousFailure: FP_A,
      repeats: 1,
      codeChangedSinceFailure: true,
    };
    const cleared = clearFailureState(s);
    expect(cleared.stage).toBe(1); // preserved — no in-task de-escalation
    expect(cleared.previousFailure).toBeUndefined();
    expect(cleared.repeats).toBe(0);
    expect(cleared.codeChangedSinceFailure).toBe(false);
    // purity
    expect(s.previousFailure).toBe(FP_A);
  });
});

describe('markCodeChanged', () => {
  it('sets the flag without mutating the input', () => {
    const s: StuckState = initialState();
    const next = markCodeChanged(s);
    expect(next.codeChangedSinceFailure).toBe(true);
    expect(s.codeChangedSinceFailure).toBe(false);
  });
});

describe('recordFailure — per-stage threshold of 1 escalates immediately on repeat', () => {
  it('escalates when repeats reaches a threshold of 1', () => {
    const s: StuckState = initialState();
    const r = recordFailure(s, FP_A, 1);
    expect(r.state.repeats).toBe(1);
    expect(r.escalate).toBe(true);
  });
});

describe('recordFailure — escalate stays true past the threshold (P7d)', () => {
  it('a further identical repair-cycle failure keeps escalate === true', () => {
    let s: StuckState = initialState();
    s = recordFailure(s, FP_A, THRESHOLD).state; // repeats = 1
    s = markCodeChanged(s);
    let r = recordFailure(s, FP_A, THRESHOLD); // repeats = 2 → escalate
    expect(r.escalate).toBe(true);
    expect(r.state.repeats).toBe(2);

    // yet another edit + same failure: repeats climbs, escalate remains true
    s = markCodeChanged(r.state);
    r = recordFailure(s, FP_A, THRESHOLD);
    expect(r.state.repeats).toBe(3);
    expect(r.escalate).toBe(true);
  });
});
