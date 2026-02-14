// @meridian/shared — public API

// Types
export type {
  // Primitive types & unions
  JobStatus,
  RiskLevel,
  JobPriority,
  JobSource,
  ComponentId,
  AxisMessageType,
  ValidationVerdict,
  StepValidationVerdict,
  SentinelVerdict,
  GearOrigin,
  MemoryType,
  ConversationStatus,
  MessageRole,
  MessageModality,
  AuditActor,
  ExecutionStepStatus,
  FactCategory,
  ProcedureCategory,
  NotificationLevel,

  // Core interfaces
  Job,
  ExecutionPlan,
  ExecutionStep,
  StepCondition,
  ValidationResult,
  StepValidation,
  AxisMessage,
  MessageHandler,
  ComponentRegistry,
  GearManifest,
  GearPermissions,
  GearResources,
  GearAction,
  GearContext,
  FetchOptions,
  FetchResponse,
  JobResult,

  // WebSocket messages
  WSMessage,
  WSChunkMessage,
  WSStatusMessage,
  WSApprovalRequiredMessage,
  WSResultMessage,
  WSErrorMessage,
  WSNotificationMessage,
  WSProgressMessage,
  WSConnectedMessage,
  WSPingMessage,
  WSPongMessage,
  WSGearBriefMessage,

  // Model routing (v0.4)
  ModelTier,
  ModelRoutingDecision,
  TaskComplexity,

  // Semantic cache (v0.4)
  SemanticCacheEntry,

  // Plan replay cache (v0.4)
  PlanReplayCacheEntry,

  // MCP compatibility (v0.4)
  MCPToolDefinition,
  MCPServerConfig,

  // Voice input (v0.4)
  VoiceTranscriptionResult,

  // Audit
  AuditEntry,

  // Sentinel
  SentinelDecision,

  // Journal / Memory
  MemoryQuery,
  MemoryResult,

  // Authentication
  Session,
  AuthContext,
  LoginResult,
  BruteForceStatus,

  // Secrets
  Secret,

  // LLM
  LLMProvider,
  ToolDefinition,
  ToolCall,
  ChatRequest,
  ChatMessage,
  ChatChunk,

  // Conversation
  Conversation,
  Message,
  MessageAttachment,
} from './types.js';

// Result type
export type { Result } from './result.js';
export { ok, err, isOk, isErr, unwrap, unwrapOr, map, mapErr } from './result.js';

// Errors
export {
  MeridianError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  TimeoutError,
  RateLimitError,
  GearSandboxError,
  LLMProviderError,
  PlanValidationError,
  SecretAccessError,
} from './errors.js';

// ID generation
export { generateId } from './id.js';

// Constants
export {
  // Job lifecycle limits
  MAX_REVISION_COUNT,
  MAX_REPLAN_COUNT,
  MAX_STEP_ATTEMPTS,
  DEFAULT_MAX_ATTEMPTS,

  // Timeouts
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_PLANNING_TIMEOUT_MS,
  DEFAULT_VALIDATION_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  LLM_FIRST_TOKEN_TIMEOUT_MS,
  LLM_STALL_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GEAR_KILL_TIMEOUT_MS,
  DEFAULT_CONVERSATION_TIMEOUT_MS,

  // Deduplication
  DEDUP_WINDOW_MS,

  // Message size
  MAX_MESSAGE_SIZE_BYTES,
  MESSAGE_WARNING_THRESHOLD_BYTES,

  // Circuit breaker
  CIRCUIT_BREAKER_FAILURES,
  CIRCUIT_BREAKER_WINDOW_MS,

  // Watchdog
  WATCHDOG_BLOCK_THRESHOLD_MS,

  // WebSocket
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  MAX_MISSED_PONGS,
  WS_RATE_LIMIT_PER_MINUTE,
  WS_REVALIDATION_INTERVAL_MS,
  WS_CONNECTION_TOKEN_BYTES,
  WS_CONNECTION_TOKEN_TTL_MS,

  // API rate limiting
  API_RATE_LIMIT_PER_MINUTE,

  // Authentication
  DEFAULT_SESSION_DURATION_HOURS,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_LOCKOUT,
  BRUTE_FORCE_LOCKOUT_DURATION_MINUTES,
  BCRYPT_SALT_ROUNDS,
  SESSION_TOKEN_BYTES,
  CSRF_TOKEN_BYTES,
  APPROVAL_NONCE_BYTES,
  APPROVAL_NONCE_TTL_HOURS,

  // Sentinel Memory
  SENTINEL_MEMORY_CAP,

  // Gear resource limits
  DEFAULT_GEAR_MEMORY_MB,
  DEFAULT_GEAR_CPU_PERCENT,
  DEFAULT_GEAR_TIMEOUT_MS,

  // Context window budgets
  SYSTEM_PROMPT_TOKEN_BUDGET,
  CONVERSATION_TOKEN_BUDGET,
  MEMORY_TOKEN_BUDGET,
  DEFAULT_CONTEXT_MESSAGES,
  DEFAULT_MEMORY_TOP_K,

  // Token & cost limits
  DEFAULT_JOB_TOKEN_BUDGET,
  DEFAULT_DAILY_COST_LIMIT_USD,

  // Standing rule suggestion
  STANDING_RULE_SUGGESTION_COUNT,

  // Event loop monitoring
  EVENT_LOOP_P99_WARN_MS,
  EVENT_LOOP_P99_ERROR_MS,

  // Disk monitoring
  DISK_USAGE_WARN_PERCENT,
  DISK_USAGE_PAUSE_PERCENT,

  // Connection limits
  MAX_CONCURRENT_GEAR_DESKTOP,
  MAX_CONCURRENT_GEAR_PI,
  MAX_WS_CONNECTIONS_DESKTOP,
  MAX_WS_CONNECTIONS_PI,
  MAX_LLM_STREAMS_DESKTOP,
  MAX_LLM_STREAMS_PI,

  // Worker counts
  DEFAULT_WORKERS_PI,
  DEFAULT_WORKERS_DESKTOP,
  DEFAULT_WORKERS_VPS,

  // Polling & scheduling
  QUEUE_POLL_INTERVAL_MS,
  SCHEDULE_EVAL_INTERVAL_MS,

  // Startup diagnostics
  MIN_DISK_SPACE_MB,
  MIN_RAM_MB,

  // Memory watchdog
  MEMORY_RSS_WARN_PERCENT,
  MEMORY_RSS_PAUSE_PERCENT,
  MEMORY_RSS_REJECT_PERCENT,
  MEMORY_EMERGENCY_FREE_MB,

  // Cost alerts
  COST_ALERT_WARN_PERCENT,
  COST_ALERT_CRITICAL_PERCENT,

  // Replay protection
  REPLAY_WINDOW_MS,

  // Maintenance
  FTS_REBUILD_INTERVAL_DAYS,

  // Semantic cache
  SEMANTIC_CACHE_SIMILARITY_THRESHOLD,
  SEMANTIC_CACHE_TTL_MS,
  SEMANTIC_CACHE_MAX_ENTRIES,

  // Plan replay cache
  PLAN_REPLAY_CACHE_MAX_ENTRIES,
  PLAN_REPLAY_CACHE_TTL_MS,

  // Sentinel approval cache
  SENTINEL_APPROVAL_CACHE_MAX_ENTRIES,
  SENTINEL_APPROVAL_CACHE_TTL_MS,

  // Voice input
  MAX_VOICE_UPLOAD_BYTES,
  VOICE_TRANSCRIPTION_TIMEOUT_MS,

  // TOTP
  TOTP_PERIOD_SECONDS,
  TOTP_DIGITS,
  TOTP_ALGORITHM,

  // Data retention
  RETENTION_CONVERSATION_DAYS,
  RETENTION_EPISODIC_DAYS,
  RETENTION_EXECUTION_LOG_DAYS,
  RETENTION_AUDIT_MONTHS,

  // Backup rotation
  BACKUP_DAILY_COUNT,
  BACKUP_WEEKLY_COUNT,
  BACKUP_MONTHLY_COUNT,
} from './constants.js';

// Database infrastructure
export type { DatabaseName, DeploymentTier, RunResult } from './database/index.js';
export { DatabaseClient } from './database/index.js';
export type { DatabaseClientOptions } from './database/index.js';
export { configureConnection } from './database/index.js';
export { discoverMigrations, getCurrentVersion, migrate, migrateAll } from './database/index.js';
export type { MigrationFile, MigrationResult } from './database/index.js';

// Configuration
export type {
  AxisConfig,
  ScoutModelsConfig,
  ScoutConfig,
  SentinelConfig,
  JournalConfig,
  BridgeConfig,
  SecurityConfig,
  MeridianConfig,
  DeepPartial,
  LoadConfigOptions,
} from './config.js';
export { loadConfig, getDefaultConfig, detectDeploymentTier } from './config.js';

// Logging
export type { LogLevel, LogEntry, LogOutput, LoggerOptions } from './logger.js';
export { Logger, createLogger, redact } from './logger.js';

// Secrets vault
export type { SecretMetadata, SecretRotationWarning } from './secrets.js';
export { SecretsVault } from './secrets.js';

// Cost tracking (Phase 9.5)
export { CostTracker } from './cost-tracker.js';
export type {
  CostTrackerConfig,
  CostTrackerLogger,
  LLMCallRecord,
  DailyCostSummary,
  JobCostSummary,
  CostAlertLevel,
} from './cost-tracker.js';

// Cron scheduling (Phase 9.4)
export {
  parseCronExpression,
  isValidCronExpression,
  getNextRun,
} from './cron-parser.js';
export type { CronSchedule } from './cron-parser.js';

// Ed25519 signing (Section 6.3, v0.2)
export type {
  Ed25519Keypair,
  SignedEnvelope,
  SigningServiceOptions,
  VerificationResult,
} from './signing.js';
export {
  generateKeypair,
  generateEphemeralKeypair,
  zeroPrivateKey,
  signPayload,
  verifyPayload,
  ReplayGuard,
  KeyRegistry,
  SigningService,
} from './signing.js';

// Data retention (Phase 10.6)
export { applyRetention, computeCutoffDate } from './retention.js';
export type {
  RetentionLogger,
  RetentionOptions,
  RetentionResult,
} from './retention.js';

// Right to deletion (Phase 10.6)
export { deleteAllUserData } from './data-deletion.js';
export type {
  DataDeletionLogger,
  DataDeletionOptions,
  DataDeletionResult,
} from './data-deletion.js';
