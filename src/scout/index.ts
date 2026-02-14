// @meridian/scout — public API

// Scout component (Phase 3.5)
export { Scout, createScout } from './scout.js';
export type { ScoutConfig, ScoutDependencies } from './scout.js';

// Versioned prompt templates (Phase 3.5)
export {
  PLAN_GENERATION_TEMPLATE,
  SCOUT_IDENTITY,
  SAFETY_RULES,
  FORCE_FULL_PATH_INSTRUCTION,
  EXECUTION_PLAN_SCHEMA,
} from './prompts/plan-generation.js';
export type { PromptTemplate } from './prompts/plan-generation.js';

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

// Adaptive model routing (Phase 11.1)
export {
  ModelRouter,
  classifyTaskComplexity,
  selectModelTier,
} from './model-router.js';
export type {
  ModelRouterConfig,
  ModelRouterLogger,
} from './model-router.js';

// External content provenance (Phase 3.4)
export {
  wrapWithProvenance,
  wrapGearOutput,
  wrapEmailContent,
  wrapWebContent,
  wrapDocumentContent,
  escapeAttributeValue,
  sanitizeContent,
  isInstructionSource,
  hasTagEscapeAttempt,
} from './provenance.js';
export type {
  ContentSource,
  TrustLevel,
  ProvenanceAttributes,
  ProvenanceWrappedContent,
} from './provenance.js';

// MCP tool-use integration (Phase 11.2, Section 9.4)
export {
  gearToMCPTools,
  mcpToProviderTools,
  supportsNativeMCP,
} from './mcp-tool-use.js';

// Plan Replay Cache (Phase 11.4)
export { PlanReplayCache } from './plan-replay-cache.js';
export type {
  PlanReplayCacheConfig,
  PlanReplayCacheLogger,
} from './plan-replay-cache.js';

// Semantic Response Cache (Phase 11.4)
export { SemanticCache } from './semantic-cache.js';
export type {
  SemanticCacheConfig,
  SemanticCacheLogger,
  EmbeddingProviderLike,
} from './semantic-cache.js';
