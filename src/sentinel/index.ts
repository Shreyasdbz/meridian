// @meridian/sentinel — public API

// Sentinel component (Phase 4.3, updated Phase 9.1)
export { Sentinel, createSentinel } from './sentinel.js';
export type {
  SentinelConfig,
  SentinelLLMConfig,
  SentinelDependencies,
  SentinelLogger,
} from './sentinel.js';

// Risk assessor (Phase 4.1)
export type { ActionType, RiskDivergence } from './risk-assessor.js';
export {
  RISK_LEVEL_ORDER,
  classifyAction,
  assessStepRisk,
  checkRiskDivergence,
} from './risk-assessor.js';

// Policy engine (Phase 4.1)
export type { PolicyEngineConfig, UserPolicyOverride } from './policy-engine.js';
export { HARD_FLOOR_ACTIONS, evaluatePlan } from './policy-engine.js';

// Approval flow (Phase 4.2)
export type {
  ApprovalOutcome,
  ApprovedOutcome,
  NeedsRevisionOutcome,
  NeedsUserApprovalOutcome,
  RejectedOutcome,
  ApprovalRequest,
  ApprovalStepSummary,
  ApprovalResponse,
  UserApprovalOutcome,
} from './approval.js';
export { routeVerdict, processUserApproval } from './approval.js';

// Plan stripper (Phase 9.1)
export type { StrippedExecutionPlan, StrippedExecutionStep } from './plan-stripper.js';
export { stripPlan, stripStep } from './plan-stripper.js';

// Sentinel Memory (Phase 10.3)
export { SentinelMemory, matchFileScope, matchNetworkScope, matchFinancialScope } from './memory.js';
export type {
  SentinelMemoryOptions,
  SentinelMemoryLogger,
  StoreDecisionOptions,
  MatchResult,
} from './memory.js';

// LLM validator (Phase 9.1)
export type {
  LLMValidatorConfig,
  LLMValidatorLogger,
  LLMValidationResponse,
  SameProviderWarning,
} from './llm-validator.js';
export {
  validatePlanWithLLM,
  buildSystemPrompt,
  buildValidationMessage,
  parseValidationResponse,
  checkSameProvider,
} from './llm-validator.js';

// Approval Cache (Phase 11.4)
export { ApprovalCache } from './approval-cache.js';
export type {
  ApprovalCacheConfig,
  ApprovalCacheLogger,
} from './approval-cache.js';
