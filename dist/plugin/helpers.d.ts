/**
 * Adapter helpers that must NOT live on the package entry. OpenCode walks every
 * export of `exports["."]` and invokes each function as a plugin, so these stay
 * on a sibling module that the adapter imports and does not re-export.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { MessagePart, UserConfig } from '../index.js';
/**
 * The prompt-input part union, derived from the installed SDK's
 * `session.promptAsync` signature rather than a hand-copied list — so it tracks
 * the real client type across SDK versions. This is the narrow union
 * (`text` | `file` | `agent` | `subtask`) that a replay may dispatch.
 */
export type PromptPart = NonNullable<Parameters<PluginInput['client']['session']['promptAsync']>[0]['body']>['parts'][number];
/**
 * Project the last user turn's stored output `Part`s down to the prompt-INPUT
 * part union for replay.
 *
 * `session.messages` returns output `Part`s — a strict superset of the input
 * union: the shared kinds (`text`/`file`/`agent`/`subtask`) carry extra
 * output-only fields (`id`/`sessionID`/`messageID`), and the union adds kinds
 * with no input form (`reasoning`/`tool`/`step-*`/`snapshot`/`patch`/…). We
 * keep only the input-compatible kinds and copy only each kind's input fields,
 * so no output-only field can reach — and be rejected by — the server. A user
 * turn normally holds just `text` (and maybe `file`) parts; other kinds are
 * dropped safely. `source` on file parts references output ranges and is
 * intentionally not forwarded. A required string field that is missing OR blank
 * is treated as malformed, so the part is dropped rather than forwarded for the
 * server to reject.
 */
export declare function toPromptInputParts(parts: MessagePart[]): PromptPart[];
/** Project-relative location of the config sidecar (see adapter header, CONFIG SOURCE). */
export declare const CONFIG_SIDECAR: readonly [".opencode", "escalator.json"];
/**
 * Resolve the raw user config from its two possible sources, in precedence
 * order:
 *   1. inline plugin `options` — used verbatim when a non-empty object is
 *      supplied (the local `[path, options]` tuple form).
 *   2. the `<directory>/.opencode/escalator.json` sidecar — the source used for
 *      an npm package-name load, where `options` is always `undefined`.
 *
 * Returns `undefined` when neither is present, so `resolveConfig` raises the
 * canonical `models is required` error and load fails loudly (CFG-2, AC-14).
 * Any sidecar that exists but cannot be read or parsed throws — a broken config
 * is never silently ignored.
 */
export declare function loadUserConfig(directory: string | undefined, options: unknown): UserConfig | undefined;
/**
 * Did a tool's `tool.execute.after` actually mutate code SUCCESSFULLY? (FR-3)
 *
 * A mutating tool that errored — a failed patch, a write to a locked path — or
 * that ran as a no-op did NOT change code, so it must not arm the repair-cycle
 * flag (else a failed/no-op custom tool manufactures a false repair cycle and
 * over-escalates). OpenCode exposes no uniform success boolean, so we resolve by
 * evidence, in order:
 *
 *   1. Explicit failure evidence (an `error`, `success:false`, a non-zero exit,
 *      a failed/aborted status, `edits:0`, …) on the result or its metadata ⇒
 *      NOT a change. Checked first so a failure is never overridden.
 *   2. Explicit positive evidence (`success:true`, `changed:true`, `edits>0`,
 *      `ok:true`) on the result OR its metadata ⇒ a real change.
 *   3. A result that DOES carry a status channel but said neither ⇒ conservative
 *      NO change: the tool had a chance to report success and didn't.
 *   4. Only a result with NO recognized status channel at all (e.g. a bare
 *      `{ title, output }`) falls back to trusting the run — the built-in
 *      edit/write tools do not guarantee a machine-readable flag, and a false
 *      negative here would silently disable the FR-3 signal. This absence-based
 *      arming is the single deliberate exception, not the default.
 */
export declare function toolDidMutate(output: unknown): boolean;
/**
 * Read a process exit code out of a bash tool's `metadata`, defensively.
 *
 * `tool.execute.after` types `metadata` as `any`; the bash tool stores the exit
 * code under `exit`. We return a number ONLY when a clean integer is present —
 * anything else yields `undefined`, which the orchestrator treats as "no usable
 * exit signal" and falls back to a marker scan (AC-15, graceful degradation).
 */
export declare function readExitCode(metadata: unknown): number | undefined;
/**
 * Flatten an OpenCode `session.error` payload into `{ status, message }` for the
 * orchestrator's Category-A classifier (§4). Pulls the HTTP status off an
 * `APIError` and a human message off whichever named error shape arrived.
 */
export declare function errorToSignal(error: unknown): {
    status?: number;
    message?: string;
};
