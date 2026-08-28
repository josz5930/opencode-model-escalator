/**
 * Adapter helpers that must NOT live on the package entry. OpenCode walks every
 * export of `exports["."]` and invokes each function as a plugin, so these stay
 * on a sibling module that the adapter imports and does not re-export.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import type { MessagePart, UserConfig } from '../index.js';

/**
 * The prompt-input part union, derived from the installed SDK's
 * `session.promptAsync` signature rather than a hand-copied list — so it tracks
 * the real client type across SDK versions. This is the narrow union
 * (`text` | `file` | `agent` | `subtask`) that a replay may dispatch.
 */
export type PromptPart = NonNullable<
  Parameters<PluginInput['client']['session']['promptAsync']>[0]['body']
>['parts'][number];

/** A non-empty string — a required input field the server would reject if blank. */
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

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
export function toPromptInputParts(parts: MessagePart[]): PromptPart[] {
  const out: PromptPart[] = [];
  for (const p of parts) {
    if (p.type === 'text' && nonEmpty(p.text)) {
      out.push({ type: 'text', text: p.text });
    } else if (p.type === 'file' && nonEmpty(p.mime) && nonEmpty(p.url)) {
      out.push({
        type: 'file',
        mime: p.mime,
        url: p.url,
        ...(nonEmpty(p.filename) ? { filename: p.filename } : {}),
      });
    } else if (p.type === 'agent' && nonEmpty(p.name)) {
      out.push({ type: 'agent', name: p.name });
    } else if (
      p.type === 'subtask' &&
      nonEmpty(p.prompt) &&
      nonEmpty(p.description) &&
      nonEmpty(p.agent)
    ) {
      out.push({
        type: 'subtask',
        prompt: p.prompt,
        description: p.description,
        agent: p.agent,
      });
    }
  }
  return out;
}

/** Project-relative location of the config sidecar (see adapter header, CONFIG SOURCE). */
export const CONFIG_SIDECAR = ['.opencode', 'escalator.json'] as const;

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
export function loadUserConfig(
  directory: string | undefined,
  options: unknown,
): UserConfig | undefined {
  // 1. Inline options win when present. A malformed options value is a hard
  //    error, not a fall-through to the sidecar (fail loudly).
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      throw new Error(
        'opencode-model-escalator: plugin `options` must be an object when supplied (CFG-2).',
      );
    }
    if (Object.keys(options as Record<string, unknown>).length > 0) {
      return options as UserConfig;
    }
  }

  // 2. Sidecar file.
  if (typeof directory !== 'string' || directory.length === 0) {
    return undefined;
  }
  const sidecarPath = join(directory, ...CONFIG_SIDECAR);
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No sidecar and no inline options ⇒ let resolveConfig throw the
      // canonical "models is required" load error (CFG-2, AC-14).
      return undefined;
    }
    throw new Error(
      `opencode-model-escalator: failed to read config sidecar at ${sidecarPath}: ${
        (err as Error).message
      } (CFG-2).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `opencode-model-escalator: config sidecar at ${sidecarPath} is not valid JSON: ${
        (err as Error).message
      } (CFG-2).`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `opencode-model-escalator: config sidecar at ${sidecarPath} must contain a JSON object (CFG-2).`,
    );
  }
  return parsed as UserConfig;
}

/** Known status keys a tool result may expose on itself or its `metadata`. */
const STATUS_KEYS = [
  'success',
  'ok',
  'changed',
  'edits',
  'error',
  'failed',
  'aborted',
  'cancelled',
  'canceled',
  'status',
  'exit',
  'exitCode',
] as const;

/** Does this record carry ANY recognized status/result channel? */
function hasStatusChannel(r: Record<string, unknown>): boolean {
  for (const k of STATUS_KEYS) {
    if (r[k] !== undefined) return true;
  }
  return false;
}

/** String statuses that positively denote a failed / no-change run. */
const RE_FAILURE_STATUS = /^(error|fail|failed|failure|aborted|cancell?ed)$/i;

/** Explicit evidence that a tool run FAILED or changed nothing. */
function hasFailureEvidence(r: Record<string, unknown>): boolean {
  if (r.error !== undefined && r.error !== null && r.error !== false) return true;
  if (r.success === false || r.ok === false || r.changed === false) return true;
  if (r.failed === true || r.aborted === true) return true;
  if (r.cancelled === true || r.canceled === true) return true;
  if (typeof r.status === 'string' && RE_FAILURE_STATUS.test(r.status.trim())) {
    return true;
  }
  for (const k of ['exit', 'exitCode'] as const) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return true;
  }
  return false;
}

function positiveEdits(v: unknown): boolean {
  return typeof v === 'number' && v > 0;
}

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
export function toolDidMutate(output: unknown): boolean {
  // A non-object result carries no status channel ⇒ trust the run (rule 4).
  if (output === null || typeof output !== 'object') return true;
  const o = output as Record<string, unknown>;
  const meta =
    o.metadata !== null && typeof o.metadata === 'object'
      ? (o.metadata as Record<string, unknown>)
      : undefined;

  // 1. Explicit failure evidence anywhere ⇒ no change.
  if (hasFailureEvidence(o) || (meta !== undefined && hasFailureEvidence(meta))) {
    return false;
  }

  // 2. Explicit positive evidence ⇒ a real change. Top-level `edits` counts
  //    the same as `metadata.edits` — `{ edits: 3 }` is a status-channel key
  //    and would otherwise fall through to the conservative no-change rule.
  if (o.success === true || o.ok === true || o.changed === true) return true;
  if (positiveEdits(o.edits)) return true;
  if (meta !== undefined) {
    if (meta.success === true || meta.changed === true || meta.ok === true) return true;
    if (positiveEdits(meta.edits)) return true;
  }

  // 3. A status channel that didn't confirm success ⇒ conservative no change.
  if (hasStatusChannel(o) || (meta !== undefined && hasStatusChannel(meta))) {
    return false;
  }

  // 4. No status channel at all ⇒ trust the run (documented above).
  return true;
}

/**
 * Read a process exit code out of a bash tool's `metadata`, defensively.
 *
 * `tool.execute.after` types `metadata` as `any`; the bash tool stores the exit
 * code under `exit`. We return a number ONLY when a clean integer is present —
 * anything else yields `undefined`, which the orchestrator treats as "no usable
 * exit signal" and falls back to a marker scan (AC-15, graceful degradation).
 */
export function readExitCode(metadata: unknown): number | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>).exit;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    // Require a plain integer literal (P7). Bare `Number()` coerces `"0x10"`→16,
    // `"1e3"`→1000, `"  1 "`→1 — misreading a non-integer exit string as a real
    // exit code. A clean `/^-?\d+$/` (after trim) accepts only true integers.
    const t = raw.trim();
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isInteger(n)) return n;
    }
  }
  return undefined;
}

/**
 * Flatten an OpenCode `session.error` payload into `{ status, message }` for the
 * orchestrator's Category-A classifier (§4). Pulls the HTTP status off an
 * `APIError` and a human message off whichever named error shape arrived.
 */
export function errorToSignal(
  error: unknown,
): { status?: number; message?: string } {
  if (error === null || typeof error !== 'object') return {};
  const e = error as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    data?: unknown;
  };
  const data =
    e.data !== null && typeof e.data === 'object'
      ? (e.data as Record<string, unknown>)
      : {};

  const signal: { status?: number; message?: string } = {};
  // Providers surface the HTTP status under different keys (P5): the SDK's
  // `APIError` uses `data.statusCode`, but others expose `data.status`,
  // `error.status`, or a top-level `error.statusCode`. Take the first numeric
  // one so the authoritative structured Category-A signal is never lost.
  const statusCandidates = [
    data.statusCode,
    data.status,
    e.statusCode,
    e.status,
  ];
  for (const candidate of statusCandidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      signal.status = candidate;
      break;
    }
  }

  const parts: string[] = [];
  if (typeof e.name === 'string') parts.push(e.name);
  if (typeof data.message === 'string') parts.push(data.message);
  if (parts.length > 0) signal.message = parts.join(': ');

  return signal;
}
