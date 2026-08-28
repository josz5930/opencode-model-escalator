/**
 * Public surface of the deterministic detection core.
 *
 * The plugin adapter (`src/plugin/`) and the `./core` subpath consume this
 * surface. Nothing here imports `@opencode-ai/plugin`.
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

export {
  getLastUserPayload,
  type MessagePart,
  type MessageInfo,
  type SessionMessage,
  type UserPayload,
} from './replay.js';

export {
  createEscalator,
  type Escalator,
  type RuntimeState,
  type EscalatorEffects,
  type LogEntry,
  type TestResultInput,
  type FileEditedInput,
  type ChatMessageInput,
  type SessionErrorInput,
  type ControlAction,
  type ControlStatus,
} from './session.js';
