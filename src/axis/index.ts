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
export type { CreateJobOptions, TransitionOptions, JobStatusChangeListener } from './job-queue.js';

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

// Full idle maintenance (Phase 10.6)
export { IdleMaintenance } from './maintenance.js';
export type {
  IdleMaintenanceLogger,
  IdleMaintenanceOptions,
  IdleMaintenanceResult,
  IdleCheck,
  StagedMemoryPromoter,
  SentinelPruner,
  BackupCreator,
} from './maintenance.js';

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
export { AuditLog, getAuditDbFileName, computeEntryHash } from './audit.js';
export type {
  AuditLogger,
  AuditLogOptions,
  AuditExportResult,
  ChainVerificationResult,
  QueryAuditOptions,
  WriteAuditEntryOptions,
} from './audit.js';

// Encrypted backups (Phase 10.5)
export { BackupManager, encrypt, decrypt, deriveKey } from './backup.js';
export type {
  BackupManagerOptions,
  BackupLogger,
  BackupResult,
} from './backup.js';

// Metrics collector (Section 12.2)
export { MetricsCollector } from './metrics.js';
export type { MetricsCollectorOptions } from './metrics.js';

// Cron scheduling (Phase 9.4) — re-exported from shared
export {
  parseCronExpression,
  isValidCronExpression,
  getNextRun,
} from '@meridian/shared';
export type { CronSchedule } from '@meridian/shared';

export { ScheduleEvaluator } from './schedule-evaluator.js';
export type {
  ScheduleEvaluatorConfig,
  ScheduleEvaluatorLogger,
  ScheduleJobCreator,
} from './schedule-evaluator.js';

// Circuit breaker (Phase 9.6)
export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitBreakerConfig } from './circuit-breaker.js';

// Standing rules (Phase 9.6)
export { StandingRuleEvaluator } from './standing-rules.js';
export type { StandingRule, StandingRuleEvaluatorConfig } from './standing-rules.js';

// Consistency scanner (Phase 9.6)
export { ConsistencyScanner } from './consistency-scanner.js';
export type {
  ConsistencyIssue,
  ConsistencyScanResult,
  ConsistencyScannerConfig,
} from './consistency-scanner.js';

// DAG executor (Phase 9.9)
export { DagExecutor } from './dag-executor.js';
export type {
  StepResult,
  DagExecutionResult,
  StepExecutor,
  DagExecutorConfig,
} from './dag-executor.js';

// Condition evaluator (Phase 9.9)
export { ConditionEvaluator } from './condition-evaluator.js';
export type { StepResultRef } from './condition-evaluator.js';

// Memory watchdog (Section 11.4)
export { MemoryWatchdog } from './memory-watchdog.js';
export type {
  MemoryWatchdogLogger,
  MemoryWatchdogOptions,
  MemoryPressureLevel,
  MemorySnapshot,
  MemoryPressureCallback,
} from './memory-watchdog.js';
