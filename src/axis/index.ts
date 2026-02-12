// @meridian/axis — public API

// Axis runtime (Phase 2.8)
export { Axis, createAxis } from './axis.js';
export type { AxisLogger, AxisOptions, AxisInternals } from './axis.js';

// Component registry (impl class in axis, interface + MessageHandler in shared)
export { ComponentRegistryImpl } from './registry.js';

// Message router
export { MessageRouter, NoOpAuditWriter } from './router.js';
export type {
  AuditWriter,
  MessageRouterOptions,
  Middleware,
  RouterLogger,
} from './router.js';

// Job queue & state machine
export { JobQueue, VALID_TRANSITIONS, TERMINAL_STATES } from './job-queue.js';
export type { CreateJobOptions, TransitionOptions } from './job-queue.js';

// Request deduplication (Section 5.1.9)
export { computeDedupHash, findDuplicateJobId } from './dedup.js';

// Idempotency framework (Section 5.1.7)
export {
  computeExecutionId,
  checkIdempotency,
  recordCompletion,
  recordFailure,
  getExecutionLog,
  getExecutionEntry,
} from './idempotency.js';
export type { IdempotencyCheck, ExecutionLogEntry } from './idempotency.js';

// Error classification & retry (Section 5.1.11)
export {
  classifyError,
  extractStatusCode,
  isTimeoutError,
  computeBackoffDelay,
  shouldRetry,
} from './error-classifier.js';
export type { ErrorCategory, ClassifiedError } from './error-classifier.js';

// Timeout hierarchy (Section 5.1.10)
export {
  TimeoutBudget,
  createCompositeSignal,
  runWithTimeout,
  cancelWithGrace,
  createJobBudget,
  getExecutionBudget,
} from './timeout.js';
export type {
  TimedOperationOptions,
  CancellationProtocolOptions,
  JobTimeoutConfig,
} from './timeout.js';

// Worker pool (Section 5.1.4)
export { WorkerPool } from './worker-pool.js';
export type {
  WorkerStatus,
  WorkerInfo,
  JobProcessor,
  WorkerPoolLogger,
  WorkerPoolOptions,
} from './worker-pool.js';

// Plan pre-validation (Section 5.1.8)
export { validatePlan } from './plan-validator.js';
export type {
  GearLookup,
  PlanValidationIssue,
  PlanValidationIssueType,
} from './plan-validator.js';

// Crash recovery (Section 5.1.12)
export { recoverJobs } from './recovery.js';
export type { RecoveryLogger, RecoveryResult } from './recovery.js';

// Event loop watchdog (Section 5.1.12)
export { Watchdog } from './watchdog.js';
export type {
  WatchdogLogger,
  WatchdogOptions,
  DiagnosticDump,
} from './watchdog.js';

// Basic periodic maintenance (Section 8.3)
export { BasicMaintenance } from './maintenance-basic.js';
export type {
  MaintenanceLogger,
  MaintenanceOptions,
  MaintenanceRunResult,
} from './maintenance-basic.js';

// Startup & shutdown lifecycle (Section 5.1.14)
export { LifecycleManager } from './lifecycle.js';
export type {
  LifecycleLogger,
  LifecycleOptions,
  StartupPhase,
  DiagnosticCheck,
  DiagnosticResult,
  StartupStepHandler,
  ShutdownHandler,
} from './lifecycle.js';

// Audit logging (Sections 6.6, 8.6)
export { AuditLog, getAuditDbFileName } from './audit.js';
export type {
  AuditLogger,
  AuditLogOptions,
  AuditExportResult,
  QueryAuditOptions,
  WriteAuditEntryOptions,
} from './audit.js';
