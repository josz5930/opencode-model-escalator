/**
 * Public surface of the deterministic detection core.
 *
 * The plugin adapter (`src/plugin/`) and the `./core` subpath consume this
 * surface. Nothing here imports `@opencode-ai/plugin`.
 */
export { DEFAULTS, resolveConfig, parseModelId, thresholdForStage, } from './config.js';
export { looksLikeTestCommand, normalizeOutput, failureFingerprint, classifyFailure, } from './detection.js';
export { recordFailure, markCodeChanged, clearFailureState, initialState, } from './counter.js';
export { getLastUserPayload, } from './replay.js';
export { createEscalator, } from './session.js';
//# sourceMappingURL=index.js.map