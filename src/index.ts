/**
 * Public surface of the deterministic detection core.
 *
 * The integration spec (plugin hooks, session state map, replay, control tool,
 * notifications, idle GC) consumes these. Nothing here imports
 * `@opencode-ai/plugin`.
 */

export type {
  ModelStage,
  FingerprintConfig,
  EscalatorConfig,
  FailureCategory,
  StuckState,
} from './types.js';

export {
  DEFAULTS,
  resolveConfig,
  parseModelId,
  thresholdForStage,
  type UserConfig,
} from './config.js';

export {
  looksLikeTestCommand,
  normalizeOutput,
  failureFingerprint,
  classifyFailure,
} from './detection.js';

export {
  recordFailure,
  markCodeChanged,
  clearFailureState,
  initialState,
  type RecordFailureResult,
} from './counter.js';
