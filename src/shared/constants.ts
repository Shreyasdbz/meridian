// @meridian/shared — Constants
// All values are derived from the architecture document (docs/knowledge/architecture.md).

// ---------------------------------------------------------------------------
// Job lifecycle limits (Section 5.1.3)
// ---------------------------------------------------------------------------

/** Maximum plan revision cycles per job (Scout <-> Sentinel) */
export const MAX_REVISION_COUNT = 3;

/** Maximum replanning attempts per job lifetime */
export const MAX_REPLAN_COUNT = 2;

/** Maximum retry attempts per individual execution step */
export const MAX_STEP_ATTEMPTS = 3;

/** Default maximum retry attempts for a job */
export const DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Timeouts (Section 5.1.10)
// ---------------------------------------------------------------------------

/** Default overall job timeout (5 minutes) */
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/** Default planning phase timeout (1 minute) */
export const DEFAULT_PLANNING_TIMEOUT_MS = 60_000;

/** Default validation phase timeout (30 seconds) */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 30_000;

/** Default per-step execution timeout (1 minute) */
export const DEFAULT_STEP_TIMEOUT_MS = 60_000;

/** LLM first token timeout (30 seconds) */
export const LLM_FIRST_TOKEN_TIMEOUT_MS = 30_000;

/** LLM stall timeout between consecutive streamed tokens (30 seconds) */
export const LLM_STALL_TIMEOUT_MS = 30_000;

/** Graceful shutdown timeout (30 seconds) */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

/** Gear kill timeout during shutdown (10 seconds) */
export const GEAR_KILL_TIMEOUT_MS = 10_000;

/** Default conversation inactivity timeout (30 minutes) */
export const DEFAULT_CONVERSATION_TIMEOUT_MS = 1_800_000;

// ---------------------------------------------------------------------------
// Deduplication (Section 5.1.9)
// ---------------------------------------------------------------------------

/** Dedup time window for request hashing (5 seconds) */
export const DEDUP_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// Message size limits (Section 5.1.13)
// ---------------------------------------------------------------------------

/** Maximum serialized message size (1 MB) */
export const MAX_MESSAGE_SIZE_BYTES = 1_048_576;

/** Warning threshold for message size (100 KB) */
export const MESSAGE_WARNING_THRESHOLD_BYTES = 102_400;

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/** Number of failures before circuit opens */
export const CIRCUIT_BREAKER_FAILURES = 3;

/** Time window for counting circuit breaker failures (5 minutes) */
export const CIRCUIT_BREAKER_WINDOW_MS = 300_000;

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

/** Event loop block threshold for watchdog (10 seconds) */
export const WATCHDOG_BLOCK_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------------------
// WebSocket (Section 6.5.2)
// ---------------------------------------------------------------------------

/** WebSocket ping interval (30 seconds) */
export const WS_PING_INTERVAL_MS = 30_000;

/** WebSocket pong timeout (10 seconds) */
export const WS_PONG_TIMEOUT_MS = 10_000;

/** Maximum missed pongs before disconnecting */
export const MAX_MISSED_PONGS = 2;

/** WebSocket rate limit (messages per minute per connection) */
export const WS_RATE_LIMIT_PER_MINUTE = 60;

/** WebSocket session re-validation interval (15 minutes) */
export const WS_REVALIDATION_INTERVAL_MS = 900_000;

// ---------------------------------------------------------------------------
// API rate limiting
// ---------------------------------------------------------------------------

/** API rate limit (requests per minute) */
export const API_RATE_LIMIT_PER_MINUTE = 100;

// ---------------------------------------------------------------------------
// Authentication (Section 6.5)
// ---------------------------------------------------------------------------

/** Default session duration (7 days, in hours) */
export const DEFAULT_SESSION_DURATION_HOURS = 168;

/** Brute-force protection: failed attempts before exponential backoff */
export const BRUTE_FORCE_THRESHOLD = 5;

/** Brute-force protection: full lockout after this many failures */
export const BRUTE_FORCE_LOCKOUT = 20;

/** Brute-force protection: lockout duration (minutes) */
export const BRUTE_FORCE_LOCKOUT_DURATION_MINUTES = 30;

/** Bcrypt salt rounds for password hashing */
export const BCRYPT_SALT_ROUNDS = 12;

/** Session token size in bytes (produces 64-char hex string) */
export const SESSION_TOKEN_BYTES = 32;

/** CSRF token size in bytes (produces 64-char hex string) */
export const CSRF_TOKEN_BYTES = 32;

/** Approval nonce size in bytes (produces 64-char hex string) */
export const APPROVAL_NONCE_BYTES = 32;

/** Approval nonce TTL in hours — stale/consumed nonces older than this are purged */
export const APPROVAL_NONCE_TTL_HOURS = 24;

// ---------------------------------------------------------------------------
// Sentinel Memory (Section 5.3.8)
// ---------------------------------------------------------------------------

/** Maximum active (non-expired) sentinel decisions */
export const SENTINEL_MEMORY_CAP = 500;

// ---------------------------------------------------------------------------
// Default Gear resource limits (Section 5.6.2)
// ---------------------------------------------------------------------------

/** Default Gear memory limit (256 MB) */
export const DEFAULT_GEAR_MEMORY_MB = 256;

/** Default Gear CPU limit (50%) */
export const DEFAULT_GEAR_CPU_PERCENT = 50;

/** Default Gear execution timeout (5 minutes) */
export const DEFAULT_GEAR_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Context window budgets (Section 5.2.3)
// ---------------------------------------------------------------------------

/** System prompt token budget */
export const SYSTEM_PROMPT_TOKEN_BUDGET = 2_000;

/** Conversation history token budget */
export const CONVERSATION_TOKEN_BUDGET = 4_000;

/** Memory retrieval token budget */
export const MEMORY_TOKEN_BUDGET = 2_000;

/** Default number of recent conversation messages to include */
export const DEFAULT_CONTEXT_MESSAGES = 20;

/** Default top-K results for memory retrieval */
export const DEFAULT_MEMORY_TOP_K = 5;

// ---------------------------------------------------------------------------
// Token & cost limits (Section 6.2)
// ---------------------------------------------------------------------------

/** Per-job token limit */
export const DEFAULT_JOB_TOKEN_BUDGET = 100_000;

/** Default daily cost limit (USD) */
export const DEFAULT_DAILY_COST_LIMIT_USD = 5.0;

// ---------------------------------------------------------------------------
// Standing rule suggestion (Section 5.5.3)
// ---------------------------------------------------------------------------

/** Number of same-category approvals before suggesting a standing rule */
export const STANDING_RULE_SUGGESTION_COUNT = 5;

// ---------------------------------------------------------------------------
// Event loop monitoring (Section 11.4)
// ---------------------------------------------------------------------------

/** Event loop p99 warning threshold (ms) */
export const EVENT_LOOP_P99_WARN_MS = 50;

/** Event loop p99 error threshold (ms) */
export const EVENT_LOOP_P99_ERROR_MS = 200;

// ---------------------------------------------------------------------------
// Disk monitoring (Section 11.3)
// ---------------------------------------------------------------------------

/** Disk usage warning threshold (percent) */
export const DISK_USAGE_WARN_PERCENT = 80;

/** Disk usage pause threshold (percent) */
export const DISK_USAGE_PAUSE_PERCENT = 90;

// ---------------------------------------------------------------------------
// Connection limits per tier (Section 11.4)
// ---------------------------------------------------------------------------

/** Maximum concurrent Gear sandboxes — desktop/VPS */
export const MAX_CONCURRENT_GEAR_DESKTOP = 4;

/** Maximum concurrent Gear sandboxes — Raspberry Pi */
export const MAX_CONCURRENT_GEAR_PI = 2;

/** Maximum WebSocket connections — desktop/VPS */
export const MAX_WS_CONNECTIONS_DESKTOP = 10;

/** Maximum WebSocket connections — Raspberry Pi */
export const MAX_WS_CONNECTIONS_PI = 4;

/** Maximum concurrent LLM streams — desktop/VPS */
export const MAX_LLM_STREAMS_DESKTOP = 3;

/** Maximum concurrent LLM streams — Raspberry Pi */
export const MAX_LLM_STREAMS_PI = 1;

// ---------------------------------------------------------------------------
// Worker counts per tier (Section 5.1.4)
// ---------------------------------------------------------------------------

/** Default worker count — Raspberry Pi */
export const DEFAULT_WORKERS_PI = 2;

/** Default worker count — desktop/Mac Mini */
export const DEFAULT_WORKERS_DESKTOP = 4;

/** Default worker count — VPS */
export const DEFAULT_WORKERS_VPS = 8;

// ---------------------------------------------------------------------------
// Polling & scheduling intervals (Section 5.1.5, 5.1.6)
// ---------------------------------------------------------------------------

/** Job queue polling interval (ms) */
export const QUEUE_POLL_INTERVAL_MS = 100;

/** Schedule evaluation interval (ms, 1 minute) */
export const SCHEDULE_EVAL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Startup self-diagnostic (Section 5.1.15)
// ---------------------------------------------------------------------------

/** Minimum disk space for startup (MB) */
export const MIN_DISK_SPACE_MB = 500;

/** Minimum available RAM for startup (MB) */
export const MIN_RAM_MB = 1024;

// ---------------------------------------------------------------------------
// Memory watchdog (Section 11.4)
// ---------------------------------------------------------------------------

/** RSS warning threshold (percent of budget) */
export const MEMORY_RSS_WARN_PERCENT = 70;

/** RSS pause threshold (percent of budget) */
export const MEMORY_RSS_PAUSE_PERCENT = 80;

/** RSS reject threshold (percent of budget) */
export const MEMORY_RSS_REJECT_PERCENT = 90;

/** Emergency free memory threshold (MB) */
export const MEMORY_EMERGENCY_FREE_MB = 256;

// ---------------------------------------------------------------------------
// Cost alert thresholds (Section 11.2)
// ---------------------------------------------------------------------------

/** Cost alert warning threshold (percent of daily limit) */
export const COST_ALERT_WARN_PERCENT = 80;

/** Cost alert critical threshold (percent of daily limit) */
export const COST_ALERT_CRITICAL_PERCENT = 95;

// ---------------------------------------------------------------------------
// Replay protection (Section 6.3, used in v0.2)
// ---------------------------------------------------------------------------

/** Replay window for message ID dedup (ms) */
export const REPLAY_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Maintenance intervals
// ---------------------------------------------------------------------------

/** FTS rebuild interval (days, Section 8.3) */
export const FTS_REBUILD_INTERVAL_DAYS = 7;

// ---------------------------------------------------------------------------
// Semantic cache (Section 11.2, used in v0.4)
// ---------------------------------------------------------------------------

/** Similarity threshold for semantic cache hits */
export const SEMANTIC_CACHE_SIMILARITY_THRESHOLD = 0.98;

// ---------------------------------------------------------------------------
// Data retention defaults (Section 7.4)
// ---------------------------------------------------------------------------

/** Conversation message retention (days) */
export const RETENTION_CONVERSATION_DAYS = 90;

/** Episodic memory retention (days) */
export const RETENTION_EPISODIC_DAYS = 90;

/** Execution log retention (days) */
export const RETENTION_EXECUTION_LOG_DAYS = 30;

/** Audit log retention (months) */
export const RETENTION_AUDIT_MONTHS = 12;

// ---------------------------------------------------------------------------
// Backup rotation (Section 8.4)
// ---------------------------------------------------------------------------

/** Number of daily backups to keep */
export const BACKUP_DAILY_COUNT = 7;

/** Number of weekly backups to keep */
export const BACKUP_WEEKLY_COUNT = 4;

/** Number of monthly backups to keep */
export const BACKUP_MONTHLY_COUNT = 3;
