// @meridian/axis — public API

// Component registry
export { ComponentRegistry } from './registry.js';
export type { MessageHandler } from './registry.js';

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
