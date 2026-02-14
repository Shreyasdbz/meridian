// @meridian/shared — Core type definitions
// Follows the typed-with-metadata pattern: required fields for routing/execution,
// typed optional fields for common properties, metadata for ad-hoc content.

// ---------------------------------------------------------------------------
// Primitive types & enums (union types, not TS enums)
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'pending'
  | 'planning'
  | 'validating'
  | 'awaiting_approval'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type JobPriority = 'low' | 'normal' | 'high' | 'critical';

export type JobSource = 'user' | 'schedule' | 'webhook' | 'sub-job';

export type ComponentId = 'bridge' | 'scout' | 'sentinel' | 'journal' | `gear:${string}`;

export type AxisMessageType =
  | 'plan.request'
  | 'plan.response'
  | 'validate.request'
  | 'validate.response'
  | 'execute.request'
  | 'execute.response'
  | 'reflect.request'
  | 'reflect.response'
  | 'approve.request'
  | 'approve.response'
  | 'status.update'
  | 'error';

export type ValidationVerdict = 'approved' | 'rejected' | 'needs_user_approval' | 'needs_revision';

export type StepValidationVerdict = 'approved' | 'rejected' | 'needs_user_approval';

export type SentinelVerdict = 'allow' | 'deny';

export type GearOrigin = 'builtin' | 'user' | 'journal';

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type ConversationStatus = 'active' | 'archived';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageModality = 'text' | 'voice' | 'image' | 'video';

export type AuditActor = 'user' | 'scout' | 'sentinel' | 'axis' | 'gear';

export type ExecutionStepStatus = 'started' | 'completed' | 'failed';

export type FactCategory = 'user_preference' | 'environment' | 'knowledge';

export type ProcedureCategory = 'strategy' | 'pattern' | 'workflow';

export type NotificationLevel = 'info' | 'warning' | 'error';

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/**
 * Job — the fundamental unit of work in Meridian (Section 5.1.2).
 */
export interface Job {
  // Required (Axis lifecycle management)
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;

  // Typed optional
  conversationId?: string;
  parentId?: string;
  priority?: JobPriority;
  source?: JobSource;
  workerId?: string;
  plan?: ExecutionPlan;
  validation?: ValidationResult;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retriable: boolean };
  attempts?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  completedAt?: string;
  revisionCount?: number;
  replanCount?: number;
  dedupHash?: string;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * ExecutionPlan — structured plan produced by Scout (Section 5.2.2).
 */
export interface ExecutionPlan {
  // Required (Axis routing and execution)
  id: string;
  jobId: string;
  steps: ExecutionStep[];

  // Typed optional
  reasoning?: string;
  estimatedDurationMs?: number;
  estimatedCost?: { amount: number; currency: string };
  journalSkip?: boolean;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * StepCondition — conditional execution for steps (v0.2).
 */
export interface StepCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'exists';
  value?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * ExecutionStep — a single step within an execution plan (Section 5.2.2).
 */
export interface ExecutionStep {
  // Required (Axis dispatches to Gear)
  id: string;
  gear: string;
  action: string;
  parameters: Record<string, unknown>;

  // Required (Sentinel validation)
  riskLevel: RiskLevel;

  // Typed optional
  description?: string;
  order?: number;
  dependsOn?: string[];
  parallelGroup?: string;
  rollback?: string;
  condition?: StepCondition;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * ValidationResult — Sentinel's assessment of a plan (Section 5.3.3).
 */
export interface ValidationResult {
  // Required (Axis needs these to route the job)
  id: string;
  planId: string;
  verdict: ValidationVerdict;
  stepResults: StepValidation[];

  // Typed optional
  overallRisk?: RiskLevel;
  reasoning?: string;
  suggestedRevisions?: string;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * StepValidation — per-step validation result from Sentinel (Section 5.3.3).
 */
export interface StepValidation {
  // Required
  stepId: string;
  verdict: StepValidationVerdict;

  // Typed optional
  category?: string;
  riskLevel?: RiskLevel;
  reasoning?: string;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * AxisMessage — inter-component message routed through Axis (Section 9.1).
 */
export interface AxisMessage {
  // Required
  id: string;
  correlationId: string;
  timestamp: string;
  from: ComponentId;
  to: ComponentId;
  type: AxisMessageType;

  // Required for Gear messages only
  signature?: string;

  // Typed optional
  payload?: Record<string, unknown>;
  replyTo?: string;
  jobId?: string;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * Handler function for processing messages dispatched through Axis.
 * Each component registers one of these during startup (Section 5.1.14).
 */
export type MessageHandler = (
  message: AxisMessage,
  signal: AbortSignal,
) => Promise<AxisMessage>;

/**
 * Interface for component registration with Axis (Section 5.1.14).
 *
 * Core components (Scout, Sentinel, Journal, Bridge) register message handlers
 * with Axis during startup and unregister during shutdown. This interface
 * lives in shared/ so components can depend on it without importing axis/.
 */
export interface ComponentRegistry {
  register(componentId: ComponentId, handler: MessageHandler): void;
  unregister(componentId: ComponentId): void;
  has(componentId: ComponentId): boolean;
}

/**
 * GearManifest — declarative permission manifest for a Gear plugin (Section 5.6.2).
 */
export interface GearManifest {
  // Identity
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  repository?: string;

  // Capabilities
  actions: GearAction[];

  // Permissions
  permissions: GearPermissions;

  // Resource limits
  resources?: GearResources;

  // Provenance
  origin: GearOrigin;
  signature?: string;
  checksum: string;
  draft?: boolean;
}

export interface GearPermissions {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  network?: {
    domains?: string[];
    protocols?: string[];
  };
  secrets?: string[];
  shell?: boolean;
  environment?: string[];
}

export interface GearResources {
  maxMemoryMb?: number;
  maxCpuPercent?: number;
  timeoutMs?: number;
  maxNetworkBytesPerCall?: number;
}

/**
 * GearAction — a single action a Gear can perform (Section 5.6.2).
 * `parameters` and `returns` are JSON Schema objects.
 */
export interface GearAction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  returns: Record<string, unknown>;
  riskLevel: RiskLevel;
}

/**
 * GearContext — constrained API surface available to Gear code (Section 9.3).
 */
export interface GearContext {
  params: Record<string, unknown>;
  getSecret(name: string): Promise<string | undefined>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  fetch(url: string, options?: FetchOptions): Promise<FetchResponse>;
  log(message: string): void;
  progress(percent: number, message?: string): void;
  createSubJob(description: string): Promise<JobResult>;
  executeCommand?(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * FetchOptions — options for GearContext.fetch().
 */
export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

/**
 * FetchResponse — response from GearContext.fetch().
 */
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * JobResult — result returned from createSubJob().
 */
export interface JobResult {
  jobId: string;
  status: JobStatus;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retriable: boolean };
}

// ---------------------------------------------------------------------------
// WebSocket messages — discriminated union (Section 9.2)
// ---------------------------------------------------------------------------

export type WSMessage =
  | WSChunkMessage
  | WSStatusMessage
  | WSApprovalRequiredMessage
  | WSResultMessage
  | WSErrorMessage
  | WSNotificationMessage
  | WSProgressMessage
  | WSConnectedMessage
  | WSPingMessage
  | WSPongMessage
  | WSGearBriefMessage;

export interface WSChunkMessage {
  type: 'chunk';
  jobId: string;
  content: string;
  done: boolean;
  metadata?: Record<string, unknown>;
}

export interface WSStatusMessage {
  type: 'status';
  jobId: string;
  status: JobStatus;
  step?: string;
  metadata?: Record<string, unknown>;
}

export interface WSApprovalRequiredMessage {
  type: 'approval_required';
  jobId: string;
  plan: ExecutionPlan;
  risks: StepValidation[];
  metadata?: Record<string, unknown>;
}

export interface WSResultMessage {
  type: 'result';
  jobId: string;
  result: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WSErrorMessage {
  type: 'error';
  jobId?: string;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WSNotificationMessage {
  type: 'notification';
  level: NotificationLevel;
  message: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

export interface WSProgressMessage {
  type: 'progress';
  jobId: string;
  percent: number;
  step?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface WSConnectedMessage {
  type: 'connected';
  sessionId: string;
  metadata?: Record<string, unknown>;
}

export interface WSPingMessage {
  type: 'ping';
  metadata?: Record<string, unknown>;
}

export interface WSPongMessage {
  type: 'pong';
  metadata?: Record<string, unknown>;
}

export interface WSGearBriefMessage {
  type: 'gear_brief';
  briefId: string;
  problem: string;
  proposedSolution: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Model routing (Section 5.2.6 — v0.4 adaptive model selection)
// ---------------------------------------------------------------------------

export type ModelTier = 'primary' | 'secondary';

export type TaskComplexity =
  | 'simple_gear_op'
  | 'summarization'
  | 'parsing'
  | 'parameter_generation'
  | 'multi_step_planning'
  | 'complex_reasoning'
  | 'replanning'
  | 'novel_request';

export interface ModelRoutingDecision {
  tier: ModelTier;
  model: string;
  reason: string;
  taskComplexity: TaskComplexity;
}

// ---------------------------------------------------------------------------
// Semantic cache (Section 11.2 — v0.4)
// ---------------------------------------------------------------------------

export interface SemanticCacheEntry {
  id: string;
  queryEmbedding: number[];
  response: string;
  model: string;
  createdAt: string;
  expiresAt: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plan replay cache (Section 16 Phase 4 — v0.4)
// ---------------------------------------------------------------------------

export interface PlanReplayCacheEntry {
  id: string;
  inputHash: string;
  plan: ExecutionPlan;
  approvalHash?: string;
  createdAt: string;
  hitCount: number;
  lastHitAt: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP compatibility (Section 9.4 — v0.4)
// ---------------------------------------------------------------------------

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Voice input (Section 5.5.9 — v0.4)
// ---------------------------------------------------------------------------

export interface VoiceTranscriptionResult {
  text: string;
  confidence: number;
  durationMs: number;
  language?: string;
}

// ---------------------------------------------------------------------------
// Audit (Section 6.6)
// ---------------------------------------------------------------------------

/**
 * AuditEntry — append-only audit log entry (Section 6.6).
 */
export interface AuditEntry {
  // Required
  id: string;
  timestamp: string;
  actor: AuditActor;
  action: string;
  riskLevel: RiskLevel;

  // Typed optional
  actorId?: string;
  target?: string;
  jobId?: string;
  previousHash?: string;
  entryHash?: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sentinel Memory (Section 5.3.8)
// ---------------------------------------------------------------------------

/**
 * SentinelDecision — stored approval/denial decision (Section 5.3.8).
 */
export interface SentinelDecision {
  // Required
  id: string;
  actionType: string;
  scope: string;
  verdict: SentinelVerdict;

  // Typed optional
  createdAt?: string;
  expiresAt?: string;
  conditions?: string;
  jobId?: string;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Journal / Memory (Section 5.4.5)
// ---------------------------------------------------------------------------

/**
 * MemoryQuery — query for retrieving memories from Journal (Section 5.4.5).
 */
export interface MemoryQuery {
  // Required
  text: string;

  // Typed optional
  types?: MemoryType[];
  maxResults?: number;
  minRelevance?: number;
  timeRange?: { start?: string; end?: string };

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

/**
 * MemoryResult — a single memory retrieval result (Section 5.4.5).
 */
export interface MemoryResult {
  // Required
  id: string;
  type: MemoryType;
  content: string;
  relevanceScore: number;

  // Typed optional
  createdAt?: string;
  updatedAt?: string;
  source?: string;
  linkedGearId?: string;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Authentication (Section 6.3)
// ---------------------------------------------------------------------------

/**
 * Session — a user session stored in meridian.db (Section 6.3).
 */
export interface Session {
  id: string;
  tokenHash: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastActiveAt: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * AuthContext — attached to authenticated requests by middleware.
 */
export interface AuthContext {
  sessionId: string;
  csrfToken: string;
}

/**
 * LoginResult — returned from a login attempt.
 */
export interface LoginResult {
  success: boolean;
  session?: Session;
  token?: string;
  error?: string;
  retryAfterMs?: number;
}

/**
 * BruteForceStatus — current state of brute-force protection for an IP.
 */
export interface BruteForceStatus {
  allowed: boolean;
  recentFailures: number;
  retryAfterMs?: number;
  lockedOut: boolean;
}

// ---------------------------------------------------------------------------
// Secrets (Section 6.4)
// ---------------------------------------------------------------------------

/**
 * Secret — encrypted credential with ACL (Section 6.4).
 */
export interface Secret {
  name: string;
  encryptedValue: Buffer;
  allowedGear: string[];
  createdAt: string;
  lastUsedAt: string;
  rotateAfterDays?: number;
}

// ---------------------------------------------------------------------------
// LLM Provider (Section 5.2.4)
// ---------------------------------------------------------------------------

/**
 * LLMProvider — abstraction over LLM API providers (Section 5.2.4).
 */
export interface LLMProvider {
  id: string;
  name: string;
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  estimateTokens(text: string): number;
  maxContextTokens: number;
}

/**
 * ToolDefinition — describes a tool available to the LLM (Section 5.2.5).
 * Used to translate Gear actions into provider-native tool schemas.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * ToolCall — a tool invocation returned by the LLM (Section 5.2.5).
 * Provider adapters parse native tool call responses into this format.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * ChatRequest — input to LLMProvider.chat().
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

/**
 * ChatMessage — a single message in a chat conversation for LLM.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * ChatChunk — a single chunk from a streaming LLM response.
 */
export interface ChatChunk {
  content: string;
  done: boolean;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Conversation & Message (Section 8.3)
// ---------------------------------------------------------------------------

/**
 * Conversation — a user conversation session.
 */
export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Message — a single message within a conversation.
 */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;

  // Typed optional
  jobId?: string;
  modality?: MessageModality;
  attachments?: MessageAttachment[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * MessageAttachment — an attachment on a message.
 */
export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}
