import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/config.js';
import {
  createEscalator,
  type ControlStatus,
  type Escalator,
  type EscalatorEffects,
  type LogEntry,
} from '../src/session.js';
import type { UserConfig } from '../src/config.js';

// --- fixtures ---------------------------------------------------------------

const SID = 'sess-1';
const M0 = 'openrouter/cheap';
const M1 = 'openrouter/mid';
const M2 = 'anthropic/strong';

// Same command+output ⇒ same fingerprint. Distinct failing test names ⇒ distinct.
const CMD = 'pytest';
const FAIL_A = 'FAILED test_alpha\nAssertionError: expected 1 got 2';
const FAIL_B = 'FAILED test_beta\nAssertionError: expected 3 got 4';
const RATE_LIMIT = 'FAILED test_alpha\n429 Too Many Requests';

type Call =
  | { type: 'abort'; sessionID: string }
  | { type: 'replay'; sessionID: string; model: string }
  | { type: 'retry'; sessionID: string; model: string; delayMs: number }
  | { type: 'notify'; message: string }
  | { type: 'log'; entry: LogEntry };

function makeEffects(): { calls: Call[]; effects: EscalatorEffects } {
  const calls: Call[] = [];
  const effects: EscalatorEffects = {
    abort: (sessionID) => {
      calls.push({ type: 'abort', sessionID });
    },
    replay: (sessionID, model) => {
      calls.push({ type: 'replay', sessionID, model });
    },
    retry: (sessionID, model, delayMs) => {
      calls.push({ type: 'retry', sessionID, model, delayMs });
    },
    notify: (message) => {
      calls.push({ type: 'notify', message });
    },
    log: (entry) => {
      calls.push({ type: 'log', entry });
    },
  };
  return { calls, effects };
}

function makeConfig(
  models: { model: string; same_failure_threshold?: number }[] = [
    { model: M0 },
    { model: M1 },
    { model: M2 },
  ],
  overrides: Partial<UserConfig> = {},
) {
  return resolveConfig({ models, ...overrides } as UserConfig);
}

const NOW = 1000;

const fail = (esc: Escalator, output = FAIL_A, now = NOW) =>
  esc.onTestResult({ sessionID: SID, command: CMD, output, exitCode: 1, now });
const pass = (esc: Escalator, now = NOW) =>
  esc.onTestResult({ sessionID: SID, command: CMD, output: '', exitCode: 0, now });
const edit = (esc: Escalator, now = NOW) =>
  esc.onFileEdited({ sessionID: SID, now });
const status = (esc: Escalator, now = NOW): ControlStatus =>
  esc.control(SID, 'status', now);

const aborts = (calls: Call[]) => calls.filter((c) => c.type === 'abort');
const replays = (calls: Call[]) =>
  calls.filter((c): c is Extract<Call, { type: 'replay' }> => c.type === 'replay');
const notifies = (calls: Call[]) =>
  calls.filter((c): c is Extract<Call, { type: 'notify' }> => c.type === 'notify');
const retries = (calls: Call[]) =>
  calls.filter((c): c is Extract<Call, { type: 'retry' }> => c.type === 'retry');

/** Drive one full repair-cycle escalation: fail → edit → fail (reaches thr=2). */
async function escalateOnce(esc: Escalator, output = FAIL_A) {
  await fail(esc, output);
  edit(esc);
  await fail(esc, output);
}

// --- tests ------------------------------------------------------------------

describe('createEscalator — matrix rows & named ACs', () => {
  it('AC-1 cheap-first pass: exit 0 clears failure state, stage stays 0, no effect', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await pass(esc);

    const s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.activeModel).toBe(M0);
    expect(s.repeats).toBe(0);
    expect(aborts(calls)).toHaveLength(0);
    expect(replays(calls)).toHaveLength(0);
  });

  it('AC-1 fail then pass at stage 0 stays cheap: no abort, activeModel remains models[0]', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc);
    await pass(esc);

    const s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.activeModel).toBe(M0);
    expect(s.repeats).toBe(0);
    expect(aborts(calls)).toHaveLength(0);
    expect(replays(calls)).toHaveLength(0);
  });

  it('AC-2 escalate on repeat: one abort then one replay(M1), escalation notify, stage 1, counters reset', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc);

    // exact effect sequence: abort → replay(M1) → notify
    const seq = calls.filter((c) => c.type !== 'log').map((c) => c.type);
    expect(seq).toEqual(['abort', 'replay', 'notify']);
    expect(replays(calls)).toHaveLength(1);
    expect(replays(calls)[0]).toEqual({ type: 'replay', sessionID: SID, model: M1 });

    const s = status(esc);
    expect(s.stage).toBe(1);
    expect(s.activeModel).toBe(M1);
    expect(s.repeats).toBe(0); // counters reset on escalation
    expect(s.pendingModel).toBe(M1); // marks the pending self-replay
    expect(s.previousFailure).toBeUndefined();
    expect(notifies(calls)[0]!.message).toBe('Escalated to ' + M1);
  });

  it('AC-3 different failure: new fingerprint resets repeats to 1, no escalation', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc, FAIL_A); // repeats 1
    edit(esc);
    await fail(esc, FAIL_B); // different fp → repeats back to 1

    expect(status(esc).repeats).toBe(1);
    expect(aborts(calls)).toHaveLength(0);
  });

  it('AC-4 no fix, no count: same fingerprint without an edit between ⇒ repeats unchanged', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc, FAIL_A); // repeats 1
    await fail(esc, FAIL_A); // no edit between → not counted

    expect(status(esc).repeats).toBe(1);
    expect(aborts(calls)).toHaveLength(0);
  });

  it('AC-5 rate limit in test output: Category-A path, capability state untouched', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc, FAIL_A); // repeats 1 (Category B)
    const previousFailure = status(esc).previousFailure;
    edit(esc);
    await fail(esc, RATE_LIMIT); // Category A → must not count

    const s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.repeats).toBe(1); // unchanged by the Category-A hit
    expect(s.previousFailure).toBe(previousFailure);
    expect(retries(calls)).toHaveLength(1);
    expect(aborts(calls)).toHaveLength(1); // abort then same-model retry (P2)
    expect(replays(calls)).toHaveLength(0);
  });

  it('AC-5 session error (429): never touches counters/stage', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc, FAIL_A); // repeats 1
    await esc.onSessionError({ sessionID: SID, status: 429, message: 'rate limit', now: NOW });

    const s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.repeats).toBe(1);
    expect(retries(calls)).toHaveLength(1);
    expect(aborts(calls)).toHaveLength(1);
  });

  it('AC-7 terminal stop: at top of chain, abort + terminal notify, no replay (stop_at_max_model default true)', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig([{ model: M0 }, { model: M1 }]), effects });

    await escalateOnce(esc, FAIL_A); // stage 0 → 1 (top of a 2-model chain)
    expect(status(esc).stage).toBe(1);
    const replaysAfterFirst = replays(calls).length;
    const abortsAfterFirst = aborts(calls).length;

    await escalateOnce(esc, FAIL_B); // at top, threshold reached → terminal

    expect(replays(calls)).toHaveLength(replaysAfterFirst); // no new replay
    // bounded-spend invariant: the terminal step DOES abort the top-model run
    expect(aborts(calls)).toHaveLength(abortsAfterFirst + 1);
    expect(notifies(calls).some((n) => n.message === 'Max escalation reached — automation stopped')).toBe(true);
    expect(status(esc).stage).toBe(1); // never advanced past the top
  });

  it('2026-08-25 finding 4 — terminal stop with stop_at_max_model=false STILL aborts (bounded spend is unconditional)', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig([{ model: M0 }, { model: M1 }], { stop_at_max_model: false }),
      effects,
    });

    await escalateOnce(esc, FAIL_A); // stage 0 → 1
    const abortsAfterFirst = aborts(calls).length;
    const replaysAfterFirst = replays(calls).length;

    await escalateOnce(esc, FAIL_B); // at top, threshold reached → terminal

    // finding 4: the top-of-chain run is a runaway spender; the bounded-spend
    // invariant requires we abort it regardless of stop_at_max_model. The flag
    // now governs only the LATCH (whether the session stops reacting), never
    // whether we stop paying for the run.
    expect(aborts(calls)).toHaveLength(abortsAfterFirst + 1);
    expect(replays(calls)).toHaveLength(replaysAfterFirst); // still never loops the top model
    expect(notifies(calls).some((n) => n.message === 'Max escalation reached — automation stopped')).toBe(true);
    expect(status(esc).stage).toBe(1);
    // redefined semantics: with the flag off the session is NOT latched.
    expect(status(esc).terminated).toBe(false);
  });

  it('2026-08-25 finding 4 — default stop_at_max_model=true DOES latch after the terminal abort', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig([{ model: M0 }, { model: M1 }]), effects });

    await escalateOnce(esc, FAIL_A); // stage 0 → 1
    await escalateOnce(esc, FAIL_B); // at top → terminal

    expect(aborts(calls).length).toBeGreaterThan(0); // abort still unconditional
    expect(status(esc).terminated).toBe(true); // latched (default, recommended)
  });

  it('AC-8 pass keeps stage: after escalating, a pass clears counters but preserves stage', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // → stage 1
    await pass(esc);

    const s = status(esc);
    expect(s.stage).toBe(1);
    expect(s.repeats).toBe(0);
  });

  it('AC-6 / AC-11 replay chat message is consumed (not a reset), then a genuine task resets', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // → stage 1, pendingModel = M1
    expect(status(esc).pendingModel).toBe(M1);

    // the self-triggered replay surfaces as a chat message: consumed, no reset
    // (must carry the pending model — omitted model is NOT treated as self-replay)
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW });
    let s = status(esc);
    expect(s.stage).toBe(1);
    expect(s.pendingModel).toBeUndefined();

    // a genuine new user task resets to the cheapest stage
    await esc.onChatMessage({ sessionID: SID, taskId: 't2', now: NOW });
    s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.repeats).toBe(0);
  });

  it('AC-11 in-flight guard: a re-entrant escalation during replay is a no-op', async () => {
    const config = makeConfig([
      { model: M0 },
      { model: M1, same_failure_threshold: 1 },
      { model: M2 },
    ]);
    const { calls, effects } = makeEffects();
    let reentered = false;
    let esc: Escalator;
    esc = createEscalator({
      config,
      effects: {
        ...effects,
        replay: async (sessionID, model) => {
          calls.push({ type: 'replay', sessionID, model });
          if (!reentered) {
            reentered = true;
            // A fresh failure at the new (threshold-1) stage would escalate
            // again — but escalationInFlight is still true, so it must no-op.
            await esc.onTestResult({
              sessionID: SID,
              command: CMD,
              output: FAIL_B,
              exitCode: 1,
              now: NOW,
            });
          }
        },
      },
    });

    await escalateOnce(esc, FAIL_A); // stage 0 → 1, triggering the re-entry

    expect(aborts(calls)).toHaveLength(1); // only the stage 0→1 abort
    expect(replays(calls)).toHaveLength(1); // no second replay to stage 2
    expect(status(esc).stage).toBe(1); // guard prevented advancing to stage 2
  });

  it('AC-15 missing signal: matched cmd, no exit code + no marker ⇒ no change', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onTestResult({ sessionID: SID, command: CMD, output: 'all good so far', now: NOW });

    expect(status(esc).repeats).toBe(0);
    expect(aborts(calls)).toHaveLength(0);
  });

  it('spec §3.1 marker fallback: matched cmd, no exit code, but a failure marker still counts', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onTestResult({ sessionID: SID, command: CMD, output: FAIL_A, now: NOW });

    expect(status(esc).repeats).toBe(1);
  });

  it('AC-15 unrecognized command is ignored entirely', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onTestResult({ sessionID: SID, command: 'ls -la', output: FAIL_A, exitCode: 1, now: NOW });

    expect(status(esc).repeats).toBe(0);
    expect(aborts(calls)).toHaveLength(0);
  });

  it('AC-13 control status returns stage, active model, repeats, truncated fingerprint, in-flight flag, config', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc, FAIL_A); // repeats 1, previousFailure set

    const s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.activeModel).toBe(M0);
    expect(s.repeats).toBe(1);
    expect(typeof s.previousFailure).toBe('string');
    expect(s.previousFailure!.length).toBeLessThanOrEqual(12);
    expect(s.escalationInFlight).toBe(false);
    expect(s.config.models).toEqual([M0, M1, M2]);
    expect(s.config.same_failure_threshold).toBe(2);
    expect(s.config.stop_at_max_model).toBe(true);
  });

  it('control disable/enable/reset: disabled session ignores hooks; reset returns to stage 0', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    esc.control(SID, 'disable', NOW);
    await escalateOnce(esc); // all hooks ignored while disabled
    expect(status(esc).repeats).toBe(0);
    expect(aborts(calls)).toHaveLength(0);

    esc.control(SID, 'enable', NOW);
    await fail(esc, FAIL_A);
    expect(status(esc).repeats).toBe(1);

    const after = esc.control(SID, 'reset', NOW);
    expect(after.stage).toBe(0);
    expect(after.repeats).toBe(0);
    expect(after.previousFailure).toBeUndefined();
  });

  it('notify_on_escalation=false suppresses the escalation toast but still escalates', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { notify_on_escalation: false }),
      effects,
    });

    await escalateOnce(esc);

    const seq = calls.filter((c) => c.type !== 'log').map((c) => c.type);
    expect(seq).toEqual(['abort', 'replay']); // no notify
    expect(status(esc).stage).toBe(1);
  });

  it('reset_on_new_user_task=false: a genuine new task preserves the stage', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { reset_on_new_user_task: false }),
      effects,
    });

    await escalateOnce(esc); // → stage 1, pendingModel set
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // consume the self-replay
    await esc.onChatMessage({ sessionID: SID, taskId: 't2', now: NOW }); // genuine new task

    expect(status(esc).stage).toBe(1); // NOT reset, because the option is off
  });

  it('per-stage same_failure_threshold drives escalation timing at stage > 0', async () => {
    const { calls, effects } = makeEffects();
    // stage 1 escalates after a SINGLE counted repeat (threshold 1), vs default 2.
    const esc = createEscalator({
      config: makeConfig([{ model: M0 }, { model: M1, same_failure_threshold: 1 }, { model: M2 }]),
      effects,
    });

    await escalateOnce(esc, FAIL_A); // stage 0 (threshold 2) → stage 1
    expect(status(esc).stage).toBe(1);

    // one counted failure at stage 1 (new fingerprint → repeats 1 >= threshold 1)
    await fail(esc, FAIL_B);

    const r = replays(calls);
    expect(r).toHaveLength(2);
    expect(r[1]!.model).toBe(M2); // escalated to the next stage on a single repeat
    expect(status(esc).stage).toBe(2);
  });

  it('a file edit made while disabled does not arm the counter after re-enable', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await fail(esc, FAIL_A); // repeats 1, previousFailure = A
    esc.control(SID, 'disable', NOW);
    edit(esc); // disabled → must NOT set codeChangedSinceFailure
    esc.control(SID, 'enable', NOW);
    await fail(esc, FAIL_A); // same fp; only counts if the edit armed the flag

    expect(status(esc).repeats).toBe(1); // unchanged — edit was ignored
    expect(status(esc).stage).toBe(0);
    expect(aborts(calls)).toHaveLength(0);
  });

  it('EC2: a failed escalation dispatch clears pendingModel so the next user message is not swallowed', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        replay: () => {
          throw new Error('sdk unavailable');
        },
      },
    });

    await escalateOnce(esc); // escalate dispatch: abort ok, replay throws → caught

    expect(status(esc).pendingModel).toBeUndefined(); // cleared on failure
    // a warn log records the failure
    expect(
      calls.some((c) => c.type === 'log' && c.entry.level === 'warn'),
    ).toBe(true);

    // the next genuine user message resets normally instead of being consumed
    esc.onChatMessage({ sessionID: SID, taskId: 't2', now: NOW });
    expect(status(esc).stage).toBe(0);
  });

  // --- finding 2: bounded Category-A retry with exponential backoff ---------

  it('finding 2: a session error (429) schedules a same-model retry with backoff, bounded by max_infra_retries', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, {
        max_infra_retries: 2,
        infra_retry_cooldown_ms: 1000,
      }),
      effects,
    });

    // 1st infra error → retry #1 at base cooldown, same model M0
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    // 2nd → retry #2 at doubled cooldown
    await esc.onSessionError({ sessionID: SID, status: 503, now: NOW });
    // 3rd → budget exhausted: no retry, infra-stop notify (D1: infra-only latch)
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });

    const r = retries(calls);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ type: 'retry', sessionID: SID, model: M0, delayMs: 1000 });
    expect(r[1]).toEqual({ type: 'retry', sessionID: SID, model: M0, delayMs: 2000 });
    expect(
      notifies(calls).some(
        (n) => n.message === 'Infrastructure failure persists — automatic retries stopped',
      ),
    ).toBe(true);
    // capability state never moved (AC-5)
    expect(status(esc).stage).toBe(0);
    // abort then retry on each recovery; abort on exhaustion (P1/P2)
    expect(aborts(calls)).toHaveLength(3);
    // D1: the infra give-up sets the Category-A `infraStopped` latch, NOT the
    // global `terminated` latch — capability escalation stays live.
    expect(status(esc).infraStopped).toBe(true);
    expect(status(esc).terminated).toBe(false);

    const retriesAfter = retries(calls).length;
    const abortsAfter = aborts(calls).length;
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    expect(retries(calls)).toHaveLength(retriesAfter); // 4th 429 is inert
    expect(aborts(calls)).toHaveLength(abortsAfter);
  });

  it('finding 2: a passing test resets the infra retry budget', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { max_infra_retries: 1, infra_retry_cooldown_ms: 500 }),
      effects,
    });

    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW }); // retry #1
    await pass(esc); // recovery → budget cleared
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW }); // retry #1 again

    expect(retries(calls)).toHaveLength(2);
    expect(retries(calls).every((c) => c.delayMs === 500)).toBe(true);
  });

  it('finding 2: provider_failover=false disables infra retry and notifies instead', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { provider_failover: false }),
      effects,
    });

    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });

    expect(retries(calls)).toHaveLength(0);
    expect(
      notifies(calls).some(
        (n) => n.message === 'Infrastructure failure persists — automatic retries stopped',
      ),
    ).toBe(true);
    // D1: infra give-up latches the Category-A flag only, not global `terminated`.
    expect(status(esc).infraStopped).toBe(true);
    expect(status(esc).terminated).toBe(false);
    expect(aborts(calls)).toHaveLength(1);

    const abortsAfter = aborts(calls).length;
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    expect(aborts(calls)).toHaveLength(abortsAfter);
    expect(retries(calls)).toHaveLength(0);
  });

  // --- finding 1: strict cheap-first enforcement via replay -----------------

  it('finding 1: a genuine new task observed on a stronger model is rebound to models[0] via abort+replay', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    // A new user task arrives already running on M2 (a leftover escalation).
    await esc.onChatMessage({ sessionID: SID, taskId: 't1', model: M2, now: NOW });

    const seq = calls.filter((c) => c.type !== 'log').map((c) => c.type);
    expect(seq).toEqual(['abort', 'replay']);
    expect(replays(calls)[0]).toEqual({ type: 'replay', sessionID: SID, model: M0 });
    expect(status(esc).stage).toBe(0);
  });

  it('finding 1: a new task already on models[0] is NOT rebound', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onChatMessage({ sessionID: SID, taskId: 't1', model: M0, now: NOW });

    expect(aborts(calls)).toHaveLength(0);
    expect(replays(calls)).toHaveLength(0);
  });

  it('finding 1: rebind is skipped when reset_on_new_user_task is off', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { reset_on_new_user_task: false }),
      effects,
    });

    await esc.onChatMessage({ sessionID: SID, taskId: 't1', model: M2, now: NOW });

    expect(aborts(calls)).toHaveLength(0);
    expect(replays(calls)).toHaveLength(0);
  });

  // --- finding 8: self-replay is identity-bound to the dispatched model ------

  it('finding 8: a new task under a DIFFERENT model does not consume the pending self-replay marker', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // → stage 1, pendingModel = M1
    expect(status(esc).pendingModel).toBe(M1);

    // A genuine new task on a DIFFERENT model (M2) must not be swallowed as the
    // self-replay. It falls through to new-task handling (reset + cheap-first).
    const abortsBefore = aborts(calls).length;
    await esc.onChatMessage({ sessionID: SID, taskId: 't2', model: M2, now: NOW });

    const s = status(esc);
    expect(s.stage).toBe(0); // reset happened
    expect(s.pendingModel).toBe(M0); // rebind to cheap in flight / recorded
    expect(aborts(calls).length).toBeGreaterThan(abortsBefore); // rebind dispatched
  });

  it('finding 8: the self-replay under the pending model IS consumed (no reset)', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // stage 1, pendingModel = M1
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // the replay

    const s = status(esc);
    expect(s.stage).toBe(1);
    expect(s.pendingModel).toBeUndefined();
  });

  // --- finding 6: terminal latch stops repeated terminal firing --------------

  it('finding 6: once terminally stopped, further identical failures take no action until reset', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig([{ model: M0 }, { model: M1 }]), effects });

    await escalateOnce(esc, FAIL_A); // stage 0 → 1, pendingModel = M1
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // consume replay
    await escalateOnce(esc, FAIL_B); // at top → terminal stop (abort + notify)
    expect(status(esc).terminated).toBe(true);
    const abortsAfterTerminal = aborts(calls).length;
    const notifiesAfterTerminal = notifies(calls).length;

    // more failures arrive after the terminal stop — must be fully inert
    await escalateOnce(esc, FAIL_A);
    await fail(esc, FAIL_B);

    expect(aborts(calls)).toHaveLength(abortsAfterTerminal); // no new aborts
    expect(notifies(calls)).toHaveLength(notifiesAfterTerminal); // no new notifies

    // a genuine new task clears the latch
    await esc.onChatMessage({ sessionID: SID, taskId: 't2', model: M0, now: NOW });
    expect(status(esc).terminated).toBe(false);
  });

  // --- finding 5: a dispatch failure rolls back the stage and stops ----------

  it('finding 5: an escalation whose replay fails rolls the stage back and terminally stops', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        abort: (sessionID) => {
          calls.push({ type: 'abort', sessionID });
        },
        replay: () => {
          throw new Error('sdk unavailable');
        },
      },
    });

    await escalateOnce(esc); // escalate at stage 0: abort ok, replay throws

    const s = status(esc);
    expect(s.stage).toBe(0); // rolled back from the attempted stage 1
    expect(s.terminated).toBe(true); // stopped so nothing runs under a false stage
    expect(s.pendingModel).toBeUndefined();
    expect(
      notifies(calls).some((n) => n.message === 'Escalation dispatch failed — automation stopped'),
    ).toBe(true);
  });

  it('finding 7: a terminal abort that throws still latches and notifies', async () => {
    const { calls, effects } = makeEffects();
    // A single-model chain: stage 0 is already the top, so the first escalation
    // takes the terminal path (abort + terminal notify) — where abort throws.
    const esc = createEscalator({
      config: makeConfig([{ model: M0 }]),
      effects: {
        ...effects,
        abort: () => {
          throw new Error('abort failed');
        },
      },
    });

    await escalateOnce(esc, FAIL_A); // threshold reached at the top → terminal stop

    const s = status(esc);
    expect(s.terminated).toBe(true); // latched despite the abort failure
    expect(s.stage).toBe(0);
    expect(
      notifies(calls).some((n) => n.message === 'Max escalation reached — automation stopped'),
    ).toBe(true);
    // a warn log records the swallowed abort error
    expect(
      calls.some(
        (c) =>
          c.type === 'log' &&
          c.entry.level === 'warn' &&
          c.entry.message.includes('terminal abort failed'),
      ),
    ).toBe(true);
  });

  it('NFR-4 idle GC drops sessions idle beyond idle_cleanup_ms', async () => {
    const { effects } = makeEffects();
    const config = makeConfig();
    const esc = createEscalator({ config, effects });

    await escalateOnce(esc); // stage 1, lastActivity = NOW
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // consume pending
    expect(status(esc, NOW).stage).toBe(1);

    // within the idle window: kept
    esc.gc(NOW + config.idle_cleanup_ms);
    expect(status(esc, NOW).stage).toBe(1);

    // beyond the idle window: dropped → next access rebuilds a fresh stage-0 state
    esc.gc(NOW + config.idle_cleanup_ms + 1);
    // read status without touching activity of a *surviving* entry: the entry is
    // gone, so ensure() recreates it fresh at stage 0.
    expect(esc.control(SID, 'status', NOW + config.idle_cleanup_ms + 2).stage).toBe(0);
  });
});

// --- 2026-08-25 code-review findings: dedicated regressions ------------------

/** Let fire-and-forget async dispatches (reset-rebind, retries) settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('2026-08-25 review — orchestrator invariants', () => {
  it('finding 1 — Category-A recovery at an escalated stage does NOT de-escalate', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // → stage 1 (model M1), pending self-replay = M1
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // consume replay
    expect(status(esc).stage).toBe(1);

    // Infra failure at the escalated stage: retry re-dispatches the SAME model.
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    const r = retries(calls);
    expect(r).toHaveLength(1);
    expect(r[0]!.model).toBe(M1); // retry the CURRENT stage's model, not the cheap one

    // The retry's chat.message (same model) is consumed as the plugin's own
    // replay — it must NOT be mistaken for a new task and reset capability.
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW });
    const s = status(esc);
    expect(s.stage).toBe(1); // capability preserved (the reproduced 1→0 bug is gone)
    expect(s.pendingModel).toBeUndefined();
  });

  it('finding 1 — a Category-A retry whose dispatch is rejected stops and notifies', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        retry: () => {
          throw new Error('provider down');
        },
      },
    });

    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });

    // A retry whose *dispatch* throws is a hard safety-terminal stop: the plugin
    // could not complete the abort→replay it committed to, so it latches the
    // global `terminated` flag (NOT the softer Category-A `infraStopped`).
    expect(status(esc).terminated).toBe(true);
    expect(
      notifies(calls).some(
        (n) => n.message === 'Infrastructure failure persists — automatic retries stopped',
      ),
    ).toBe(true);
  });

  it('finding 2 — pending replay is bound to task id: same model + different id is NOT consumed', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    // Establish a real task identity, then escalate: the pending replay now
    // carries taskId "orig".
    await esc.onChatMessage({ sessionID: SID, taskId: 'orig', model: M0, now: NOW });
    await escalateOnce(esc); // stage 1, pendingReplay bound to { model: M1, taskId: orig }
    expect(status(esc).pendingModel).toBe(M1);

    // A GENUINE new task under the pending model M1 but a DIFFERENT id must not
    // be swallowed as the replay — it is a new task and resets capability.
    const abortsBefore = aborts(calls).length;
    await esc.onChatMessage({ sessionID: SID, taskId: 'different', model: M1, now: NOW });
    const s = status(esc);
    expect(s.stage).toBe(0); // reset happened ⇒ it was NOT consumed as the replay
    expect(aborts(calls).length).toBeGreaterThan(abortsBefore); // rebind dispatched
  });

  it('finding 2 — the replay under the matching task id IS consumed (stage preserved)', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onChatMessage({ sessionID: SID, taskId: 'orig', model: M0, now: NOW });
    await escalateOnce(esc); // pendingReplay { model: M1, taskId: orig }
    await esc.onChatMessage({ sessionID: SID, taskId: 'orig', model: M1, now: NOW });

    const s = status(esc);
    expect(s.stage).toBe(1);
    expect(s.pendingModel).toBeUndefined();
  });

  it('finding 3 — control reset rebinds the live model back to models[0]', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // stage 1, live model M1
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // consume replay
    const replaysBefore = replays(calls).length;
    const abortsBefore = aborts(calls).length;

    const s = esc.control(SID, 'reset', NOW);
    expect(s.stage).toBe(0); // status reports the intended stage-0 model
    await flush(); // the reset-and-rebind is async/serialized

    // reset actually re-dispatched the task onto models[0] (abort → replay(M0)).
    expect(aborts(calls).length).toBe(abortsBefore + 1);
    const newReplays = replays(calls).slice(replaysBefore);
    expect(newReplays.some((r) => r.model === M0)).toBe(true);
  });

  it('finding 5 — a test result from a superseded model is dropped, not counted', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // stage 1 (model M1)
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW }); // consume replay
    expect(status(esc).repeats).toBe(0);

    // A late result observably produced by the OLD cheap model must not
    // establish failure state at the new stage.
    await esc.onTestResult({
      sessionID: SID,
      command: CMD,
      output: FAIL_A,
      exitCode: 1,
      model: M0, // superseded
      now: NOW,
    });

    const s = status(esc);
    expect(s.stage).toBe(1);
    expect(s.repeats).toBe(0); // the stale result did not count
  });

  it('finding 9 — a cheap-first rebind whose replay fails stops and notifies', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        abort: (sessionID) => {
          calls.push({ type: 'abort', sessionID });
        },
        replay: () => {
          throw new Error('sdk unavailable');
        },
      },
    });

    // A genuine new task on a stronger model triggers a rebind; its replay fails.
    await esc.onChatMessage({ sessionID: SID, taskId: 't1', model: M2, now: NOW });

    const s = status(esc);
    expect(s.terminated).toBe(true); // not left silently non-terminal
    expect(
      notifies(calls).some(
        (n) => n.message === 'Escalation dispatch failed — automation stopped',
      ),
    ).toBe(true);
  });

  it('finding 10 — strongly-validated Category-A test output routes into recovery', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    // Infra phrase WITH provider/HTTP context in shell output: routed to the
    // bounded recovery owner (a retry), capability state untouched.
    await esc.onTestResult({
      sessionID: SID,
      command: CMD,
      output: 'HTTP 503 service unavailable',
      exitCode: 1,
      now: NOW,
    });

    expect(retries(calls)).toHaveLength(1); // recovery ran (old code only logged)
    const s = status(esc);
    expect(s.stage).toBe(0);
    expect(s.repeats).toBe(0); // capability accounting untouched (AC-5)
  });

  it('finding 10 — an infra phrase WITHOUT context stays capability (counts normally)', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    // No HTTP/provider framing ⇒ ordinary capability failure; it must count.
    const out = 'FAILED test_x\nassert result == "rate limit exceeded"';
    await esc.onTestResult({ sessionID: SID, command: CMD, output: out, exitCode: 1, now: NOW });

    expect(retries(calls)).toHaveLength(0);
    expect(status(esc).repeats).toBe(1); // counted as a capability failure
  });

  it('finding 14 — a new task while disabled clears stale escalated state', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc); // stage 1
    esc.control(SID, 'disable', NOW);

    // A genuine new task arrives while disabled: no dispatch, but the stale
    // escalated stage/terminal/pending state must be cleared.
    await esc.onChatMessage({ sessionID: SID, taskId: 't2', model: M0, now: NOW });

    esc.control(SID, 'enable', NOW);
    expect(status(esc).stage).toBe(0); // re-enabling resumes from a fresh baseline
  });

  it('finding 7 — oversized test output degrades: it is never counted or escalated', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    // Two failing outputs that share a prefix but differ only PAST the analysis
    // bound would hash equal if fingerprinted; the degrade path refuses to count
    // them at all, so no false repeat is manufactured (finding 7, P2).
    const HUGE_A = 'FAILED test_x\n' + 'a'.repeat(300 * 1024);
    const HUGE_B = 'FAILED test_x\n' + 'a'.repeat(300 * 1024) + '\nFAILED test_late_b';

    await fail(esc, HUGE_A);
    edit(esc);
    await fail(esc, HUGE_B);

    const s = status(esc);
    expect(s.stage).toBe(0); // never escalated on truncated evidence
    expect(s.repeats).toBe(0); // the oversized failures were not counted
    expect(aborts(calls)).toHaveLength(0);
    expect(replays(calls)).toHaveLength(0);
    expect(
      calls.some(
        (c) =>
          c.type === 'log' &&
          c.entry.level === 'warn' &&
          c.entry.message.includes('oversized'),
      ),
    ).toBe(true);
  });

  it('finding 15 — status reports per-stage thresholds and the fingerprint config', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    const s = status(esc);
    expect(Array.isArray(s.config.model_thresholds)).toBe(true);
    expect(s.config.model_thresholds).toHaveLength(s.config.models.length);
    expect(s.config.fingerprint).toBeDefined();
    expect(typeof s.config.fingerprint.strip_ansi).toBe('boolean');
    expect(
      (s.config.fingerprint as { project_root?: string }).project_root,
    ).toBeUndefined();
  });
});

describe('2026-08-26 review — orchestrator patches', () => {
  it('P4 — disable during in-flight escalate prevents the replay', async () => {
    const { calls, effects } = makeEffects();
    let esc: Escalator;
    esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        abort: async (sessionID) => {
          calls.push({ type: 'abort', sessionID });
          esc.control(SID, 'disable', NOW);
        },
      },
    });

    await escalateOnce(esc);

    expect(replays(calls)).toHaveLength(0);
    expect(status(esc).enabled).toBe(false);
  });

  it('P3 — a test result stamped with a superseded generation is dropped', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc);
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW });
    expect(status(esc).repeats).toBe(0);
    const live = esc.resultsGeneration(SID);
    expect(live).toBeGreaterThan(0);

    await esc.onTestResult({
      sessionID: SID,
      command: CMD,
      output: FAIL_A,
      exitCode: 1,
      generation: 0,
      now: NOW,
    });
    expect(status(esc).repeats).toBe(0);
    expect(status(esc).stage).toBe(1);
  });

  it('P7 — reset-rebind does not swallow the next user message that omits model', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onChatMessage({ sessionID: SID, taskId: 'orig', model: M0, now: NOW });
    await escalateOnce(esc);
    await esc.onChatMessage({ sessionID: SID, taskId: 'orig', model: M1, now: NOW });
    esc.control(SID, 'reset', NOW);
    await flush();

    const abortsBefore = aborts(calls).length;
    await esc.onChatMessage({ sessionID: SID, taskId: 't-new', now: NOW });
    expect(status(esc).stage).toBe(0);
    expect(aborts(calls).length).toBe(abortsBefore);
  });

  it('P8 — new task after escalation with omitted model rebinds to models[0]', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc);
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW });
    const abortsBefore = aborts(calls).length;
    const replaysBefore = replays(calls).length;

    await esc.onChatMessage({ sessionID: SID, taskId: 't-new', now: NOW });

    expect(status(esc).stage).toBe(0);
    expect(aborts(calls).length).toBe(abortsBefore + 1);
    expect(replays(calls).slice(replaysBefore).some((r) => r.model === M0)).toBe(
      true,
    );
  });

  it('P11 — oversized tool output does not Category-A retry', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    const huge = 'HTTP 429 Too Many Requests\n' + 'x'.repeat(300 * 1024);
    await fail(esc, huge);

    expect(retries(calls)).toHaveLength(0);
    expect(status(esc).repeats).toBe(0);
    expect(status(esc).terminated).toBe(false);
  });

  it('P15 — an edit during in-flight recovery does not arm the new stage', async () => {
    const { effects } = makeEffects();
    let esc: Escalator;
    esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        replay: async (sessionID, model) => {
          effects.replay(sessionID, model);
          esc.onFileEdited({ sessionID: SID, now: NOW });
        },
      },
    });

    await escalateOnce(esc);
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW });
    await fail(esc, FAIL_B);
    expect(status(esc).repeats).toBe(1);
    await fail(esc, FAIL_B);
    expect(status(esc).repeats).toBe(1);
    expect(status(esc).stage).toBe(1);
  });

  it('P16 — empty sessionID is ignored', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await esc.onTestResult({
      sessionID: '',
      command: CMD,
      output: FAIL_A,
      exitCode: 1,
      now: NOW,
    });
    esc.onFileEdited({ sessionID: '', now: NOW });
    await esc.onChatMessage({ sessionID: '', taskId: 't', now: NOW });
    await esc.onSessionError({ sessionID: '', status: 429, now: NOW });

    expect(status(esc).repeats).toBe(0);
    expect(retries(calls)).toHaveLength(0);
  });

  it('P19 — redactCommand masks space-separated credential flags', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { debug: true }),
      effects,
    });

    await esc.onTestResult({
      sessionID: SID,
      command: 'curl --token SECRETVALUE',
      output: FAIL_A,
      exitCode: 1,
      now: NOW,
    });
    const debug = calls.find(
      (c) => c.type === 'log' && c.entry.level === 'debug',
    );
    expect(debug).toBeDefined();
    const cmd = (debug as Extract<Call, { type: 'log' }>).entry.data?.command;
    expect(String(cmd)).not.toContain('SECRETVALUE');
    expect(String(cmd)).toContain('<redacted>');
  });

  it('T1 — redactCommand masks inline KEY=secret, Authorization headers, and long opaque tokens', async () => {
    // Only the "not a recognized test command" branch logs a (redacted) command,
    // so a non-test command exercises redactCommand end-to-end.
    const grab = async (command: string): Promise<string> => {
      const { calls, effects } = makeEffects();
      const esc = createEscalator({
        config: makeConfig(undefined, { debug: true }),
        effects,
      });
      await esc.onTestResult({ sessionID: SID, command, output: '', exitCode: 1, now: NOW });
      const entry = calls.find(
        (c): c is Extract<Call, { type: 'log' }> =>
          c.type === 'log' &&
          c.entry.message === 'command is not a recognized test command; ignoring',
      );
      expect(entry).toBeDefined();
      return String(entry!.entry.data?.command);
    };

    // Inline KEY=secret — short value isolates the key/value rule from the
    // long-opaque-token rule.
    const a = await grab('curl API_KEY=hunter2');
    expect(a).not.toContain('hunter2');
    expect(a).toContain('<redacted>');

    // Authorization header.
    const b = await grab('curl -H authorization: sekret');
    expect(b).not.toContain('sekret');
    expect(b).toContain('<redacted>');

    // Bare >= 20-char opaque token with no credential key context.
    const c = await grab('curl https://x/ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(c).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(c).toContain('<redacted>');
  });

  it('T1 — redactCommand hard-truncates an overlong command with an ellipsis', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { debug: true }),
      effects,
    });
    // Many short non-credential tokens: nothing individually redacts, so the
    // masked string stays long enough to hit REDACT_MAX (120) truncation.
    const long = 'echo ' + Array(60).fill('abcd').join(' ');
    await esc.onTestResult({ sessionID: SID, command: long, output: '', exitCode: 1, now: NOW });
    const entry = calls.find(
      (c): c is Extract<Call, { type: 'log' }> =>
        c.type === 'log' &&
        c.entry.message === 'command is not a recognized test command; ignoring',
    );
    const cmd = String(entry!.entry.data?.command);
    expect(cmd.endsWith('…')).toBe(true);
    expect(cmd.length).toBeLessThanOrEqual(121); // 120 chars + the ellipsis
  });

  it('P21/NFR-6 — debug log of a counted failure carries command/fingerprint/category/repeats', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { debug: true }),
      effects,
    });

    await fail(esc);
    const counted = calls.find(
      (c) =>
        c.type === 'log' &&
        c.entry.level === 'debug' &&
        c.entry.message.includes('category-B'),
    );
    expect(counted).toBeDefined();
    const data = (counted as Extract<Call, { type: 'log' }>).entry.data;
    expect(data).toMatchObject({ repeats: 1, stage: 0 });
    expect(typeof data?.fingerprint).toBe('string');
  });

  it('NFR-7 — escalating session A does not move session B', async () => {
    const { effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });
    const B = 'sess-b';

    await escalateOnce(esc);
    await esc.onTestResult({
      sessionID: B,
      command: CMD,
      output: FAIL_A,
      exitCode: 1,
      now: NOW,
    });

    expect(status(esc).stage).toBe(1);
    expect(esc.control(B, 'status', NOW).stage).toBe(0);
    expect(esc.control(B, 'status', NOW).activeModel).toBe(M0);
  });

  it('D1 — a child sessionID does not advance the parent Category-B counter', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });
    const CHILD = 'ses_child';

    await escalateOnce(esc);
    const parentAborts = aborts(calls).filter((a) => a.sessionID === SID).length;
    const parentReplays = replays(calls).filter((r) => r.sessionID === SID).length;

    await esc.onTestResult({
      sessionID: CHILD,
      command: CMD,
      output: FAIL_A,
      exitCode: 1,
      now: NOW,
    });
    esc.onFileEdited({ sessionID: CHILD, now: NOW });
    await esc.onTestResult({
      sessionID: CHILD,
      command: CMD,
      output: FAIL_A,
      exitCode: 1,
      now: NOW,
    });

    expect(status(esc).stage).toBe(1);
    expect(esc.control(CHILD, 'status', NOW).stage).toBe(1);
    expect(aborts(calls).filter((a) => a.sessionID === SID)).toHaveLength(parentAborts);
    expect(replays(calls).filter((r) => r.sessionID === SID)).toHaveLength(parentReplays);
    expect(aborts(calls).some((a) => a.sessionID === CHILD)).toBe(true);
    expect(
      replays(calls).some((r) => r.sessionID === CHILD && r.model === M1),
    ).toBe(true);
  });

  it('P28 — require_code_change_between_failures=false counts identical fails without an edit', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, {
        require_code_change_between_failures: false,
      }),
      effects,
    });

    await fail(esc);
    await fail(esc);

    expect(aborts(calls)).toHaveLength(1);
    expect(replays(calls)[0]!.model).toBe(M1);
  });

  it('P34 — a reset during Category-A backoff cancels the delayed retry', async () => {
    const { calls, effects } = makeEffects();
    let releaseRetry!: () => void;
    const gate = new Promise<void>((r) => {
      releaseRetry = r;
    });
    const esc = createEscalator({
      config: makeConfig(),
      effects: {
        ...effects,
        retry: async (sessionID, model, delayMs, ctx) => {
          calls.push({ type: 'retry', sessionID, model, delayMs });
          await gate;
          if (!ctx.isCurrent()) return;
          calls.push({ type: 'replay', sessionID, model });
        },
      },
    });

    const pending = esc.onSessionError({
      sessionID: SID,
      status: 429,
      now: NOW,
    });
    await flush();
    esc.control(SID, 'reset', NOW);
    releaseRetry();
    await pending;
    await flush();

    expect(replays(calls)).toHaveLength(0);
  });

  it('P35 — config.enabled=false makes escalateOnce inert', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { enabled: false }),
      effects,
    });

    await escalateOnce(esc);
    expect(aborts(calls)).toHaveLength(0);
    expect(status(esc).enabled).toBe(false);
    expect(status(esc).stage).toBe(0);
  });

  it('P35 — disable then reset restores config.enabled and rebinds', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({ config: makeConfig(), effects });

    await escalateOnce(esc);
    await esc.onChatMessage({ sessionID: SID, model: M1, now: NOW });
    esc.control(SID, 'disable', NOW);
    const after = esc.control(SID, 'reset', NOW);
    expect(after.enabled).toBe(true);
    expect(after.stage).toBe(0);
    await flush();
    expect(replays(calls).some((r) => r.model === M0)).toBe(true);
  });

  it('max_infra_retries=0 latches infraStopped and a further 429 is inert', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { max_infra_retries: 0 }),
      effects,
    });

    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    // D1: no-retry-configured latches the Category-A flag, leaving the session
    // non-terminal so capability escalation can still fire.
    expect(status(esc).infraStopped).toBe(true);
    expect(status(esc).terminated).toBe(false);
    const abortsAfter = aborts(calls).length;
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    expect(aborts(calls)).toHaveLength(abortsAfter);
    expect(retries(calls)).toHaveLength(0);
  });

  it('D1 — Category-B escalation still fires after an infra give-up (infraStopped)', async () => {
    const { calls, effects } = makeEffects();
    const esc = createEscalator({
      config: makeConfig(undefined, { max_infra_retries: 0 }),
      effects,
    });

    // Infra failure concedes: infraStopped latched, terminated stays false.
    await esc.onSessionError({ sessionID: SID, status: 429, now: NOW });
    expect(status(esc).infraStopped).toBe(true);
    expect(status(esc).terminated).toBe(false);

    // A genuine capability repair cycle must still drive escalation off models[0].
    await escalateOnce(esc);
    await flush();
    expect(status(esc).stage).toBeGreaterThan(0);
    expect(replays(calls).some((r) => r.model === M1)).toBe(true);
  });
});
