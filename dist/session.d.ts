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
    retry(sessionID: string, model: string, delayMs: number, ctx: {
        generation: number;
        isCurrent: () => boolean;
    }): Promise<void> | void;
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
/**
 * Build the escalation orchestrator over `config` with the injected `effects`.
 * Owns a private `Map<sessionID, RuntimeState>` (NFR-7).
 */
export declare function createEscalator(args: {
    config: EscalatorConfig;
    effects: EscalatorEffects;
}): Escalator;
