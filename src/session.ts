/**
 * The escalation orchestrator — the single owner of recovery
 * (TECHNICAL_SPECIFICATION.md §2, §3.4, §4, §5.2, §6; FR-16).
 *
 * A pure, injectable per-session state machine that consumes the deterministic
 * detection core and turns its signals into recovery *decisions*, emitting them
 * as effects (abort / replay / notify / log) through an injected interface.
 * Because every side effect is injected, the whole machine is unit-testable
 * against the session-level ACs with a fake recorder — extending the core's
 * "pure, testable" philosophy to orchestration.
 *
 * There is NO `@opencode-ai/plugin` or SDK import here. The OpenCode adapter
 * (deferred, see `deferred-work.md`) supplies the real hooks and SDK-backed
 * effects; this module is the brain it drives.
 *
 * Determinism (NFR-1): no wall-clock, random, or network is read in the
 * counting/classification path. The only time input is the caller-supplied
 * `now`, used solely to stamp activity for idle GC (NFR-4).
 */

import { MAX_TIMER_MS, thresholdForStage } from './config.js';
import {
  classifyFailure,
  failureFingerprint,
  isOversizedOutput,
  looksLikeTestCommand,
} from './detection.js';
import {
  clearFailureState,
  initialState,
  markCodeChanged,
  recordFailure,
} from './counter.js';
import type { EscalatorConfig, StuckState } from './types.js';

/**
 * Per-session runtime state: the pure `StuckState` the core reads/writes, plus
 * the runtime-only fields this orchestrator owns (§2.3 + §5.2/§6).
 */
/**
 * Identity of an in-flight self-triggered replay/rebind/retry (2026-08-25
 * findings 1 & 2). The next `onChatMessage` that IS this dispatch must be
 * recognized as the plugin's own replay, not a genuine new user task. Identity
 * is bound to BOTH the expected task id (the original user message id the SDK
 * replays under) AND the dispatched model, plus a monotonic `token` so a newer
 * dispatch (or a reset/new-task that clears it) cancels any older delayed one.
 */
export type PendingReplay = {
  /** The model the self-dispatch runs under. */
  model: string;
  /** The task id the replay carries (original user message id), when known. */
  taskId?: string;
  /**
   * Monotonic dispatch token. A delayed Category-A retry captures this and is
   * cancelled if the session's current `pendingReplay.token` no longer matches
   * (superseded by a newer dispatch, or cleared by reset/new-task/consume).
   */
  token: number;
};

export type RuntimeState = StuckState & {
  /** Recovery-in-flight guard: an escalation/rebind is dispatching (FR-14, AC-11). */
  escalationInFlight: boolean;
  /**
   * Identity of an in-flight self-triggered replay/rebind/retry, or `undefined`
   * when none is pending. Bound to task id + model + token so a genuine new task
   * under the pending model (finding 2) is NOT consumed as the replay, and a
   * delayed retry is cancelled when superseded (finding 1). Replaces the old
   * model-only `pendingModel`.
   */
  pendingReplay?: PendingReplay;
  /** The last observed user-task id, for provenance and replay identity binding. */
  currentTaskId?: string;
  /** Per-session on/off, toggled via `control` (§5 control tool). */
  enabled: boolean;
  /** Caller-supplied timestamp of last activity, for idle GC (NFR-4). */
  lastActivityMs: number;
  /**
   * Terminal latch (finding 6): once the chain terminally stops (top of chain,
   * or a dispatch failure that couldn't recover), no further AUTOMATIC recovery
   * runs until an explicit new task or `reset`. Prevents repeated terminal
   * aborts/notifications from later identical failures.
   */
  terminated: boolean;
  /**
   * Category-A infrastructure stop latch (D1). Set when infra recovery gives up
   * (provider_failover off, a zero budget, or retries exhausted). Halts further
   * Category-A retries WITHOUT the global `terminated` latch, so capability
   * (Category-B) escalation stays live after an infra stop — the two categories
   * are never conflated (FR-9). Cleared by a passing test ("infra recovered"),
   * a genuine new task, or `reset`. A hard failure that couldn't stop the run
   * (an abort that threw during an infra retry) still sets `terminated`, not
   * this — that is a genuine safety terminal.
   */
  infraStopped: boolean;
  /**
   * Monotonic serialization token (finding 8). Bumped on every reset/enable/
   * disable/new-task. An in-flight async dispatch captures it and bails if it
   * changes mid-flight, so a racing reset/disable can't complete-and-notify
   * under stale control state.
   */
  generation: number;
  /** Consecutive Category-A (infrastructure) retries already dispatched (FR-9). */
  categoryARetries: number;
  /**
   * Epoch of the currently live generation. Bumped whenever a generation is
   * aborted (escalation, rebind, Category-A retry, new task). `onTestResult`
   * drops a result whose stamped epoch no longer matches — the SDK's
   * `tool.execute.after` has no `model` field, so this is the production
   * stale-result guard (FR-6).
   */
  resultsGeneration: number;
  /**
   * Tail of the per-session recovery mutex (2026-08-25 findings 1 & 9). Recovery
   * dispatches (escalation, cheap-first rebind, reset-rebind) serialize on this
   * so a concurrent second task can no longer skip its own rebind and strand the
   * newest task on a stronger model.
   */
  lockTail: Promise<void>;
};

/** A structured log line handed to the injected logger. */
export type LogEntry = {
  level: 'debug' | 'info' | 'warn';
  message: string;
  sessionID?: string;
  data?: Record<string, unknown>;
};

/**
 * The recovery effects the orchestrator emits. The adapter backs these with the
 * OpenCode SDK; tests back them with a recorder. All may be async.
 */
export type EscalatorEffects = {
  /** Stop the session's in-flight generation (§5). MUST throw on SDK failure. */
  abort(sessionID: string): Promise<void> | void;
  /** Replay the last user turn into the SAME session under `model` (FR-5, §5). */
  replay(sessionID: string, model: string): Promise<void> | void;
  /**
   * Bounded Category-A (infrastructure) recovery: re-dispatch the last user turn
   * into the SAME session under the SAME `model` after `delayMs` of backoff
   * (FR-9, finding 2). The delay is applied here (the side-effect layer), never
   * in the deterministic decision path (NFR-1).
   *
   * `ctx.isCurrent()` MUST be consulted AFTER the delay and BEFORE the actual
   * re-dispatch: it returns `false` when this retry has been superseded or
   * cancelled (a newer dispatch, a reset, a new task, disable, or terminal
   * stop), so the adapter drops a stale delayed retry instead of replaying an
   * obsolete turn under the wrong model (2026-08-25 finding 1).
   */
  retry(
    sessionID: string,
    model: string,
    delayMs: number,
    ctx: { generation: number; isCurrent: () => boolean },
  ): Promise<void> | void;
  /** Surface a user-visible message (toast / notification). */
  notify(message: string): Promise<void> | void;
  /** Emit a structured diagnostic line. */
  log(entry: LogEntry): Promise<void> | void;
};

/** Input to `onTestResult` — a completed shell/test-tool invocation. */
export type TestResultInput = {
  sessionID: string;
  /** The command that ran; gated against `test_commands` (FR-11, FR-15). */
  command: string;
  /** Combined stdout+stderr text of the run. */
  output: string;
  /** Process exit code when known; `0` = pass. Absent ⇒ unknown. */
  exitCode?: number;
  /**
   * The `provider/model` the run executed under, when observable. Used to reject
   * a stale result produced by a superseded (pre-escalation) model so it cannot
   * establish or increment failure state at the new stage (2026-08-25 finding 5).
   */
  model?: string;
  /**
   * Generation epoch captured when the tool call *started* (adapter stamps this
   * from `tool.execute.before`). Dropped when it does not match the session's
   * live `resultsGeneration` — a late result from an aborted generation must
   * not count at the already-advanced stage.
   */
  generation?: number;
  /** Caller-supplied activity timestamp (idle GC only, NFR-1/NFR-4). */
  now?: number;
};

/** Input to `onFileEdited` — a `file.edited` event (FR-3). */
export type FileEditedInput = {
  sessionID: string;
  now?: number;
};

/** Input to `onChatMessage` — a user chat message / task boundary (§6). */
export type ChatMessageInput = {
  sessionID: string;
  /** Opaque id for the user task, stamped onto `currentTaskId` on reset. */
  taskId?: string;
  /**
   * The `provider/model` this message is running under, when observable. Used to
   * (a) recognize the plugin's own self-replay by its dispatched model
   * (finding 8) and (b) enforce cheap-first by rebinding to `models[0]` when a
   * genuine new task arrives on a stronger model (finding 1, FR-1).
   */
  model?: string;
  now?: number;
};

/** Input to `onSessionError` — a model-API/session error (Category A, §4). */
export type SessionErrorInput = {
  sessionID: string;
  /** HTTP-ish status code when present (e.g. 429). */
  status?: number;
  /** Error text, scanned for infra phrases/codes. */
  message?: string;
  now?: number;
};

/** Control-tool actions (§5 control tool). */
export type ControlAction = 'enable' | 'disable' | 'status' | 'reset';

/** The status snapshot returned by every `control` call (AC-13). */
export type ControlStatus = {
  sessionID: string;
  enabled: boolean;
  stage: number;
  /**
   * The model the orchestrator INTENDS to be active for this stage. It reflects
   * internal stage, not a live query of OpenCode; after a reset or a cheap-first
   * rebind the orchestrator actively re-dispatches so the live model converges
   * on this value (2026-08-25 findings 3 & 15). `undefined` only if the stage
   * index has no model (never, for a validated chain).
   */
  activeModel: string | undefined;
  repeats: number;
  /** Fingerprint of the tracked failure, truncated for display. */
  previousFailure?: string;
  escalationInFlight: boolean;
  /** The pending self-replay model, when one is in flight. */
  pendingModel?: string;
  /** `true` once the chain has terminally stopped for this session (finding 6). */
  terminated: boolean;
  /** `true` while Category-A infra recovery has given up for this session (D1). */
  infraStopped: boolean;
  /** The full effective configuration for this session (AC-13, findings 14 & 15). */
  config: {
    models: string[];
    same_failure_threshold: number;
    /** Effective per-stage escalation threshold, one entry per model (finding 15). */
    model_thresholds: number[];
    require_code_change_between_failures: boolean;
    stop_at_max_model: boolean;
    reset_on_new_user_task: boolean;
    notify_on_escalation: boolean;
    provider_failover: boolean;
    retry_on_errors: number[];
    retry_on_patterns: string[];
    max_infra_retries: number;
    infra_retry_cooldown_ms: number;
    test_commands: string[];
    shell_tool_name: string;
    mutating_tools: string[];
    idle_cleanup_ms: number;
    notify: boolean;
    debug: boolean;
    /** The complete effective fingerprint settings (finding 15). */
    fingerprint: {
      normalize_durations: boolean;
      normalize_line_numbers: boolean;
      normalize_temp_paths: boolean;
      normalize_addresses: boolean;
      strip_ansi: boolean;
      failure_markers: string[];
    };
  };
};

/** The orchestrator's public surface — the hooks the adapter wires. */
export type Escalator = {
  onTestResult(input: TestResultInput): Promise<void>;
  onFileEdited(input: FileEditedInput): void;
  onChatMessage(input: ChatMessageInput): Promise<void>;
  onSessionError(input: SessionErrorInput): Promise<void>;
  control(sessionID: string, action: ControlAction, now?: number): ControlStatus;
  gc(now: number): void;
  /** Refresh idle-GC activity for `sessionID` without otherwise mutating state. */
  touch(sessionID: string, now?: number): void;
  /** Live results-generation epoch for `sessionID` (0 if the session is unknown). */
  resultsGeneration(sessionID: string): number;
};

const TERMINAL_STOP_MESSAGE = 'Max escalation reached — automation stopped';
const DISPATCH_FAILED_MESSAGE =
  'Escalation dispatch failed — automation stopped';
const INFRA_EXHAUSTED_MESSAGE =
  'Infrastructure failure persists — automatic retries stopped';
const FINGERPRINT_DISPLAY_LEN = 12;

/**
 * Redact a shell command before it reaches a log line (finding 20). Never log a
 * raw command: mask the values of credential-shaped flags/env assignments and
 * hard-truncate. Deterministic; used only for observability.
 */
const REDACT_MAX = 120;
function redactCommand(cmd: string): string {
  if (typeof cmd !== 'string') return '';
  const masked = cmd
    // KEY=secret / --token=secret / password: secret → keep the key, drop value.
    .replace(
      /((?:^|\s)(?:[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|BEARER)[A-Za-z0-9_]*)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      '$1<redacted>',
    )
    // Space-separated credential flags: `--token SECRET` / `-p SECRET`.
    .replace(
      /((?:^|\s)(?:--[A-Za-z0-9-]*(?:token|key|secret|password|passwd|pwd|auth|credential|bearer)[A-Za-z0-9-]*|-p|-P)\s+)("[^"]*"|'[^']*'|\S+)/gi,
      '$1<redacted>',
    )
    // Authorization: Bearer xxxxx headers.
    .replace(/(authorization\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
    // Long opaque tokens (>= 20 url-safe chars) anywhere.
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '<redacted>');
  return masked.length > REDACT_MAX ? `${masked.slice(0, REDACT_MAX)}…` : masked;
}

function isSessionID(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Build the escalation orchestrator over `config` with the injected `effects`.
 * Owns a private `Map<sessionID, RuntimeState>` (NFR-7).
 */
export function createEscalator(args: {
  config: EscalatorConfig;
  effects: EscalatorEffects;
}): Escalator {
  const { config, effects } = args;
  const sessions = new Map<string, RuntimeState>();

  /**
   * Monotonic dispatch token source (2026-08-25 findings 1 & 2). Every
   * self-dispatch (escalation replay, cheap-first rebind, reset-rebind, infra
   * retry) claims a fresh token; a delayed retry is cancelled once the session's
   * `pendingReplay.token` moves on.
   */
  let dispatchSeq = 0;

  /** Get (or lazily create) the runtime state for `sessionID`. */
  function ensure(sessionID: string, now?: number): RuntimeState {
    let s = sessions.get(sessionID);
    if (s === undefined) {
      s = {
        ...initialState(),
        escalationInFlight: false,
        enabled: config.enabled,
        lastActivityMs: typeof now === 'number' ? now : 0,
        terminated: false,
        infraStopped: false,
        generation: 0,
        categoryARetries: 0,
        resultsGeneration: 0,
        lockTail: Promise.resolve(),
      };
      sessions.set(sessionID, s);
    } else if (typeof now === 'number') {
      s.lastActivityMs = now;
    }
    return s;
  }

  /**
   * Acquire the per-session recovery mutex (2026-08-25 findings 1 & 9). Returns a
   * `release` function; callers MUST call it in a `finally`. Recovery dispatches
   * serialize so a concurrent second task can no longer skip its rebind while an
   * earlier dispatch holds the flag. Re-entrancy from a dispatched replay's own
   * `chat.message` never reaches here: a self-replay is consumed at the top of
   * `onChatMessage`, and re-entrant escalation no-ops on `escalationInFlight`
   * before acquiring — so the lock cannot deadlock on itself (AC-11).
   */
  async function acquire(state: RuntimeState): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = state.lockTail;
    state.lockTail = prev.then(() => next);
    await prev;
    return release;
  }

  /** Does `pendingReplay` still name the dispatch that owns `token`? */
  function tokenCurrent(state: RuntimeState, token: number): boolean {
    return state.pendingReplay !== undefined && state.pendingReplay.token === token;
  }

  /** Copy the four `StuckState` fields back onto the runtime state in place. */
  function applyStuck(state: RuntimeState, next: StuckState): void {
    state.stage = next.stage;
    state.previousFailure = next.previousFailure;
    state.repeats = next.repeats;
    state.codeChangedSinceFailure = next.codeChangedSinceFailure;
  }

  function log(entry: LogEntry): void {
    if (!config.debug && entry.level === 'debug') return;
    // Fire-and-forget, but never let a rejected log promise surface as an
    // unhandled rejection in the OpenCode host (finding 21).
    void Promise.resolve(effects.log(entry)).catch(() => {});
  }

  /**
   * Drive one escalation for `state`. Guarded against re-entrancy; at the top of
   * the chain it terminates (abort + terminal notify) instead of looping the top
   * model (FR-8, AC-7, AC-11). Otherwise: mark the pending replay, advance the
   * stage, reset counters, then emit abort → replay → escalation notify.
   */
  async function escalate(
    sessionID: string,
    state: RuntimeState,
  ): Promise<void> {
    if (state.escalationInFlight) {
      log({
        level: 'debug',
        message: 'escalation already in flight; ignoring re-entry',
        sessionID,
      });
      return;
    }
    // Terminal latch: once stopped, never take further automatic action until an
    // explicit new task or reset clears it (finding 6, FR-8).
    if (state.terminated) {
      log({
        level: 'debug',
        message: 'session terminally stopped; ignoring escalation trigger',
        sessionID,
      });
      return;
    }

    // Claim the recovery flag BEFORE any await so a re-entrant escalation (from
    // the dispatched replay's own activity) no-ops, and serialize the dispatch
    // itself on the per-session mutex so a concurrent new-task rebind waits
    // rather than racing this abort/replay (findings 1 & 9, FR-14, AC-11).
    state.escalationInFlight = true;
    const release = await acquire(state);
    try {
      // Control/new-task may have flipped these while we waited for the lock.
      if (state.terminated || !state.enabled) return;

      const atTop = state.stage >= config.models.length - 1;
      if (atTop) {
        // Terminal stop at the top of the chain. The abort is UNCONDITIONAL:
        // bounded spend is a hard invariant, so the strongest model's in-flight
        // run is ALWAYS stopped — the canonical decisions table
        // ("strongest model stuck → abort + notify, do not loop") wins over any
        // toggle (2026-08-25 finding 4, FR-8, AC-7).
        //
        // `stop_at_max_model` (default true, recommended) now governs only the
        // LATCH: whether the session stays stopped and inert after the abort. It
        // can no longer request the old, forbidden "let the top model keep
        // looping" behavior — that violated bounded spend. With `false`, the
        // runaway run is still aborted + the user notified, but the session is
        // not latched, so a later genuinely-stuck cycle is aborted again rather
        // than the automation shutting down. It never loops the model unattended
        // either way. Latch BEFORE the awaited abort so no concurrent trigger
        // re-enters while we latch (finding 6).
        if (config.stop_at_max_model) state.terminated = true;
        state.resultsGeneration += 1;
        try {
          await effects.abort(sessionID);
        } catch (err) {
          // The terminal notification and latch MUST still happen even if the
          // abort call fails (finding 7).
          log({
            level: 'warn',
            message: 'terminal abort failed; still latching and notifying',
            sessionID,
            data: { error: String(err) },
          });
        }
        if (config.notify_on_escalation) {
          await effects.notify(TERMINAL_STOP_MESSAGE);
        }
        log({
          level: 'info',
          message: TERMINAL_STOP_MESSAGE,
          sessionID,
          data: { stage: state.stage, latched: config.stop_at_max_model },
        });
        return;
      }

      const prevStage = state.stage;
      const nextStage = state.stage + 1;
      const nextModel = config.models[nextStage]!.model;
      const capturedGen = state.generation;

      // Mark the pending self-replay BEFORE dispatching it, so the resulting
      // chat message is recognized as the replay and not a new user task. Bind
      // it to the current task id + model + a fresh token (findings 1 & 2).
      const token = ++dispatchSeq;
      state.pendingReplay = {
        model: nextModel,
        taskId: state.currentTaskId,
        token,
      };
      // Advance capability and reset the per-stage counters (monotonic: stage
      // only rises; clearFailureState here preserves the just-raised stage).
      applyStuck(state, clearFailureState({ ...state, stage: nextStage }));
      // Aborting the current generation invalidates in-flight tool results.
      state.resultsGeneration += 1;

      try {
        await effects.abort(sessionID);
        // A reset/disable/new-task that raced this dispatch supersedes it
        // (findings 1, 8): our token no longer owns the pending replay → bail
        // without notifying under stale state. Also bail if disable/reset
        // flipped enabled/terminated/generation while abort ran (P4).
        if (
          !state.enabled ||
          state.terminated ||
          state.generation !== capturedGen ||
          !tokenCurrent(state, token)
        ) {
          return;
        }
        await effects.replay(sessionID, nextModel);
        if (
          !state.enabled ||
          state.terminated ||
          state.generation !== capturedGen ||
          !tokenCurrent(state, token)
        ) {
          return;
        }
      } catch (err) {
        // The stronger model never actually became active. Roll the logical
        // stage back (finding 5) — monotonicity is preserved because the
        // advance never took effect — clear the pending replay, and terminally
        // stop so no further automatic recovery runs under a false stage.
        if (tokenCurrent(state, token)) state.pendingReplay = undefined;
        applyStuck(state, { ...state, stage: prevStage });
        state.terminated = true;
        log({
          level: 'warn',
          message: 'escalation dispatch failed; rolled back stage and stopped',
          sessionID,
          data: { fromStage: prevStage, model: nextModel, error: String(err) },
        });
        if (config.notify_on_escalation) {
          await effects.notify(DISPATCH_FAILED_MESSAGE);
        }
        return;
      }
      if (config.notify_on_escalation) {
        await effects.notify(`Escalated to ${nextModel}`);
      }
      log({
        level: 'info',
        message: 'escalated',
        sessionID,
        data: { stage: nextStage, model: nextModel },
      });
    } finally {
      state.escalationInFlight = false;
      release();
    }
  }

  /**
   * The single bounded Category-A (infrastructure) recovery owner, shared by the
   * structured `session.error` path AND strongly-validated tool-output infra
   * failures (2026-08-25 finding 10, FR-9). NEVER touches capability state
   * (stage/repeats/fingerprint) — AC-5. Bounds retries by `max_infra_retries`
   * with exponential backoff, identity-binds the retry replay, and cancels a
   * superseded delayed retry via its token (finding 1).
   */
  async function latchInfraStop(
    sessionID: string,
    state: RuntimeState,
    info: { statusLabel: string; model: string; reason: string },
  ): Promise<void> {
    // Latch the Category-A path so the next 429 cannot start a new retry wave
    // (FR-9, G5). This is the infra-only latch (D1): it halts further infra
    // retries but leaves capability (Category-B) escalation live — a later
    // genuinely-stuck cycle can still escalate the model. Do not zero
    // `categoryARetries` — a new task / reset is what clears the budget.
    state.infraStopped = true;
    state.resultsGeneration += 1;
    try {
      await effects.abort(sessionID);
    } catch (err) {
      log({
        level: 'warn',
        message: 'infrastructure abort failed; still latching and notifying',
        sessionID,
        data: { error: String(err) },
      });
    }
    await effects.notify(INFRA_EXHAUSTED_MESSAGE);
    log({
      level: 'warn',
      message: info.reason,
      sessionID,
      data: { source: info.statusLabel, model: info.model },
    });
  }

  async function handleCategoryA(
    sessionID: string,
    state: RuntimeState,
    info: { statusLabel: string },
  ): Promise<void> {
    // Serialize against an in-flight escalation/rebind/retry: do not dispatch
    // an infra retry while a recovery dispatch is mid-flight (finding 1, FR-14).
    if (state.escalationInFlight) {
      log({
        level: 'debug',
        message: 'recovery already in flight; skipping infra retry',
        sessionID,
      });
      return;
    }
    // Stop on either latch: the global terminal stop, or a prior infra give-up
    // (D1) — no new infra retry wave once infra recovery has already conceded.
    if (state.terminated || state.infraStopped) return;

    const model = config.models[state.stage]!.model;

    // When infra retry is disabled or the budget is exhausted, latch + abort +
    // notify rather than silently no-op'ing or starting a new wave (P1).
    // Capability state stays untouched (AC-5).
    if (!config.provider_failover || config.max_infra_retries <= 0) {
      await latchInfraStop(sessionID, state, {
        statusLabel: info.statusLabel,
        model,
        reason: 'infrastructure failure; no automatic retry configured',
      });
      return;
    }
    if (state.categoryARetries >= config.max_infra_retries) {
      await latchInfraStop(sessionID, state, {
        statusLabel: info.statusLabel,
        model,
        reason: 'infrastructure retries exhausted; stopped',
      });
      return;
    }

    // Claim recovery before any await so a concurrent session.error + tool
    // output cannot both pass the inFlight check (P2).
    state.escalationInFlight = true;
    const release = await acquire(state);
    let retryDetached = false;
    try {
      if (state.terminated || state.infraStopped || !state.enabled) return;
      if (state.categoryARetries >= config.max_infra_retries) {
        await latchInfraStop(sessionID, state, {
          statusLabel: info.statusLabel,
          model,
          reason: 'infrastructure retries exhausted; stopped',
        });
        return;
      }

      state.categoryARetries += 1;
      // Bound the backed-off delay to Node's safe timer range so a large cooldown
      // cannot overflow the timer or wrap negative (finding 13).
      const delayMs = Math.min(
        config.infra_retry_cooldown_ms * 2 ** (state.categoryARetries - 1),
        MAX_TIMER_MS,
      );
      // Identity-bind the retry replay and stamp a fresh token so a stale delayed
      // retry is cancelled once superseded (finding 1). The retry re-dispatches
      // the SAME model, so the resulting chat message is the plugin's own replay,
      // not a new user task.
      const token = ++dispatchSeq;
      state.pendingReplay = { model, taskId: state.currentTaskId, token };
      state.resultsGeneration += 1;
      const gen = state.generation;
      const isCurrent = (): boolean => {
        const s = sessions.get(sessionID);
        return (
          s !== undefined &&
          s.enabled &&
          !s.terminated &&
          !s.infraStopped &&
          s.generation === gen &&
          tokenCurrent(s, token)
        );
      };
      log({
        level: 'info',
        message: 'category-A infrastructure retry scheduled',
        sessionID,
        data: { attempt: state.categoryARetries, model, delayMs, source: info.statusLabel },
      });

      try {
        await effects.abort(sessionID);
      } catch (err) {
        if (tokenCurrent(state, token)) state.pendingReplay = undefined;
        state.terminated = true;
        log({
          level: 'warn',
          message: 'infrastructure retry abort failed; stopped',
          sessionID,
          data: { model, error: String(err) },
        });
        await effects.notify(INFRA_EXHAUSTED_MESSAGE);
        return;
      }
      if (
        !state.enabled ||
        state.terminated ||
        state.generation !== gen ||
        !tokenCurrent(state, token)
      ) {
        return;
      }

      // Fire-and-forget the delayed same-model replay so the host hook is not
      // blocked on the backoff timer (NFR-3, P5). Keep inFlight until it
      // settles so a concurrent Category-A event cannot double-dispatch.
      // Wrap in an async IIFE so a synchronously-throwing retry is still
      // caught (Promise.resolve(fn()) evaluates fn() first).
      retryDetached = true;
      void (async () => {
        try {
          await effects.retry(sessionID, model, delayMs, {
            generation: gen,
            isCurrent,
          });
        } catch (err) {
          if (tokenCurrent(state, token)) state.pendingReplay = undefined;
          state.terminated = true;
          log({
            level: 'warn',
            message: 'infrastructure retry dispatch failed; stopped',
            sessionID,
            data: { model, error: String(err) },
          });
          await effects.notify(INFRA_EXHAUSTED_MESSAGE);
        } finally {
          state.escalationInFlight = false;
        }
      })();
    } finally {
      if (!retryDetached) state.escalationInFlight = false;
      release();
    }
  }

  /**
   * Serialized cheap-first rebind (2026-08-25 findings 1 & 9): re-dispatch the
   * current task onto `models[0]` via abort→replay under the recovery mutex, so
   * a concurrent second task cannot skip its rebind and strand the newest task
   * on a stronger model. On dispatch failure the session is stopped explicitly
   * (abort may have already halted the task) and the user is notified — never
   * left silently non-terminal (finding 9). `expectedTaskId`, when provided,
   * guards against a newer task having superseded this one while we waited.
   */
  async function rebindToCheapest(
    sessionID: string,
    state: RuntimeState,
    expectedTaskId: string | undefined,
  ): Promise<void> {
    const release = await acquire(state);
    try {
      if (state.terminated || !state.enabled) return;
      // A newer task took over while we waited for the lock → let it rebind.
      // `currentTaskId === undefined` (reset cleared it) is not a newer task.
      if (
        expectedTaskId !== undefined &&
        state.currentTaskId !== undefined &&
        state.currentTaskId !== expectedTaskId
      ) {
        return;
      }
      const cheap = config.models[0]!.model;
      state.escalationInFlight = true;
      const token = ++dispatchSeq;
      state.pendingReplay = { model: cheap, taskId: expectedTaskId, token };
      state.resultsGeneration += 1;
      try {
        await effects.abort(sessionID);
        if (!tokenCurrent(state, token)) return;
        await effects.replay(sessionID, cheap);
        if (!tokenCurrent(state, token)) return;
        log({
          level: 'info',
          message: 'enforced cheap-first rebind to models[0]',
          sessionID,
          data: { to: cheap },
        });
      } catch (err) {
        // abort may have already stopped the run and replay failed: the task has
        // no model running. Make the failure explicit and terminal + notify
        // rather than leaving it silently non-terminal (finding 9).
        if (tokenCurrent(state, token)) state.pendingReplay = undefined;
        state.terminated = true;
        log({
          level: 'warn',
          message: 'cheap-first rebind failed; stopped',
          sessionID,
          data: { to: cheap, error: String(err) },
        });
        await effects.notify(DISPATCH_FAILED_MESSAGE);
      } finally {
        state.escalationInFlight = false;
      }
    } finally {
      release();
    }
  }

  async function onTestResult(input: TestResultInput): Promise<void> {
    if (!isSessionID(input.sessionID)) return;
    const state = ensure(input.sessionID, input.now);
    if (!state.enabled) return;
    // Terminal latch: a stopped session takes no further automatic action from
    // later test results until a new task/reset clears it (finding 6, FR-8).
    if (state.terminated) {
      log({
        level: 'debug',
        message: 'session terminally stopped; ignoring test result',
        sessionID: input.sessionID,
      });
      return;
    }

    // Reject a stale result produced during an in-flight recovery dispatch: the
    // stage has already advanced but the stronger model has not run yet, so a
    // late old-generation result must not establish/increment failure state at
    // the new stage (2026-08-25 finding 5, FR-6).
    if (state.escalationInFlight) {
      log({
        level: 'debug',
        message: 'recovery in flight; dropping test result to avoid stale count',
        sessionID: input.sessionID,
      });
      return;
    }
    // Reject a result stamped from a superseded generation (P3). The adapter
    // captures `resultsGeneration` at tool.execute.before; after an abort the
    // live epoch has moved on.
    if (
      input.generation !== undefined &&
      input.generation !== state.resultsGeneration
    ) {
      log({
        level: 'debug',
        message: 'stale test result from a superseded generation; dropping',
        sessionID: input.sessionID,
        data: {
          resultGeneration: input.generation,
          liveGeneration: state.resultsGeneration,
        },
      });
      return;
    }
    // Reject a result observably produced by a superseded model (finding 5).
    const activeModel = config.models[state.stage]?.model;
    if (
      input.model !== undefined &&
      activeModel !== undefined &&
      input.model !== activeModel
    ) {
      log({
        level: 'debug',
        message: 'stale test result from a superseded model; dropping',
        sessionID: input.sessionID,
        data: { resultModel: input.model, activeModel },
      });
      return;
    }

    // Gate: only genuine test commands are fingerprinted/counted (FR-11, FR-15).
    if (!looksLikeTestCommand(input.command, config)) {
      log({
        level: 'debug',
        message: 'command is not a recognized test command; ignoring',
        sessionID: input.sessionID,
        // Never log the raw command — mask credential-shaped tokens (finding 20).
        data: { command: redactCommand(input.command) },
      });
      return;
    }

    // A pass clears the failure counters but never lowers the stage (FR-6, AC-8).
    if (input.exitCode === 0) {
      applyStuck(state, clearFailureState(state));
      // Infra recovered (finding 2): clear the retry budget AND lift the
      // Category-A infra-stop latch (D1), so future infra hiccups may retry again.
      state.categoryARetries = 0;
      state.infraStopped = false;
      log({
        level: 'debug',
        message: 'test passed; cleared failure counters (stage preserved)',
        sessionID: input.sessionID,
        data: { stage: state.stage },
      });
      return;
    }

    const output = input.output ?? '';

    // Oversized output cannot be fingerprinted without risking a false-equal
    // hash across the excised middle: DEGRADE — do not count AND do not
    // Category-A retry from the clamped window (P11). The structured
    // session.error path owns genuine infra signals. The bound is applied here
    // too, so the pre-fingerprint marker scan below never reads an unbounded
    // string.
    if (isOversizedOutput(output)) {
      log({
        level: 'warn',
        message: 'oversized test output; degrading (not counting this failure)',
        sessionID: input.sessionID,
        data: { length: output.length },
      });
      return;
    }

    // Category A (infrastructure) never touches capability state (FR-9, AC-5).
    // Shell/tool output is spoofable, so an infra PHRASE here requires strong
    // provider/HTTP context (2026-08-25 finding 8); the structured session.error
    // path stays authoritative. A strongly-validated infra failure routes into
    // the SAME bounded recovery owner as session errors (finding 10) instead of
    // being silently ignored.
    if (classifyFailure(output, config, { requireHttpContext: true }) === 'A') {
      log({
        level: 'debug',
        message: 'category-A (infrastructure) test output; routing to recovery',
        sessionID: input.sessionID,
      });
      await handleCategoryA(input.sessionID, state, { statusLabel: 'tool-output' });
      return;
    }

    // Category B counting requires a real failure signal: a non-zero exit code,
    // or a recognized failure marker in the output. Absent both ⇒ do nothing —
    // never manufacture escalation from an absent signal (FR-15, AC-15).
    const hasMarker = config.fingerprint.failure_markers.some(
      (m) => m.length > 0 && output.includes(m),
    );
    const isFailure =
      (typeof input.exitCode === 'number' && input.exitCode !== 0) || hasMarker;
    if (!isFailure) {
      log({
        level: 'debug',
        message: 'no usable failure signal (no exit code, no marker); ignoring',
        sessionID: input.sessionID,
      });
      return;
    }

    const fingerprint = failureFingerprint(input.command, output, config);
    const threshold = thresholdForStage(config, state.stage);
    // Honor the resolved repair-cycle gate (finding 11, CFG-3): when
    // require_code_change_between_failures is false, identical failures count
    // without an intervening file edit.
    const result = recordFailure(
      state,
      fingerprint,
      threshold,
      config.require_code_change_between_failures,
    );
    applyStuck(state, result.state);

    log({
      level: 'debug',
      message: 'category-B failure counted',
      sessionID: input.sessionID,
      data: {
        stage: state.stage,
        repeats: state.repeats,
        threshold,
        fingerprint: fingerprint.slice(0, FINGERPRINT_DISPLAY_LEN),
        escalate: result.escalate,
      },
    });

    if (result.escalate) {
      await escalate(input.sessionID, state);
    }
  }

  function onFileEdited(input: FileEditedInput): void {
    if (!isSessionID(input.sessionID)) return;
    const state = ensure(input.sessionID, input.now);
    if (!state.enabled) return;
    if (state.terminated) return;
    // A stale edit from an aborted generation must not arm the already-advanced
    // stage (P15). Test results already drop during in-flight recovery.
    if (state.escalationInFlight) return;
    applyStuck(state, markCodeChanged(state));
    log({
      level: 'debug',
      message: 'code change observed; repair-cycle flag armed',
      sessionID: input.sessionID,
    });
  }

  /** Apply a genuine new-task boundary to `state` (shared by enabled/disabled). */
  function beginNewTask(state: RuntimeState, input: ChatMessageInput): void {
    // Invalidate any in-flight dispatch and cancel a pending self-dispatch/retry
    // (findings 1 & 8): bump generation and clear the pending-replay token so a
    // delayed retry's `isCurrent()` returns false. Clear the terminal latch
    // (finding 6) and infra retry budget (finding 2).
    state.generation += 1;
    state.resultsGeneration += 1;
    state.pendingReplay = undefined;
    state.terminated = false;
    state.infraStopped = false;
    state.categoryARetries = 0;
    if (config.reset_on_new_user_task) {
      applyStuck(state, initialState());
    }
    state.currentTaskId = input.taskId;
  }

  async function onChatMessage(input: ChatMessageInput): Promise<void> {
    if (!isSessionID(input.sessionID)) return;
    const state = ensure(input.sessionID, input.now);

    // While disabled, the orchestrator dispatches nothing — but a genuine new
    // task must still reset the stale stage/counter/terminal/pending state so
    // re-enabling resumes from a clean fresh-task baseline, not the old escalated
    // task (2026-08-25 finding 14). No effects are emitted while disabled.
    if (!state.enabled) {
      beginNewTask(state, input);
      log({
        level: 'debug',
        message: 'new task while disabled; cleared stale task state (no dispatch)',
        sessionID: input.sessionID,
        data: { taskId: input.taskId },
      });
      return;
    }

    // If a self-triggered replay/rebind/retry is pending, THIS message may be
    // that dispatch, not a new user task. Identity-bind it to the expected task
    // id AND model (2026-08-25 finding 2): when both the pending task id and the
    // message task id are observable, they must match; otherwise require a
    // POSITIVE model match. Never treat `model === undefined` as self-replay
    // when task ids cannot be compared (P7) — that swallows the next real user
    // turn (SDK-optional model on chat.message).
    const pending = state.pendingReplay;
    if (pending !== undefined) {
      const idsComparable =
        pending.taskId !== undefined && input.taskId !== undefined;
      const isSelfReplay = idsComparable
        ? input.taskId === pending.taskId
        : input.model !== undefined && input.model === pending.model;
      if (isSelfReplay) {
        log({
          level: 'debug',
          message: 'consumed self-replay chat message; not a new task',
          sessionID: input.sessionID,
          data: { model: pending.model, taskId: pending.taskId },
        });
        state.pendingReplay = undefined;
        return;
      }
      // Overtaken by a genuine, different task: drop the stale marker and fall
      // through to normal new-task handling.
      state.pendingReplay = undefined;
    }

    // Capture escalated-ness BEFORE beginNewTask zeros the stage (P8).
    const wasEscalated = state.stage > 0;
    beginNewTask(state, input);
    log({
      level: 'debug',
      message: 'genuine new user task',
      sessionID: input.sessionID,
      data: { taskId: input.taskId, reset: config.reset_on_new_user_task },
    });

    // Enforce cheap-first (findings 1 & 9, FR-1, P8): a genuine new task must
    // run on models[0]. Rebind when the live model is observably not cheap, OR
    // when the session was escalated and the live model is unknown (SDK-optional
    // `model` on chat.message) — otherwise counters reset to stage 0 while the
    // live session stays on the stronger model.
    const cheap = config.models[0]!.model;
    if (config.reset_on_new_user_task) {
      const needRebind = wasEscalated
        ? input.model === undefined || input.model !== cheap
        : input.model !== undefined && input.model !== cheap;
      if (needRebind) {
        await rebindToCheapest(input.sessionID, state, input.taskId);
      }
    }
  }

  async function onSessionError(input: SessionErrorInput): Promise<void> {
    if (!isSessionID(input.sessionID)) return;
    const state = ensure(input.sessionID, input.now);
    if (!state.enabled) return;
    // Category-A path: bail on the global terminal stop OR a prior infra
    // give-up (D1). Capability escalation (Category-B) is driven by test
    // results, not session errors, so `infraStopped` correctly halts this path.
    if (state.terminated || state.infraStopped) return;

    // The model-API path of Category A (§4): session errors NEVER touch
    // previousFailure/repeats/stage (FR-9, AC-5). Classify to decide recovery.
    // A session error's `status` is a STRUCTURED HTTP status code — genuine HTTP
    // context by construction — so stamp it as `HTTP <code>` before classifying,
    // rather than leaving a bare number that the free-text classifier (rightly)
    // ignores outside an HTTP context (finding 9 interplay).
    const text = `${input.status !== undefined ? `HTTP ${input.status} ` : ''}${
      input.message ?? ''
    }`;
    // The structured session.error path is AUTHORITATIVE for Category A: an HTTP
    // status is genuine context by construction, so this classify runs WITHOUT
    // the shell-output context gate (finding 8).
    const category = classifyFailure(text, config);
    log({
      level: 'debug',
      message: 'session error observed (category-A path; capability untouched)',
      sessionID: input.sessionID,
      data: { status: input.status, category },
    });

    // Only genuine infrastructure errors get the recovery path (FR-9). A
    // Category-B session error is not our concern here (capability escalation is
    // driven by test results, not raw session errors).
    if (category !== 'A') return;

    // Route into the single bounded recovery owner (findings 1 & 10). Capability
    // state stays untouched throughout (AC-5).
    await handleCategoryA(input.sessionID, state, {
      statusLabel:
        input.status !== undefined ? `HTTP ${input.status}` : 'session-error',
    });
  }

  function statusOf(sessionID: string, state: RuntimeState): ControlStatus {
    const status: ControlStatus = {
      sessionID,
      enabled: state.enabled,
      stage: state.stage,
      activeModel: config.models[state.stage]?.model,
      repeats: state.repeats,
      escalationInFlight: state.escalationInFlight,
      terminated: state.terminated,
      infraStopped: state.infraStopped,
      config: {
        models: config.models.map((m) => m.model),
        same_failure_threshold: config.same_failure_threshold,
        model_thresholds: config.models.map((_, i) =>
          thresholdForStage(config, i),
        ),
        require_code_change_between_failures:
          config.require_code_change_between_failures,
        stop_at_max_model: config.stop_at_max_model,
        reset_on_new_user_task: config.reset_on_new_user_task,
        notify_on_escalation: config.notify_on_escalation,
        provider_failover: config.provider_failover,
        retry_on_errors: [...config.retry_on_errors],
        retry_on_patterns: [...config.retry_on_patterns],
        max_infra_retries: config.max_infra_retries,
        infra_retry_cooldown_ms: config.infra_retry_cooldown_ms,
        test_commands: [...config.test_commands],
        shell_tool_name: config.shell_tool_name,
        mutating_tools: [...config.mutating_tools],
        idle_cleanup_ms: config.idle_cleanup_ms,
        notify: config.notify,
        debug: config.debug,
        fingerprint: {
          normalize_durations: config.fingerprint.normalize_durations,
          normalize_line_numbers: config.fingerprint.normalize_line_numbers,
          normalize_temp_paths: config.fingerprint.normalize_temp_paths,
          normalize_addresses: config.fingerprint.normalize_addresses,
          strip_ansi: config.fingerprint.strip_ansi,
          failure_markers: [...config.fingerprint.failure_markers],
        },
      },
    };
    if (state.previousFailure !== undefined) {
      status.previousFailure = state.previousFailure.slice(
        0,
        FINGERPRINT_DISPLAY_LEN,
      );
    }
    if (state.pendingReplay !== undefined) {
      status.pendingModel = state.pendingReplay.model;
    }
    return status;
  }

  function control(
    sessionID: string,
    action: ControlAction,
    now?: number,
  ): ControlStatus {
    if (!isSessionID(sessionID)) {
      return statusOf('', {
        ...initialState(),
        escalationInFlight: false,
        enabled: false,
        lastActivityMs: 0,
        terminated: false,
        infraStopped: false,
        generation: 0,
        categoryARetries: 0,
        resultsGeneration: 0,
        lockTail: Promise.resolve(),
      });
    }
    const state = ensure(sessionID, now);
    // Any control mutation bumps the serialization token so an in-flight async
    // dispatch that completes afterward bails instead of writing stale state
    // (finding 8).
    switch (action) {
      case 'enable':
        state.enabled = true;
        state.generation += 1;
        // Clear any stranded self-replay marker (P1). Enabling bumps the
        // generation (invalidating an in-flight dispatch), but a leftover
        // `pendingReplay` would otherwise pin the session against gc and could
        // swallow the next genuine chat message — mirror disable/reset.
        state.pendingReplay = undefined;
        break;
      case 'disable':
        state.enabled = false;
        state.generation += 1;
        // Invalidate any in-flight escalate/retry so its post-abort replay
        // does not still land on the stronger model (P4).
        state.pendingReplay = undefined;
        break;
      case 'reset': {
        // A full reset returns the session to its configured baseline: cheapest
        // stage, cleared failure/task state, cleared terminal latch, and
        // enabled restored to the configured default (finding 13) — a reset must
        // not leave a previously-disabled session silently disabled.
        const wasEscalated = state.stage > 0;
        const lastTaskId = state.currentTaskId;
        applyStuck(state, initialState());
        state.pendingReplay = undefined;
        state.terminated = false;
        state.infraStopped = false;
        state.categoryARetries = 0;
        state.enabled = config.enabled;
        state.generation += 1;
        state.resultsGeneration += 1;
        // Bind the reset-rebind to the last known user message id (P7). Passing
        // `undefined` made isSelfReplay treat the next real user turn (SDK-
        // optional model) as the rebind and swallow it. Keep currentTaskId so
        // the rebind's expected-task guard can still see a newer task win.
        // Reset must actually return the LIVE model to models[0], not just the
        // in-memory stage (2026-08-25 finding 3). When the session was escalated,
        // schedule an async, serialized reset-and-rebind (abort→replay to
        // models[0]); the status returned below reports the intended stage-0
        // model, which the rebind makes real. Fire-and-forget with contained
        // errors so `control` stays synchronous for its callers.
        if (wasEscalated && state.enabled) {
          void rebindToCheapest(sessionID, state, lastTaskId).catch(() => {});
        } else {
          state.currentTaskId = undefined;
        }
        break;
      }
      case 'status':
        break;
    }
    if (action !== 'status') {
      log({
        level: 'debug',
        message: 'control action applied',
        sessionID,
        data: { action, enabled: state.enabled, stage: state.stage },
      });
    }
    return statusOf(sessionID, state);
  }

  function gc(now: number): void {
    for (const [id, state] of sessions) {
      // Never drop a session mid-recovery — a delayed Category-A retry or
      // in-flight escalate holds `escalationInFlight` while it dispatches and
      // would otherwise recreate stage-0 state and lose the latch (P14).
      if (state.escalationInFlight) continue;
      // A `pendingReplay` marker no longer blocks collection unconditionally
      // (P2): once recovery has settled (`escalationInFlight` clear), a marker
      // whose self-replay chat message never arrived would strand the session's
      // `RuntimeState` forever. The idle threshold is the safety bound — a
      // marker about to be consumed keeps the session's activity fresh, so only
      // a genuinely-abandoned one (idle past `idle_cleanup_ms`) is collected.
      if (now - state.lastActivityMs > config.idle_cleanup_ms) {
        sessions.delete(id);
      }
    }
  }

  function touch(sessionID: string, now?: number): void {
    if (!isSessionID(sessionID)) return;
    ensure(sessionID, now);
  }

  function resultsGenerationOf(sessionID: string): number {
    const s = sessions.get(sessionID);
    return s === undefined ? 0 : s.resultsGeneration;
  }

  return {
    onTestResult,
    onFileEdited,
    onChatMessage,
    onSessionError,
    control,
    gc,
    touch,
    resultsGeneration: resultsGenerationOf,
  };
}
