// @meridian/sentinel — public API

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
