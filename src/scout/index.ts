// @meridian/scout — public API

// Provider abstraction (Phase 3.1)
export {
  createProvider,
  resolveProviderType,
  AnthropicProvider,
  withStreamingTimeouts,
  toAnthropicTools,
  toAnthropicMessages,
  parseToolUseBlock,
} from './providers/index.js';
export type { ProviderConfig, ProviderType } from './providers/index.js';

// Plan generation (Phase 3.3)
export { Planner, createPlanner, buildSystemPrompt, assembleContext } from './planner.js';
export type {
  PlannerLogger,
  PlannerAuditWriter,
  PlannerOptions,
  PlanRequest,
  PlanResult,
  PlanError,
} from './planner.js';

// Fast path / full path detection (Phase 3.3)
export {
  detectPath,
  detectAndVerifyPath,
  verifyFastPath,
  tryParseExecutionPlan,
} from './path-detector.js';
export type {
  PathType,
  PathDetectionResult,
  FastPathVerificationContext,
} from './path-detector.js';

// LLM failure handling (Phase 3.3)
export {
  classifyFailure,
  checkRepetitiveOutput,
  createFailureState,
  incrementRetryCount,
  recordRejectedPlan,
  computePlanFingerprint,
  isModelRefusal,
  isTruncatedOutput,
  isEmptyOrNonsensical,
} from './failure-handler.js';
export type {
  FailureType,
  FailureAction,
  FailureClassification,
  PlanningFailureState,
} from './failure-handler.js';
