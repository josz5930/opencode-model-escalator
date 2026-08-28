/**
 * Config defaults, resolution, and load-time validation.
 *
 * Closes CFG-1 (honor documented defaults), CFG-2 / AC-14 (fail loudly on
 * invalid config), NFR-5 (zero-config: only `models` required).
 *
 * No runtime imports beyond the shared types — keeps the core pure.
 */
import type { EscalatorConfig, FingerprintConfig } from './types.js';
/**
 * Every documented default (CONFIGURATION_REFERENCE.md §3) EXCEPT `models`,
 * which is required from the user (empty ⇒ load error, CFG-2). `models` is
 * deliberately absent so no model id — verified or otherwise — ships as a
 * default (OQ1 / C-4).
 */
export declare const DEFAULTS: Omit<EscalatorConfig, 'models'>;
/** Shape of the user-supplied options (all fields optional except `models`). */
export type UserConfig = {
    models?: unknown;
} & Partial<Omit<EscalatorConfig, 'models' | 'fingerprint'>> & {
    fingerprint?: Partial<FingerprintConfig>;
};
/**
 * Largest delay Node's timers represent without overflow/immediate-fire
 * (2^31 - 1 ms ≈ 24.8 days). Cooldowns and cleanup intervals are bounded to
 * this so a huge configured value can neither overflow a `setTimeout` nor,
 * after exponential backoff, wrap to a negative/zero delay (2026-08-25 finding
 * 13). The orchestrator additionally clamps the backed-off delay to this bound.
 */
export declare const MAX_TIMER_MS = 2147483647;
/**
 * Parse an OpenCode model id `provider/model` on the FIRST `/`.
 * OpenRouter ids carry a nested `/` inside the model portion, e.g.
 * `openrouter/deepseek/deepseek-v4-flash-0731` → provider `openrouter`,
 * model `deepseek/deepseek-v4-flash-0731`. See TECHNICAL_SPECIFICATION.md §5.1.
 *
 * @returns `{ providerID, modelID }`, or `null` if it does not parse into a
 *          non-empty provider AND a non-empty model.
 */
export declare function parseModelId(id: string): {
    providerID: string;
    modelID: string;
} | null;
/**
 * Resolve user options over the documented defaults and validate per
 * CONFIGURATION_REFERENCE.md §6. Throws an `Error` with a specific message on
 * any invalid input — never silently disables escalation (CFG-2, AC-14).
 */
export declare function resolveConfig(user: UserConfig | undefined): EscalatorConfig;
/**
 * Return the per-stage threshold for `stage`, falling back to the top-level
 * default. See TECHNICAL_SPECIFICATION.md §2, §5.
 */
export declare function thresholdForStage(cfg: EscalatorConfig, stage: number): number;
