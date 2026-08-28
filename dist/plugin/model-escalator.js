/**
 * OpenCode plugin adapter — the live wiring for the escalation orchestrator.
 *
 * This is the thin, side-effectful shell around the pure recovery brain in
 * `src/`. The orchestrator (`createEscalator`, `src/session.ts`) owns every
 * decision — count, classify, escalate, terminal-stop, reset — and emits its
 * intent as injected effects. This file supplies those effects with real
 * OpenCode SDK calls, and feeds the orchestrator's hooks from the real plugin
 * events. It contains NO decision logic of its own (FR-16, single owner of
 * recovery).
 *
 * This is the ONLY file in the package that is the published plugin entry
 * (`opencode-model-escalator`). Helpers live in `./helpers.js` and are not
 * re-exported: OpenCode walks every export of this module and invokes each
 * function as a plugin. The pure core is published alongside as the
 * `opencode-model-escalator/core` subpath and never imports the SDK.
 *
 * Mapping (TECHNICAL_SPECIFICATION.md §7):
 *   tool.execute.before            → stamp resultsGeneration for this call
 *   tool.execute.after (bash)      → escalator.onTestResult   (§3.4 counting)
 *   tool.execute.after (edit/write)→ escalator.onFileEdited   (repair-cycle signal)
 *   event: session.error           → escalator.onSessionError (§4 Category A)
 *   chat.message                   → escalator.onChatMessage  (§6 task boundary)
 *   effects.abort   → client.session.abort
 *   effects.replay  → client.session.messages → getLastUserPayload → promptAsync
 *   effects.notify  → client.tui.showToast
 *   effects.log     → client.app.log
 *   tool model_escalator_control   → escalator.control        (FR-13)
 *   Hooks.dispose                  → cancel pending Category-A timers
 *
 * CONFIG SOURCE (CONFIGURATION_REFERENCE.md §1). When the package is installed
 * from npm and registered by bare name (`"plugin": ["opencode-model-escalator"]`),
 * OpenCode invokes the plugin with `options === undefined` — there is no
 * documented options channel for a package-name load. The adapter therefore
 * reads its config from a `.opencode/escalator.json` sidecar in the project
 * `directory`. Precedence: inline plugin `options` (delivered only by a local
 * `[path, options]` tuple) win when present; otherwise the sidecar is used; if
 * neither supplies a config, `resolveConfig` throws `models is required` and
 * load fails LOUDLY (CFG-2, AC-14) — never a silent no-op. Any sidecar
 * read/parse error also throws. A package-name `[name, options]` tuple does
 * NOT deliver options.
 *
 * NOTE ON `file.edited` (spec §7 divergence, flagged in deferred-work.md): the
 * real OpenCode `EventFileEdited` carries only `{ file }` — no `sessionID` — so
 * a bare `file.edited` event cannot be attributed to a session. The repair-cycle
 * signal is instead taken from the edit/write tools' `tool.execute.after`, which
 * DO carry `sessionID`; that is the same "the agent changed code in this session"
 * signal the counter needs (FR-3). The `file.edited` event is still observed for
 * debug visibility only.
 */
import { tool } from '@opencode-ai/plugin';
import { createEscalator, getLastUserPayload, parseModelId, resolveConfig, } from '../index.js';
import { errorToSignal, loadUserConfig, readExitCode, toPromptInputParts, toolDidMutate, } from './helpers.js';
/** Log service name attached to every `client.app.log` line (spec §9). */
const LOG_SERVICE = 'model-escalator';
function isSessionID(value) {
    return typeof value === 'string' && value.length > 0;
}
/**
 * The escalation plugin. OpenCode invokes this with its client/directory and the
 * plugin's own options block; we resolve config, build the SDK-backed effects,
 * construct the single orchestrator, and return the hook table that drives it.
 */
export const ModelEscalator = async ({ client, directory }, options) => {
    // Fail loudly at load on invalid config (CFG-2, AC-14). Best-effort log first
    // so the reason is visible in OpenCode's log, then rethrow to abort load.
    let config;
    try {
        config = resolveConfig(loadUserConfig(directory, options));
    }
    catch (err) {
        // Best-effort log; never let a rejected log promise mask the config error
        // with an unhandled rejection (finding 21).
        void Promise.resolve(client.app.log({
            body: {
                service: LOG_SERVICE,
                level: 'error',
                message: `config error: ${err.message}`,
            },
        })).catch(() => { });
        throw err;
    }
    const query = { directory };
    // Resolved once at load: the set of tool names whose successful run counts as
    // a code change (finding 4). Configurable so mutations via non-default tools
    // (formatters, generators, custom edit tools) are recognized (FR-3).
    const mutatingTools = new Set(config.mutating_tools);
    // The live project root feeds the fingerprint's root-scrub (AC-9, finding 16):
    // hand the adapter's working directory to the deterministic core so a checkout
    // path never perturbs a fingerprint. Only when the operator didn't pin one.
    if (typeof directory === 'string' &&
        directory.length > 0 &&
        (config.fingerprint.project_root === undefined ||
            config.fingerprint.project_root.length === 0)) {
        config.fingerprint.project_root = directory;
    }
    /**
     * Same-session dispatch of the last real user turn into `sessionID` under
     * `model` (FR-5, §5). Shared by `replay` (capability escalation) and `retry`
     * (Category-A infra recovery). Any failure throws — the orchestrator's
     * `escalate()` / `onSessionError` paths handle it.
     */
    async function dispatchLastUserTurn(sessionID, model) {
        const parsed = parseModelId(model);
        if (parsed === null) {
            throw new Error(`unparseable escalation model id "${model}"`);
        }
        const messages = await client.session.messages({
            path: { id: sessionID },
            query,
        });
        if (messages.error !== undefined) {
            throw new Error(`session.messages failed: ${JSON.stringify(messages.error)}`);
        }
        const payload = getLastUserPayload(messages.data);
        if (payload === null) {
            throw new Error(`no replayable user message in session ${sessionID}`);
        }
        const parts = toPromptInputParts(payload.parts);
        if (parts.length === 0) {
            throw new Error(`no replayable input parts in session ${sessionID}`);
        }
        const prompt = await client.session.promptAsync({
            path: { id: sessionID },
            query,
            body: {
                model: parsed,
                // Output `Part`s projected onto the narrower prompt-input part union
                // (see `toPromptInputParts`): input-compatible kinds only, input
                // fields only — no output-only field reaches the server.
                parts,
                ...(payload.agent !== undefined ? { agent: payload.agent } : {}),
                messageID: payload.messageID,
            },
        });
        if (prompt.error !== undefined) {
            throw new Error(`session.promptAsync failed: ${JSON.stringify(prompt.error)}`);
        }
    }
    /** Pending Category-A backoff timers; cancelled on `dispose`. */
    const retryTimers = new Set();
    function sleep(ms) {
        return new Promise((resolve) => {
            const t = setTimeout(() => {
                retryTimers.delete(t);
                resolve();
            }, ms);
            retryTimers.add(t);
        });
    }
    const effects = {
        async abort(sessionID) {
            // MUST throw on SDK failure (finding 7): a silently-failed abort would let
            // the orchestrator believe the session was stopped and dispatch a replay
            // into a still-running generation. Surface the error so escalate()'s
            // dispatch-failure path (rollback + terminal stop) runs.
            const res = await client.session.abort({ path: { id: sessionID }, query });
            if (res !== undefined && res !== null && res.error !== undefined) {
                throw new Error(`session.abort failed: ${JSON.stringify(res.error)}`);
            }
        },
        async replay(sessionID, model) {
            await dispatchLastUserTurn(sessionID, model);
        },
        /**
         * Bounded Category-A retry (FR-9, finding 2): wait out the orchestrator's
         * backoff, then re-dispatch the last user turn under the SAME model. The
         * delay lives HERE, in the side-effect layer — never in the deterministic
         * decision path (NFR-1). A non-positive delay dispatches immediately.
         *
         * The orchestrator does not await this effect from the host hook (NFR-3);
         * the sleep happens on a detached promise. After the backoff the session
         * may have moved on — we consult `ctx.isCurrent()` AFTER sleeping and
         * BEFORE dispatching, so a stale wake never replays an obsolete model.
         */
        async retry(sessionID, model, delayMs, ctx) {
            if (typeof delayMs === 'number' && delayMs > 0) {
                await sleep(delayMs);
            }
            if (ctx !== undefined && !ctx.isCurrent())
                return;
            await dispatchLastUserTurn(sessionID, model);
        },
        async notify(message) {
            // The master `notify` switch (CONFIG §4.6) suppresses all toasts.
            if (!config.notify)
                return;
            // Toast delivery is best-effort: headless OpenCode has no TUI, and the SDK
            // reports that as a result-level `error` rather than a throw. Never drop a
            // terminal/escalation message on the floor — if the toast is unavailable or
            // errors, fall back to a durable log line so the text still lands somewhere
            // (2026-08-25 finding 16). `notify` itself never throws.
            let delivered = false;
            try {
                const res = await client.tui.showToast({ body: { message, variant: 'info' } });
                delivered = !(res !== undefined &&
                    res !== null &&
                    res.error !== undefined);
            }
            catch {
                delivered = false;
            }
            if (delivered)
                return;
            try {
                await client.app.log({
                    body: { service: LOG_SERVICE, level: 'info', message: `notify: ${message}` },
                });
            }
            catch {
                /* last resort exhausted; nothing more we can safely do */
            }
        },
        async log(entry) {
            const body = {
                service: LOG_SERVICE,
                level: entry.level,
                message: entry.message,
            };
            const extra = {};
            if (entry.sessionID !== undefined)
                extra.sessionID = entry.sessionID;
            if (entry.data !== undefined)
                Object.assign(extra, entry.data);
            if (Object.keys(extra).length > 0)
                body.extra = extra;
            await client.app.log({ body });
        },
    };
    const escalator = createEscalator({ config, effects });
    /**
     * Per-call generation stamp (P3). `tool.execute.after` has no `model` field,
     * so a late bash result from an aborted generation cannot be dropped by
     * model identity. We snapshot `resultsGeneration` at `tool.execute.before`
     * (keyed by callID) and pass it into `onTestResult`.
     */
    const callEpochs = new Map();
    /**
     * Bound on `callEpochs` (P3). An entry is added in `tool.execute.before` and
     * removed in `after`, but a tool call that is aborted mid-flight never fires
     * `after`, leaking its `callID`. Evict the oldest entry (Map preserves
     * insertion order) once the map exceeds this cap so an abandoned-call backlog
     * cannot grow without bound. `dispose` clears the map entirely.
     */
    const MAX_CALL_EPOCHS = 4096;
    /** Refresh activity for this session, then drop idle others (NFR-4). */
    function tick(sessionID, now) {
        if (isSessionID(sessionID))
            escalator.touch(sessionID, now);
        escalator.gc(now);
    }
    const hooks = {
        'tool.execute.before': async (input) => {
            if (!isSessionID(input.sessionID))
                return;
            const now = Date.now();
            tick(input.sessionID, now);
            callEpochs.set(input.callID, escalator.resultsGeneration(input.sessionID));
            // Evict the oldest entry if aborted (never-`after`) calls have grown the
            // map past its cap (P3).
            if (callEpochs.size > MAX_CALL_EPOCHS) {
                const oldest = callEpochs.keys().next().value;
                if (oldest !== undefined)
                    callEpochs.delete(oldest);
            }
        },
        'tool.execute.after': async (input, output) => {
            const now = Date.now();
            const sessionID = input.sessionID;
            tick(sessionID, now);
            if (!isSessionID(sessionID))
                return;
            const generation = callEpochs.get(input.callID);
            callEpochs.delete(input.callID);
            // Test-result path: the shell tool running a (possibly) test command.
            if (input.tool === config.shell_tool_name) {
                const command = String(input.args?.command ?? '');
                await escalator.onTestResult({
                    sessionID,
                    command,
                    output: String(output.output ?? ''),
                    exitCode: readExitCode(output.metadata),
                    now,
                    ...(generation !== undefined ? { generation } : {}),
                });
                return;
            }
            // Code-change path: a configured mutating tool ran ⇒ a repair attempt
            // happened in this session (FR-3). This is the session-attributed stand-in
            // for the session-less `file.edited` event (see file header). Only a
            // SUCCESSFUL mutation arms the repair-cycle flag (finding 4): a failed
            // patch/write did not change code and must not count.
            if (mutatingTools.has(input.tool)) {
                if (toolDidMutate(output)) {
                    escalator.onFileEdited({ sessionID, now });
                }
                else if (config.debug) {
                    // Fire-and-forget debug line: contain its rejection so a failed log
                    // write never surfaces as an unhandled rejection (2026-08-25 finding 16).
                    void Promise.resolve(effects.log({
                        level: 'debug',
                        message: 'mutating tool ran but reported no successful change; ignoring',
                        sessionID,
                        data: { tool: input.tool },
                    })).catch(() => { });
                }
            }
        },
        event: async ({ event }) => {
            const now = Date.now();
            if (event.type === 'session.error') {
                const sessionID = event.properties.sessionID;
                tick(typeof sessionID === 'string' ? sessionID : undefined, now);
                if (!isSessionID(sessionID))
                    return;
                const { status, message } = errorToSignal(event.properties.error);
                await escalator.onSessionError({ sessionID, status, message, now });
                return;
            }
            tick(undefined, now);
            // `file.edited` carries no sessionID (see header); observe for debug only.
            if (event.type === 'file.edited' && config.debug) {
                // Contain the fire-and-forget log rejection (2026-08-25 finding 16).
                void Promise.resolve(effects.log({
                    level: 'debug',
                    message: 'file.edited observed (no sessionID; not attributed)',
                    data: { file: event.properties.file },
                })).catch(() => { });
            }
        },
        'chat.message': async (input) => {
            const now = Date.now();
            tick(input.sessionID, now);
            if (!isSessionID(input.sessionID))
                return;
            // Surface the running model (finding 1/8): `provider/model` when observable
            // lets the orchestrator both recognize its own self-replay by model
            // identity and enforce cheap-first by rebinding a genuine new task off a
            // stronger model back to models[0]. `await` so that rebind's abort+replay
            // completes within the hook (finding 1).
            const m = input
                .model;
            const model = m !== undefined &&
                typeof m.providerID === 'string' &&
                typeof m.modelID === 'string'
                ? `${m.providerID}/${m.modelID}`
                : undefined;
            // D1 (live OpenCode 1.18.23): subagents get their own session with
            // `parentID` set; child hooks carry the child sessionID. Isolation is
            // by sessionID (spec §8) — `input.agent` is not forwarded.
            await escalator.onChatMessage({
                sessionID: input.sessionID,
                taskId: input.messageID,
                ...(model !== undefined ? { model } : {}),
                now,
            });
        },
        tool: {
            /**
             * Session-scoped control tool (FR-13, AC-13). The orchestrator's
             * `control()` carries all the logic; this only surfaces it to the model.
             */
            model_escalator_control: tool({
                description: 'Control the model-escalator for the current session: enable, ' +
                    'disable, reset (back to the cheapest model), or read status ' +
                    '(current stage, active model, repeat count, and effective config).',
                args: {
                    action: tool.schema
                        .enum(['enable', 'disable', 'status', 'reset'])
                        .describe('The control action to perform.'),
                },
                async execute(args, context) {
                    if (!isSessionID(context.sessionID)) {
                        return {
                            title: `model-escalator: ${args.action}`,
                            output: JSON.stringify({ error: 'missing sessionID' }),
                            metadata: {},
                        };
                    }
                    const status = escalator.control(context.sessionID, args.action, Date.now());
                    return {
                        title: `model-escalator: ${args.action}`,
                        output: JSON.stringify(status, null, 2),
                        metadata: { status },
                    };
                },
            }),
        },
        async dispose() {
            for (const t of retryTimers)
                clearTimeout(t);
            retryTimers.clear();
            // Drop any per-call generation stamps so an unloaded plugin leaves no
            // residual state (P3).
            callEpochs.clear();
        },
    };
    return hooks;
};
export default ModelEscalator;
//# sourceMappingURL=model-escalator.js.map