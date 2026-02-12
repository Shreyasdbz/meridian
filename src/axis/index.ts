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
