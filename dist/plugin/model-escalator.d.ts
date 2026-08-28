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
import { type Plugin } from '@opencode-ai/plugin';
/**
 * The escalation plugin. OpenCode invokes this with its client/directory and the
 * plugin's own options block; we resolve config, build the SDK-backed effects,
 * construct the single orchestrator, and return the hook table that drives it.
 */
export declare const ModelEscalator: Plugin;
export default ModelEscalator;
