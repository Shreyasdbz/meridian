# Meridian Development Implementation Plan

> **Source of Truth**: `docs/knowledge/architecture.md` v2.0 (2026-02-10)
> **Created**: 2026-02-11
> **Structure**: 11 major phases, each subdivided into PR-sized sub-phases (66 sub-phases total)
> **Total Estimated Scope**: v0.1 through v0.4 (20-28 weeks per architecture roadmap)
> **Validation**: Verified via 7 distinct passes (factual accuracy, completeness, organization, internal consistency, exhaustive architecture cross-reference, deep schema/interface/API field-level audit, security & safety deep audit) against the architecture document

---

## Table of Contents

- [Phase 1: Project Foundation & Shared Module](#phase-1-project-foundation--shared-module)
- [Phase 2: Axis — Runtime & Scheduler](#phase-2-axis--runtime--scheduler)
- [Phase 3: Scout — Planner LLM](#phase-3-scout--planner-llm)
- [Phase 4: Sentinel — Rule-Based Safety Validator (v0.1)](#phase-4-sentinel--rule-based-safety-validator-v01)
- [Phase 5: Gear — Plugin System](#phase-5-gear--plugin-system)
- [Phase 6: Bridge — Backend API](#phase-6-bridge--backend-api)
- [Phase 7: Bridge — Frontend SPA](#phase-7-bridge--frontend-spa)
- [Phase 8: Integration, End-to-End Flows & v0.1 Release](#phase-8-integration-end-to-end-flows--v01-release)
- [Phase 9: v0.2 — Safety, Scheduling & Observability](#phase-9-v02--safety-scheduling--observability)
- [Phase 10: v0.3 — Memory & Learning](#phase-10-v03--memory--learning)
- [Phase 11: v0.4 — Growth & Ecosystem](#phase-11-v04--growth--ecosystem)
- [Appendix A: Deferred Items & Feasibility Notes](#appendix-a-deferred-items--feasibility-notes)
- [Appendix B: Cross-Cutting Concerns](#appendix-b-cross-cutting-concerns)
- [Appendix C: Phase-to-Architecture Traceability](#appendix-c-phase-to-architecture-traceability)

---

## Phase 1: Project Foundation & Shared Module

**Goal**: Establish the project skeleton, tooling, CI pipeline, and the `shared/` module that every other component depends on. Nothing runs yet, but every subsequent PR builds on this foundation.

**Architecture References**: Sections 14 (Technology Stack), 15 (Development Principles), 8.1-8.2 (Storage), 5.1.2 (Job Model typed interfaces)

---

### Phase 1.1: Repository Skeleton & Tooling

**PR Scope**: Initialize the project structure, install dev dependencies, configure all tooling.

**Deliverables**:

- `package.json` with project metadata, scripts, and `"type": "module"` (ESM)
- `tsconfig.json` targeting ES2022, Node.js 20+, with path aliases (`@meridian/axis`, `@meridian/shared`, etc.)
- ESLint configuration:
  - TypeScript-ESLint rules (no `any`, explicit return types on exports)
  - `no-restricted-imports` rules enforcing module boundaries:
    - `shared/` imports nothing from other modules
    - `sentinel/` cannot import `journal/` (information barrier)
    - `axis/` cannot import LLM provider SDKs
    - No cross-module internal file imports (only through `index.ts`)
  - Import grouping and ordering rules (Node built-ins → external → internal → relative)
- Prettier configuration (2-space indent, single quotes, trailing commas, semicolons)
- Vitest configuration (`vitest.config.ts`)
- `dependency-cruiser` configuration (`.dependency-cruiser.cjs`) enforcing:
  - `shared/` depends on nothing
  - `axis/` depends on `shared/` only
  - `scout/` depends on `shared/` only
  - `sentinel/` depends on `shared/` only
  - `journal/` depends on `shared/` only
  - `gear/` depends on `shared/` only
  - `bridge/` depends on `shared/` only
  - No circular dependencies
- `.gitignore`, `.editorconfig`, `.nvmrc` (Node 20+)
- Directory structure created (empty `index.ts` barrel files):
  ```
  src/axis/
  src/scout/
  src/sentinel/
  src/journal/
  src/bridge/api/
  src/bridge/ui/
  src/gear/
  src/gear/builtin/
  src/shared/
  tests/integration/
  tests/security/
  tests/e2e/
  tests/evaluation/    (Section 13.6, populated in Phase 9.7)
  data/                (gitignored — created at application startup by Axis, not in repo skeleton)
  data/workspace/      (Section 8.2, created at startup)
  data/workspace/downloads/
  data/workspace/gear/
  data/workspace/projects/
  data/workspace/temp/
  docs/
  scripts/
  docker/
  ```
- npm scripts: `build`, `dev`, `test`, `lint`, `format`, `typecheck`
- `tsup` configuration for TypeScript bundling
- `.npmrc` with `ignore-scripts=true` (supply chain defense per Section 6.1.1)

**Acceptance Criteria**:

- `npm run lint` passes on empty project
- `npm run typecheck` passes
- `npm run test` runs Vitest (zero tests, zero failures)
- `dependency-cruiser` validates module boundary rules

---

### Phase 1.2: CI Pipeline

**PR Scope**: GitHub Actions CI configuration.

**Deliverables**:

- `.github/workflows/ci.yml`:
  - Runs on every push and PR
  - Matrix: Node.js 20.x on ubuntu-latest
  - Steps: install (with `--ignore-scripts`), typecheck, lint, test, dependency-cruiser validation
  - Lockfile integrity check (reject mismatched hashes)
  - `npm audit` for CVE scanning (fail on high/critical)
  - SBOM generation step (Section 6.1.1): generate Software Bill of Materials listing all transitive dependencies with versions and licenses
- Register `@meridian` npm scope to prevent dependency confusion attacks (Section 6.1.1) — **Operational**: requires manual registration on npmjs.org; not a code deliverable
- `.github/PULL_REQUEST_TEMPLATE.md`
- `SECURITY.md` with disclosure process (48h acknowledgment, 7-day assessment, 72h critical patch, 90-day coordinated disclosure)
- `LICENSE` (Apache-2.0)

**SKIP INTENTIONALLY:**

- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md` referencing conventions from architecture Section 15.3

**Acceptance Criteria**:

- CI runs green on an empty project
- PRs are blocked if any step fails — **Operational**: requires enabling GitHub branch protection rules (require status checks to pass before merging); not a code deliverable

---

### Phase 1.3: Shared Types & Constants

**PR Scope**: Core type definitions used across all components.

**Deliverables** (all in `src/shared/`):

- `types.ts` — Core interfaces following the **typed-with-metadata** pattern:
  - `Job` interface (Section 5.1.2): `id`, `status`, `createdAt`, `updatedAt` (required); `conversationId`, `parentId`, `priority`, `source`, `plan`, `validation`, `result`, `error`, `attempts`, `maxAttempts`, `timeoutMs`, `completedAt`, `revisionCount`, `replanCount`, `dedupHash` (typed optional); `metadata` (ad-hoc)
  - `JobStatus` type: `'pending' | 'planning' | 'validating' | 'awaiting_approval' | 'executing' | 'completed' | 'failed' | 'cancelled'`
  - `ExecutionPlan` interface (Section 5.2.2): `id`, `jobId`, `steps` (required); `reasoning`, `estimatedDurationMs`, `estimatedCost`, `journalSkip` (typed optional); `metadata` (ad-hoc)
  - `ExecutionStep` interface (Section 5.2.2): `id`, `gear`, `action`, `parameters`, `riskLevel` (required); `description`, `order`, `dependsOn`, `parallelGroup`, `rollback`, `condition` (typed optional); `metadata` (ad-hoc). Note: `dependsOn`, `parallelGroup`, and `condition` are defined in v0.1 types but fully utilized in v0.2 (Phase 9.9)
  - `ValidationResult` interface (Section 5.3.3): `id`, `planId`, `verdict`, `stepResults` (required); `overallRisk`, `reasoning`, `suggestedRevisions` (typed optional); `metadata` (ad-hoc)
  - `StepValidation` interface: `stepId`, `verdict` (required); `category`, `riskLevel`, `reasoning` (typed optional); `metadata` (ad-hoc)
  - `AxisMessage` interface (Section 9.1): `id`, `correlationId`, `timestamp`, `from`, `to`, `type` (required); `signature` (required for Gear messages only); `payload`, `replyTo`, `jobId` (typed optional); `metadata` (ad-hoc)
  - `AxisMessageType` union type (Section 9.1): `'plan.request' | 'plan.response' | 'validate.request' | 'validate.response' | 'execute.request' | 'execute.response' | 'reflect.request' | 'reflect.response' | 'approve.request' | 'approve.response' | 'status.update' | 'error'`
  - `ComponentId` type: `'bridge' | 'scout' | 'sentinel' | 'journal' | \`gear:${string}\``
  - `GearManifest` interface (Section 5.6.2): identity (`id`, `name`, `version`, `description`, `author`, `license`, `repository?`), `actions: GearAction[]`, `permissions` (`filesystem?: { read?: string[], write?: string[] }`, `network?: { domains?: string[], protocols?: string[] }`, `secrets?: string[]`, `shell?: boolean`, `environment?: string[]`), `resources?: { maxMemoryMb?, maxCpuPercent?, timeoutMs?, maxNetworkBytesPerCall? }`, `origin: 'builtin' | 'user' | 'journal'`, `signature?`, `checksum`, `draft?`
  - `GearAction` interface: `name`, `description`, `parameters`, `returns`, `riskLevel`
  - `GearContext` interface (Section 9.3): constrained API surface for Gear code
  - `WSMessage` discriminated union type (Section 9.2): `chunk`, `status`, `approval_required`, `result`, `error`, `notification`, `progress`, `connected`, `ping`, `pong`
  - `AuditEntry` interface (Section 6.6): `id`, `timestamp`, `actor`, `actorId`, `action`, `target`, `jobId`, `riskLevel`, `previousHash`, `entryHash`, `details`
  - `SentinelDecision` interface (Section 5.3.8): `id`, `actionType`, `scope`, `verdict` (required); `createdAt`, `expiresAt`, `conditions`, `jobId` (typed optional); `metadata` (ad-hoc)
  - `MemoryQuery` interface (Section 5.4.5): `text` (required); `types?: ('episodic' | 'semantic' | 'procedural')[]`, `maxResults?`, `minRelevance?`, `timeRange?: { start?: string; end?: string }` (typed optional); `metadata` (ad-hoc)
  - `MemoryResult` interface (Section 5.4.5): `id`, `type: 'episodic' | 'semantic' | 'procedural'`, `content`, `relevanceScore` (required); `createdAt?`, `updatedAt?`, `source?`, `linkedGearId?` (typed optional); `metadata` (ad-hoc)
  - `Secret` interface (Section 6.4): `name`, `encryptedValue: Buffer`, `allowedGear: string[]`, `createdAt`, `lastUsedAt` (required); `rotateAfterDays?` (typed optional)
  - `LLMProvider` interface (Section 5.2.4): `id`, `name`, `chat()`, `estimateTokens()`, `maxContextTokens`
  - `ChatRequest`, `ChatChunk` types for LLM streaming
  - Conversation-related types: `Conversation` (`id`, `title`, `status: 'active' | 'archived'`, `createdAt`, `updatedAt`), `Message` (`id`, `jobId`, `conversationId`, `role`, `content`, `modality`, `attachments`, `createdAt`)
- `constants.ts`:
  - `MAX_REVISION_COUNT = 3` (Section 5.1.3)
  - `MAX_REPLAN_COUNT = 2` (Section 5.1.3)
  - `MAX_STEP_ATTEMPTS = 3` (Section 5.1.3)
  - `DEFAULT_JOB_TIMEOUT_MS = 300_000` (5 min, Section 5.1.10)
  - `DEFAULT_PLANNING_TIMEOUT_MS = 60_000`
  - `DEFAULT_VALIDATION_TIMEOUT_MS = 30_000`
  - `DEFAULT_STEP_TIMEOUT_MS = 60_000`
  - `LLM_FIRST_TOKEN_TIMEOUT_MS = 30_000`
  - `LLM_STALL_TIMEOUT_MS = 30_000`
  - `DEFAULT_MAX_ATTEMPTS = 3`
  - `DEDUP_WINDOW_MS = 5_000` (Section 5.1.9)
  - `MAX_MESSAGE_SIZE_BYTES = 1_048_576` (1 MB, Section 5.1.13)
  - `MESSAGE_WARNING_THRESHOLD_BYTES = 102_400` (100 KB)
  - `GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000`
  - `GEAR_KILL_TIMEOUT_MS = 10_000`
  - `SENTINEL_MEMORY_CAP = 500` (Section 5.3.8)
  - `CIRCUIT_BREAKER_FAILURES = 3`
  - `CIRCUIT_BREAKER_WINDOW_MS = 300_000` (5 min)
  - `WATCHDOG_BLOCK_THRESHOLD_MS = 10_000`
  - `WS_PING_INTERVAL_MS = 30_000`
  - `WS_PONG_TIMEOUT_MS = 10_000`
  - `WS_RATE_LIMIT_PER_MINUTE = 60`
  - `API_RATE_LIMIT_PER_MINUTE = 100`
  - `DEFAULT_CONVERSATION_TIMEOUT_MS = 1_800_000` (30 min inactivity)
  - `DEFAULT_CONTEXT_MESSAGES = 20`
  - `DEFAULT_MEMORY_TOP_K = 5`
  - `DEFAULT_SESSION_DURATION_HOURS = 168` (7 days)
  - `BRUTE_FORCE_THRESHOLD = 5`
  - `BRUTE_FORCE_LOCKOUT = 20`
  - Default resource limits for Gear: `DEFAULT_GEAR_MEMORY_MB = 256`, `DEFAULT_GEAR_CPU_PERCENT = 50`, `DEFAULT_GEAR_TIMEOUT_MS = 300_000`
  - Context window budgets (Section 5.2.3): `SYSTEM_PROMPT_TOKEN_BUDGET = 2_000`, `CONVERSATION_TOKEN_BUDGET = 4_000`, `MEMORY_TOKEN_BUDGET = 2_000`
  - Per-job token limit: `DEFAULT_JOB_TOKEN_BUDGET = 100_000` (Section 6.2 LLM10)
  - Daily cost limit: `DEFAULT_DAILY_COST_LIMIT_USD = 5.00`
  - Standing rule suggestion threshold: `STANDING_RULE_SUGGESTION_COUNT = 5` (Section 5.5.3)
  - Event loop thresholds: `EVENT_LOOP_P99_WARN_MS = 50`, `EVENT_LOOP_P99_ERROR_MS = 200`, `EVENT_LOOP_BLOCK_DIAGNOSTIC_MS = 5_000` (Section 11.4)
  - Disk monitoring: `DISK_USAGE_WARN_PERCENT = 80`, `DISK_USAGE_PAUSE_PERCENT = 90` (Section 11.3)
  - Connection limits per tier (Section 11.4): `MAX_CONCURRENT_GEAR_DESKTOP = 4`, `MAX_CONCURRENT_GEAR_PI = 2`, `MAX_WS_CONNECTIONS_DESKTOP = 10`, `MAX_WS_CONNECTIONS_PI = 4`, `MAX_LLM_STREAMS_DESKTOP = 3`, `MAX_LLM_STREAMS_PI = 1`
  - Worker counts per tier: `DEFAULT_WORKERS_PI = 2`, `DEFAULT_WORKERS_DESKTOP = 4`, `DEFAULT_WORKERS_VPS = 8` (Section 5.1.4)
  - Polling/scheduling intervals: `QUEUE_POLL_INTERVAL_MS = 100` (Section 5.1.6), `SCHEDULE_EVAL_INTERVAL_MS = 60_000` (Section 5.1.5)
  - WebSocket re-validation: `WS_REVALIDATION_INTERVAL_MS = 900_000` (15 min, Section 6.5.2), `MAX_MISSED_PONGS = 2`
  - Startup self-diagnostic: `MIN_DISK_SPACE_MB = 500`, `MIN_RAM_MB = 1024` (Section 5.1.15)
  - Memory watchdog (Section 11.4): `MEMORY_RSS_WARN_PERCENT = 70`, `MEMORY_RSS_PAUSE_PERCENT = 80`, `MEMORY_RSS_REJECT_PERCENT = 90`, `MEMORY_EMERGENCY_FREE_MB = 256`
  - Cost alert thresholds: `COST_ALERT_WARN_PERCENT = 80`, `COST_ALERT_CRITICAL_PERCENT = 95` (Section 11.2)
  - Replay protection: `REPLAY_WINDOW_MS = 60_000` (Section 6.3, used in v0.2 Phase 9.2)
  - Maintenance intervals: `FTS_REBUILD_INTERVAL_DAYS = 7` (Section 8.3)
  - Semantic cache: `SEMANTIC_CACHE_SIMILARITY_THRESHOLD = 0.98` (Section 11.2, used in v0.4 Phase 11.4)
  - Data retention defaults: `RETENTION_CONVERSATION_DAYS = 90`, `RETENTION_EPISODIC_DAYS = 90`, `RETENTION_EXECUTION_LOG_DAYS = 30`, `RETENTION_AUDIT_MONTHS = 12` (Section 7.4)
  - Backup rotation: `BACKUP_DAILY_COUNT = 7`, `BACKUP_WEEKLY_COUNT = 4`, `BACKUP_MONTHLY_COUNT = 3` (Section 8.4)
- `errors.ts`:
  - Base `MeridianError` class extending `Error` with `code: string` property
  - Typed error subclasses: `ValidationError`, `AuthenticationError`, `AuthorizationError`, `NotFoundError`, `ConflictError`, `TimeoutError`, `RateLimitError`, `GearSandboxError`, `LLMProviderError`, `PlanValidationError`, `SecretAccessError`
  - Each error has a unique `code` string (e.g., `'ERR_VALIDATION'`, `'ERR_AUTH'`, `'ERR_TIMEOUT'`)
- `result.ts`:
  - `Result<T, E>` type for expected failures (validation, parsing)
  - `ok<T>(value: T): Result<T, never>` constructor
  - `err<E>(error: E): Result<never, E>` constructor
  - `isOk()`, `isErr()`, `unwrap()`, `unwrapOr()`, `map()`, `mapErr()` methods
- `id.ts`:
  - `generateId(): string` — UUID v7 generation (time-sortable)
  - Dependency: `uuidv7` package or manual implementation per RFC 9562
- `index.ts` — Public barrel export for `@meridian/shared`

**Test Deliverables**:

- `src/shared/result.test.ts` — Result type constructor and method tests
- `src/shared/id.test.ts` — UUID v7 format validation, monotonicity, uniqueness
- `src/shared/errors.test.ts` — Error class instantiation and code property

**Acceptance Criteria**:

- All types compile cleanly with `strict: true`
- All tests pass
- No `any` types used (only `unknown` with narrowing)

---

### Phase 1.4: Database Infrastructure

**PR Scope**: SQLite worker thread architecture, connection management, migration framework, PRAGMA configuration.

**Architecture References**: Sections 8.1-8.6 (Data Architecture), 11.1 (SQLite Worker Thread)

**Deliverables** (in `src/shared/`):

- `database/worker.ts` — Dedicated `worker_threads` worker:
  - Owns all SQLite database connections
  - Receives queries via `MessagePort`
  - Executes synchronously (worker has no other work)
  - Returns results via `MessagePort`
  - Two connections per database: one write, one readonly
  - Handles `better-sqlite3` initialization
- `database/client.ts` — Async client API wrapping worker thread communication:
  - `query<T>(db: DatabaseName, sql: string, params?: unknown[]): Promise<T[]>`
  - `run(db: DatabaseName, sql: string, params?: unknown[]): Promise<RunResult>`
  - `transaction<T>(db: DatabaseName, fn: () => Promise<T>): Promise<T>`
  - All packages use this client — no package opens its own database connections
  - `DatabaseName` type: `'meridian' | 'journal' | 'sentinel' | 'audit'`
- `database/configure.ts` — `configureConnection(db)` function enforcing PRAGMAs (Section 8.2.1):

  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;  -- audit.db overrides to FULL
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  PRAGMA auto_vacuum = INCREMENTAL;
  PRAGMA temp_store = MEMORY;
  ```

  - Deployment-tier-aware cache_size and mmap_size settings
  - `audit.db` uses `synchronous = FULL`

- `database/migrator.ts` — Migration framework:
  - Reads numbered SQL files from `src/<module>/migrations/` (e.g., `001_initial.sql`)
  - `schema_version` table per database for tracking
  - Each migration runs in its own transaction
  - Pre-migration backup via `VACUUM INTO`
  - Forward-only (rollback via pre-migration backups)
  - Runs automatically on startup if schema is behind
- Initial migration files:
  - `src/axis/migrations/001_initial.sql` — Core database schema (Section 8.3):
    - `conversations`, `jobs`, `messages`, `schedules`, `gear`, `execution_log`, `config` tables
    - All indexes from Section 8.3
    - `schema_version` table
  - `src/sentinel/migrations/001_initial.sql` — Sentinel database (Section 8.3):
    - `decisions` table with indexes
    - `schema_version` table
  - `src/journal/migrations/001_initial.sql` — Journal database (Section 8.3):
    - `episodes`, `facts`, `procedures` tables with indexes
    - FTS5 virtual tables (content-sync triggers deferred to v0.3)
    - Note: `memory_embeddings` sqlite-vec virtual table added in Phase 10.1 migration (v0.3)
    - `schema_version` table
  - Audit database initial schema:
    - `audit_entries` table matching `AuditEntry` interface
    - `schema_version` table
- `database/index.ts` — Public API exports

**Test Deliverables**:

- `src/shared/database/client.test.ts` — Worker thread communication, query execution, error handling
- `src/shared/database/migrator.test.ts` — Migration sequencing, version tracking, transaction rollback on failure, pre-migration backup
- `src/shared/database/configure.test.ts` — PRAGMA verification

**Acceptance Criteria**:

- Main thread never touches SQLite directly
- All PRAGMAs applied correctly on connection open
- Migrations run idempotently (running twice is safe)
- Worker thread communication overhead under 1ms per message

---

### Phase 1.5: Configuration & Logging

**PR Scope**: Configuration loading with precedence hierarchy, structured logging with redaction.

**Architecture References**: Sections 10.4 (Configuration), 12.1 (Logging Strategy)

**Deliverables**:

- `src/shared/config.ts`:
  - Configuration interface matching `config.toml` schema (Section 10.4). Key sections and defaults:
    - `[axis]`: `workers` (tier-dependent), `job_timeout_ms` (300000)
    - `[scout]`: `provider` ("anthropic"), `max_context_tokens` (100000), `temperature` (0.3)
    - `[scout.models]`: `primary` (model ID string), `secondary` (model ID string, used from v0.4)
    - `[sentinel]`: `provider`, `model`, `max_context_tokens` (32000) — unused in v0.1 (rule-based)
    - `[journal]`: `embedding_provider` ("local"), `embedding_model` ("nomic-embed-text"), `episode_retention_days` (90), `reflection_enabled` (true) — unused in v0.1
    - `[bridge]`: `bind` ("127.0.0.1"), `port` (3000), `session_duration_hours` (168)
    - `[security]`: `daily_cost_limit_usd` (5.00), `require_approval_for` (list of action types requiring approval)
  - Precedence hierarchy: defaults → config file → environment variables → database config table
  - TOML parsing for `data/config.toml`
  - Environment variable mapping: `MERIDIAN_*` prefix (e.g., `MERIDIAN_BRIDGE_PORT=3000`)
  - Deployment tier detection (Raspberry Pi vs Desktop vs VPS) for resource tuning
  - Validation of configuration values at load time
- `src/shared/logger.ts`:
  - Structured JSON logging with levels (Section 12.1): `error` (system failures, security violations), `warn` (degraded state, approaching limits, Sentinel rejections), `info` (lifecycle events, results, user actions), `debug` (detailed traces, redacted)
  - **Sensitive data redaction**: scrub common credential patterns (API keys, tokens, passwords) before writing
  - Output to stdout/stderr (for containers) and optional file (`data/logs/meridian.log`)
  - Daily rotation support (configurable retention, default 7 days)
  - Child logger creation with component context (e.g., `logger.child({ component: 'axis' })`)
  - Never logs secret values, even at debug level (Section 6.4)
- `src/shared/config.test.ts` — Precedence order, env var mapping, validation
- `src/shared/logger.test.ts` — Redaction of credential patterns, level filtering, structured output format

**Acceptance Criteria**:

- Config loads with sane defaults when no config file exists
- Logger redacts patterns like `sk-...`, `Bearer ...`, `password=...`
- Logger output is valid JSON

---

### Phase 1.6: Secrets Vault

**PR Scope**: Encrypted secrets storage with proper memory handling.

**Architecture References**: Section 6.4 (Secrets Management)

**Deliverables**:

- `src/shared/secrets.ts`:
  - `SecretsVault` class:
    - AES-256-GCM encryption with Argon2id key derivation
    - Master key derived from user password:
      - Standard tier: 64 MiB memory, 3 iterations, 1 parallelism
      - Low-power tier: 19 MiB memory, 2 iterations, 1 parallelism
    - Secrets stored as `Buffer` objects, never JavaScript strings
    - `buffer.fill(0)` after use for explicit zeroing
    - Derived key held in memory as `Buffer`, zeroed on shutdown
    - File-based vault at `data/secrets.vault`
  - API:
    - `initialize(password: string, tier: 'standard' | 'low-power'): Promise<void>`
    - `unlock(password: string): Promise<void>`
    - `lock(): void` (zeros key from memory)
    - `store(name: string, value: Buffer, allowedGear: string[]): Promise<void>`
    - `retrieve(name: string, requestingGear: string): Promise<Buffer | undefined>` (ACL check)
    - `delete(name: string): Promise<void>`
    - `list(): Promise<SecretMetadata[]>` (names and metadata only, never values)
    - `rotationCheck(): Promise<SecretRotationWarning[]>` (per `rotateAfterDays`)
  - No password recovery mechanism (architecture explicitly states this)
  - Secret ACLs: each secret has `allowedGear: string[]` specifying which Gear can access it

**Test Deliverables**:

- `src/shared/secrets.test.ts`:
  - Encrypt/decrypt round-trip
  - Wrong password fails decryption
  - ACL enforcement (unauthorized Gear denied)
  - Buffer zeroing after retrieval
  - Vault locked state rejects all operations
  - Rotation warning detection

**Acceptance Criteria**:

- Secrets never appear as JavaScript strings in the vault implementation
- No secret values appear in test output or logs
- ACL enforcement is strict — missing ACL = denied

---

## Phase 2: Axis — Runtime & Scheduler

**Goal**: Build the deterministic runtime core — the heartbeat of the system. Axis has NO LLM dependency. After this phase, jobs can be created, queued, transitioned through states, and dispatched to component handlers.

**Architecture References**: Section 5.1 (Axis), Section 9.1 (Internal API)

---

### Phase 2.1: Message Router & Component Registry

**PR Scope**: In-process message dispatch system with middleware chain.

**Deliverables** (`src/axis/`):

- `router.ts` — Message router:
  - Component registration: each component registers a message handler during startup
  - Typed function dispatch: `dispatch(message: AxisMessage): Promise<AxisMessage>`
  - Direct async function call — no serialization, no IPC (in-process only)
  - `correlationId` tracking for request-reply matching
  - `AbortSignal` passed to each handler for timeout enforcement
  - Middleware chain wrapping every dispatch:
    - Audit logging middleware (calls an injected `AuditWriter` interface — initially a no-op/in-memory stub, replaced by the real SQLite-backed writer in Phase 2.7)
    - Error handling middleware (catches and wraps errors)
    - Latency tracking middleware (logs slow dispatches)
    - Message size validation middleware (reject > 1MB, warn > 100KB per Section 5.1.13)
  - Component registration validation:
    - Reject duplicate registrations
    - Validate `ComponentId` format
- `registry.ts` — Component registry:
  - `register(componentId: ComponentId, handler: MessageHandler): void`
  - `unregister(componentId: ComponentId): void`
  - `getHandler(componentId: ComponentId): MessageHandler | undefined`
  - Type: `MessageHandler = (message: AxisMessage, signal: AbortSignal) => Promise<AxisMessage>`

**Test Deliverables**:

- `src/axis/router.test.ts`:
  - Message dispatch to registered component
  - Unknown component returns error
  - Middleware chain execution order
  - Correlation ID matching
  - AbortSignal timeout enforcement
  - Message size rejection/warning

**Acceptance Criteria**:

- No LLM imports anywhere in `src/axis/`
- Dispatch is type-safe end-to-end
- Audit middleware logs every dispatch

---

### Phase 2.2: Job Queue & State Machine

**PR Scope**: SQLite-backed job queue with atomic state transitions.

**Deliverables** (`src/axis/`):

- `job-queue.ts`:
  - SQLite is the queue (no separate in-memory queue)
  - Job creation with UUID v7 IDs
  - Atomic compare-and-swap state transitions: `UPDATE jobs SET status = ?, workerId = ? WHERE id = ? AND status = ?` (Section 5.1.3)
  - All transitions per state machine (Section 5.1.3):
    - `pending → planning` (worker claims)
    - `planning → validating` (Scout produces plan)
    - `planning → completed` (fast path)
    - `planning → failed` (Scout API unreachable)
    - `validating → executing` (Sentinel approves)
    - `validating → awaiting_approval` (needs user approval)
    - `validating → planning` (revision, `revisionCount < 3`)
    - `validating → failed` (rejected or `revisionCount >= 3`)
    - `awaiting_approval → executing` (user approves)
    - `awaiting_approval → cancelled` (user rejects)
    - `executing → completed` (success)
    - `executing → failed` (max retries exceeded)
    - `executing → planning` (replan, `replanCount < 2`)
    - `any non-terminal → cancelled` (user cancels)
  - Terminal states: `completed`, `failed`, `cancelled` — no transitions out
  - Cycle limit enforcement: `revisionCount` (max 3), `replanCount` (max 2), `stepAttempts` (max 3 per step)
  - Queue polling at configurable interval (default: 100ms)
- `src/axis/job-queue.test.ts`:
  - All valid state transitions succeed
  - Invalid state transitions rejected
  - Concurrent claim (compare-and-swap) prevents double-claim
  - Cycle limits enforced (revision, replan, step attempts)
  - Terminal states are truly terminal
  - Uses deterministic mock clocks for time-dependent scheduling tests (Section 13.1)

---

### Phase 2.3: Request Deduplication & Idempotency

**PR Scope**: Prevent duplicate job creation and duplicate step execution.

**Deliverables** (`src/axis/`):

- `dedup.ts` — Request deduplication (Section 5.1.9):
  - SHA-256 hash: `SHA-256(userId + content + floor(timestamp / 5000))`
  - Unique partial index: `CREATE UNIQUE INDEX idx_dedup ON jobs(dedupHash) WHERE status NOT IN ('completed', 'failed', 'cancelled')`
  - If matching non-terminal job exists, return existing job ID
- `idempotency.ts` — Idempotency framework (Section 5.1.7):
  - `executionId` derived from `jobId + stepId` (stable across retries)
  - `execution_log` table operations:
    - Before dispatch: check log
    - `completed` → return cached result, skip execution
    - `started` (stale from crash) → mark `failed`, re-execute
    - Not found → insert `started`, proceed
  - Completion recording: mark `completed` with result after success

**Test Deliverables**:

- `src/axis/dedup.test.ts` — Hash generation, duplicate detection, time window boundaries
- `src/axis/idempotency.test.ts` — Cached result reuse, crash recovery, new execution path

---

### Phase 2.4: Worker Pool, Concurrency & Timeout Hierarchy

**PR Scope**: Configurable worker pool for concurrent job processing with nested timeouts.

**Deliverables** (`src/axis/`):

- `worker-pool.ts`:
  - Configurable concurrent workers (default: 2 Pi, 4 Mac Mini, 8 VPS per Section 5.1.4)
  - Workers claim jobs from SQLite queue via atomic CAS
  - Backpressure: when queue exceeds capacity, new jobs accepted but deprioritized
  - Worker lifecycle: claim → process → release
- `timeout.ts` — Nested timeout hierarchy (Section 5.1.10):

  ```
  Job timeout (default: 300s)
  ├── Planning timeout (default: 60s)
  │   └── LLM call timeout (30s first token, 30s stall)
  ├── Validation timeout (default: 30s)
  │   └── LLM call timeout
  └── Execution timeout (remaining budget)
      └── Step timeout (per step, default: 60s)
  ```

  - Each inner timeout capped by remaining parent budget
  - Cancellation protocol: signal → 5s grace → force kill
  - `AbortSignal` composition for nested timeout chains

- `error-classifier.ts` — Error classification & retry (Section 5.1.11):
  - Retriable: 429, 500, 502, 503, 504, timeout → exponential backoff (`min(base * 2^attempt + jitter, max)`)
  - Non-retriable credential: 401, 403 → stop, notify user
  - Non-retriable client: 400, 404, 422 → do not retry
  - Non-retriable quota: 402 → stop, notify user
  - Backoff formula: `delay = min(1000 * 2^attempt + random(0, 1000), 30000)`

**Test Deliverables**:

- `src/axis/worker-pool.test.ts` — Concurrent processing, backpressure, worker limits
- `src/axis/timeout.test.ts` — Nested timeout enforcement, cancellation protocol, budget tracking
- `src/axis/error-classifier.test.ts` — All HTTP status code classifications, backoff calculation

---

### Phase 2.5: Plan Pre-Validation

**PR Scope**: Deterministic structural validation of execution plans before Sentinel review.

**Architecture References**: Section 5.1.8

> **Dependency Note**: The plan validator checks Gear existence and action validity against a `GearRegistry` interface. In this phase, validation is coded against an injected interface and tested with mock registry data. The concrete `GearRegistry` implementation (Phase 5.1) is wired in during Phase 5.7/8.1 integration.

**Deliverables** (`src/axis/`):

- `plan-validator.ts`:
  - Gear existence: verify every referenced Gear exists in the registry
  - Action existence: verify every action is defined in the referenced Gear's manifest
  - Parameter schema: validate step parameters against the action's declared JSON Schema
  - Structural checks:
    - Plan has at least one step
    - All step IDs are unique
    - `dependsOn` references point to valid step IDs within the plan
  - Returns structured error messages for correction
  - Failed pre-validation counts against `revisionCount` but does NOT consume a Sentinel LLM call

**Test Deliverables**:

- `src/axis/plan-validator.test.ts`:
  - Missing Gear detection
  - Unknown action detection
  - Invalid parameter schema detection
  - Duplicate step ID detection
  - Invalid `dependsOn` reference detection
  - Empty plan rejection
  - Valid plan passes

---

### Phase 2.6: Fault Tolerance & Startup Lifecycle

**PR Scope**: Crash recovery, circuit breaker, watchdog, startup sequence, graceful shutdown.

**Deliverables** (`src/axis/`):

- `recovery.ts` — Crash recovery (Section 5.1.12):
  - On restart: load all non-terminal jobs from SQLite
  - Jobs that were `executing` at crash time: check execution log, mark stale `started` entries as `failed`, return job to `pending`
- ~~`circuit-breaker.ts`~~: **Deferred to v0.2** (Phase 9) per architecture roadmap Section 16. The architecture explicitly defers circuit breakers from v0.1 Axis scope.
- `watchdog.ts` (Section 5.1.12):
  - Monitor event loop responsiveness
  - If blocked > 10 seconds: log warning, trigger diagnostic dump (active handles, pending callbacks, heap stats)
- `maintenance-basic.ts` — Basic periodic maintenance (run on startup and every 24h during idle):
  - `ANALYZE` on all databases to keep query planner statistics current (Section 8.3)
  - `INCREMENTAL VACUUM` on all databases
  - Note: Full idle maintenance scheduler with reflection backlog and FTS rebuild is Phase 10.6
- `lifecycle.ts` — Startup & shutdown (Section 5.1.14):
  - **Startup sequence** (7 ordered steps):
    1. Load config and init logging → liveness probe returns 200
    2. Open databases and run migrations (WAL mode)
    3. Axis core startup (router, scheduler, watchdog)
    4. Component registration (Scout, Sentinel, Journal, built-in Gear receive HMAC signing keys)
    5. Crash recovery and startup reconciliation
    6. Bridge startup (HTTP + WS) → readiness probe returns 200
    7. Ready — begin processing job queue
  - **Self-diagnostic** (Section 5.1.15, during step 2):
    - Abort: data dir writable, port available, DB files accessible, Node.js >= 20
    - Warning: disk < 500 MB, RAM < 1 GB
  - **Graceful shutdown** (SIGTERM/SIGINT):
    1. Stop accepting new connections
    2. Stop claiming new jobs
    3. Wait up to 30s for running jobs to reach safe checkpoint
    4. SIGTERM to Gear sandbox processes; SIGKILL after 10s
    5. Persist in-flight state to SQLite
    6. Close all database connections
    7. Exit code 0

**Test Deliverables**:

- `src/axis/recovery.test.ts` — Stale job detection, re-queue logic
- `src/axis/watchdog.test.ts` — Event loop block detection
- `src/axis/lifecycle.test.ts` — Startup sequence ordering, self-diagnostic checks, graceful shutdown state transitions

**Acceptance Criteria**:

- Cold start budget targets measured (Section 11.6): Node.js < 800ms, SQLite < 300ms, migrations < 200ms, Fastify < 200ms, Gear manifests < 300ms, job recovery < 200ms (total < 3s on RPi with SSD)
- Items lazy-loaded after startup (not blocking cold start): Ollama connection, LLM provider connections, sqlite-vec extension, semantic cache

---

### Phase 2.7: Audit Logging

**PR Scope**: Append-only audit log with monthly partitioning.

**Deliverables** (`src/axis/`):

- `audit.ts`:
  - Write `AuditEntry` records to `audit-YYYY-MM.db`
  - Append-only: application NEVER issues UPDATE or DELETE on audit entries
  - Monthly partitioning: current month is write target
  - `synchronous = FULL` for audit database (crash must never lose an audit entry)
  - Write-ahead audit: audit entry written before committing the primary action (Section 8.6)
  - Export functionality for external review
  - Integrity chain fields (`previousHash`, `entryHash`) are defined in schema but populated in v0.3

**Test Deliverables**:

- `src/axis/audit.test.ts`:
  - Entry creation with all required fields
  - Monthly database partitioning
  - Append-only enforcement (no updates/deletes at API level)
  - Write-ahead ordering

---

### Phase 2.8: Axis Integration & Index

**PR Scope**: Wire all Axis sub-systems together and export the public API.

**Deliverables**:

- `src/axis/index.ts` — Public barrel export:
  - `createAxis(config): Axis` — Factory function
  - `Axis` class composing: router, job queue, worker pool, plan validator, recovery, watchdog, audit, lifecycle (circuit breaker added in Phase 9.6)
  - Exposes only the public API through `index.ts`
- Integration test: `tests/integration/axis-lifecycle.test.ts`:
  - Full startup → job creation → state transitions → shutdown cycle
  - Crash recovery simulation
  - Worker pool job processing

**Acceptance Criteria**:

- Axis starts and shuts down cleanly
- Jobs flow through the complete state machine
- No LLM dependency in any Axis code
- All Axis unit tests pass

---

## Phase 3: Scout — Planner LLM

**Goal**: Implement the planning component that understands user intent, produces structured execution plans, and handles fast-path detection.

**Architecture References**: Section 5.2 (Scout), Section 4.3 (Fast Path vs Full Path)

---

### Phase 3.1: LLM Provider Abstraction

**PR Scope**: Provider-agnostic LLM interface and the first provider adapter.

**Deliverables** (`src/scout/`):

- `providers/provider.ts` — `LLMProvider` interface implementation:
  - `chat(request: ChatRequest): AsyncIterable<ChatChunk>` (streaming)
  - `estimateTokens(text: string): number`
  - `maxContextTokens: number`
  - Streaming with first-token timeout (30s) and stall timeout (30s between tokens)
  - AbortSignal support for cancellation
  - Connection pooling: single persistent connection per provider, reused across requests (Section 11.2)
- `providers/anthropic.ts` — Anthropic provider adapter:
  - Uses `@anthropic-ai/sdk`
  - Streaming response parsing
  - Tool use translation (Section 5.2.5):
    - Outbound: Gear actions → Anthropic `tools` entries with `input_schema`
    - Inbound: Anthropic tool call responses → `ExecutionStep` objects
  - Error mapping to Meridian error types
  - Token estimation
- `providers/index.ts` — Provider factory:
  - `createProvider(config: ProviderConfig): LLMProvider`
  - Provider type detection from config

**Test Deliverables**:

- `src/scout/providers/anthropic.test.ts`:
  - Mock SDK responses
  - Tool use translation (both directions)
  - Streaming chunk parsing
  - Error handling (timeout, API errors)
  - Token estimation accuracy

**Acceptance Criteria**:

- Provider interface is truly provider-agnostic
- Anthropic adapter handles all documented response formats
- Streaming works with proper timeout enforcement

---

### Phase 3.2: Additional LLM Providers

> **Note**: Per architecture roadmap Section 16, multi-provider support is **deferred from v0.1**. v0.1 uses single provider (Anthropic) only. This phase is implemented in v0.2 (Phase 9). It is listed here for context but should be executed as part of Phase 9.

**PR Scope**: OpenAI, Google, Ollama, and OpenRouter provider adapters (v0.2).

**Deliverables** (`src/scout/providers/`):

- `openai.ts` — OpenAI adapter:
  - Uses `openai` SDK
  - Tool use translation: Gear actions → `functions` in `tools` array
  - Streaming, error mapping, token estimation
- `google.ts` — Google Gemini adapter:
  - Uses `@google/generative-ai`
  - Tool use translation: Gear actions → `FunctionDeclaration`
  - Streaming, error mapping
- `ollama.ts` — Ollama adapter:
  - Uses `ollama` npm package (HTTP API client)
  - Tool use translation when model supports it
  - Fallback mode for models without native tool calling (Section 5.2.5):
    - System prompt includes plan JSON Schema
    - Output parsed and validated against schema
- `openrouter.ts` — OpenRouter adapter:
  - Compatible with OpenAI SDK (re-uses OpenAI adapter with different base URL)

**Test Deliverables**:

- Provider-specific unit tests with mock responses
- Fallback mode (structured-output prompting) tested for Ollama

---

### Phase 3.3: Plan Generation & Fast-Path Detection

**PR Scope**: Core Scout logic — context assembly, plan generation, and fast-path/full-path determination.

**Deliverables** (`src/scout/`):

- `planner.ts` — Plan generation:
  - Receives user message + context → produces `ExecutionPlan` or plain text response
  - System prompt construction (Section 5.2.8):
    - Core instructions
    - Available Gear catalog
    - User preferences
    - Prompt injection defense instructions (CRITICAL SAFETY RULES)
  - Context assembly (Section 5.2.3):
    - System prompt (~2,000 tokens budget)
    - Recent conversation (up to 4,000 tokens, configurable, default last 20 messages)
    - Relevant memories (up to 2,000 tokens, top-k=5) — stubbed for v0.1 (Journal not yet available)
    - Active job state
  - Token budgeting: strict limits per context section
  - Per-job token budget enforcement: track cumulative tokens, reject when `DEFAULT_JOB_TOKEN_BUDGET` exceeded (Section 6.2 LLM10)
  - `journalSkip` flag setting based on task type
  - Source attribution: when Scout includes information from web searches or documents, the source is cited in the response (Section 6.2 LLM09)
  - Confidence signals: Scout system prompt instructs expressing uncertainty when appropriate (Section 6.2 LLM09)
  - LLM API call audit logging: every external LLM call logged in audit trail including content sent (Section 7.3)
- `path-detector.ts` — Fast path vs full path (Section 4.3):
  - **Structural determination**: plain text = fast path, `ExecutionPlan` JSON = full path
  - **Axis verification** of fast-path responses (3 checks):
    1. No JSON structures resembling execution plans
    2. No references to registered Gear names or action identifiers
    3. No deferred-action language patterns ("I've gone ahead and...", "I've already set up...", "Done! I created...")
  - If any check fails: discard response, re-route to Scout with full-path instruction
- `failure-handler.ts` — LLM failure modes (Section 5.2.7):
  - Malformed JSON: retry up to 2 times with parse error in prompt
  - Model refusal: retry once with rephrase; if refused again, escalate to user
  - Infinite replanning: break at `revisionCount >= 3` or `replanCount >= 2`
  - Truncated output: retry with reduced context
  - Empty/nonsensical output: retry once, then fail
  - Repetitive output: fail immediately (model is stuck)

**Test Deliverables**:

- `src/scout/planner.test.ts`:
  - Plan generation with mock LLM returning valid plan JSON
  - Context assembly respects token budgets
  - System prompt includes safety rules
- `src/scout/path-detector.test.ts`:
  - Plain text classified as fast path
  - Valid JSON plan classified as full path
  - Fast-path verification catches Gear references
  - Fast-path verification catches deferred-action language
- `src/scout/failure-handler.test.ts`:
  - Each failure mode triggers correct response

---

### Phase 3.4: External Content Provenance

**PR Scope**: Content tagging and prompt injection defense.

**Deliverables** (`src/scout/`):

- `provenance.ts`:
  - Content wrapping with provenance tags:
    ```
    <external_content source="email" sender="alice@example.com" trust="untrusted">
    [content]
    </external_content>
    ```
  - Source types: `'email' | 'web' | 'document' | 'gear' | 'user'`
  - Gear output tagged with `source: "gear:<gear-id>"`
  - Only `user` source is treated as instructions; all others are DATA

**Test Deliverables**:

- `src/scout/provenance.test.ts`:
  - Correct tag wrapping for each source type
  - Nested content handled correctly
  - Special characters in content escaped properly

---

### Phase 3.5: Scout Integration & Index

**PR Scope**: Wire Scout components together, register with Axis.

**Deliverables**:

- `src/scout/index.ts` — Public API:
  - `createScout(config, provider): Scout`
  - Scout registers as message handler with Axis for `plan.request` messages
  - Handles `plan.request` → returns `plan.response` (with plan or direct text)
  - Model configuration: `primary` field used in v0.1, `secondary` field defined but ignored until v0.4
- `src/scout/prompts/plan-generation.ts`:
  - Versioned prompt template with metadata (version, description, model compatibility)
  - System prompt with safety rules (Section 5.2.8)

**Test Deliverables**:

- `tests/integration/scout-axis.test.ts`:
  - Scout registers with Axis
  - Plan request dispatched and response received
  - Fast-path and full-path flows with mock LLM
- `tests/security/prompt-injection-basic.test.ts`:
  - Basic curated set of common prompt injection patterns tested against Scout (with mock LLM):
    - Direct injection: "ignore previous instructions and..."
    - Indirect injection: external content containing instructions
    - Provenance tag escape attempts
    - Deferred-action language patterns detected by fast-path verification
    - JSON plan injection in text responses
  - Verify provenance tags are correctly applied to all external content
  - Note: Full adversarial prompt injection suite expanded in Phase 10.7 (v0.3)

---

## Phase 4: Sentinel — Rule-Based Safety Validator (v0.1)

**Goal**: Implement the rule-based policy engine for v0.1 (LLM-based validation is v0.2). Sentinel validates execution plans against security policies and risk levels.

**Architecture References**: Section 5.3 (Sentinel), v0.1 scope from Section 16

**Note**: v0.1 Sentinel is rule-based only (no LLM dependency). The information barrier is still enforced — Sentinel never sees the user's original message, Journal data, or Gear catalog.

---

### Phase 4.1: Policy Engine (Rule-Based)

**PR Scope**: Deterministic policy evaluation against execution plans.

**Deliverables** (`src/sentinel/`):

- `policy-engine.ts`:
  - Evaluates each `ExecutionStep` against default risk policies (Section 5.3.5):
    | Action Type | Default Policy |
    |---|---|
    | Read local files | Approved (within allowed paths) |
    | Write/modify files | Needs user approval if outside workspace |
    | Delete files | Always needs user approval |
    | Network requests (GET) | Approved for allowlisted domains |
    | Network requests (POST/PUT/DELETE) | Needs user approval |
    | Shell command execution | Always needs user approval |
    | Credential usage | Approved for declared Gear, logged |
    | Financial transactions | Always needs user approval, hard limit check |
    | Sending messages | Needs user approval |
    | System configuration changes | Always needs user approval |
  - User-customizable policies (can be stricter, never weaker than floor)
  - Hard floor policies cannot be overridden by any trust profile
  - Composite risk assessment: combined effect of multiple steps
  - Returns `ValidationResult` with per-step verdicts
- `risk-assessor.ts`:
  - Independent risk level assessment per step
  - Risk level: `low | medium | high | critical`
  - Risk divergence logging: if Scout's `riskLevel` diverges more than one level from Sentinel's assessment, log as anomaly

**Test Deliverables**:

- `src/sentinel/policy-engine.test.ts`:
  - Each default policy tested (all 10 action types)
  - Hard floor policies cannot be weakened
  - Custom user policies override defaults (stricter only)
  - Composite risk detection (e.g., read credentials + network request)
- `src/sentinel/risk-assessor.test.ts`:
  - Risk level calculation for each action type
  - Divergence logging threshold

---

### Phase 4.2: Approval Flow

**PR Scope**: User approval routing and response handling.

**Deliverables** (`src/sentinel/`):

- `approval.ts`:
  - Approval flow implementation (Section 5.3.4):
    - `APPROVED` → Axis executes plan
    - `NEEDS_REVISION` → Scout revises (max 3 iterations)
    - `NEEDS_USER_APPROVAL` → Bridge prompts user
    - `REJECTED` → Job fails with explanation
  - Approval request creation with:
    - Plain-language summary of what Meridian wants to do
    - Per-step risk indicators
    - Structured data for Bridge to render approval dialog
  - Approval response handling:
    - User approve → transition to `executing`
    - User reject → transition to `cancelled`

**Test Deliverables**:

- `src/sentinel/approval.test.ts`:
  - Each verdict triggers correct job state transition
  - Revision loop respects `revisionCount` limit
  - User approval/rejection handled correctly

---

### Phase 4.3: Sentinel Integration & Index

**PR Scope**: Wire Sentinel together, register with Axis, enforce information barrier.

**Deliverables**:

- `src/sentinel/index.ts` — Public API:
  - `createSentinel(config): Sentinel`
  - Registers as message handler for `validate.request` messages
  - Receives ONLY the execution plan (not user message, not Journal data, not Gear catalog)
  - Returns `validate.response` with `ValidationResult`
- Information barrier enforcement:
  - Sentinel module has NO imports from `journal/`
  - Sentinel handler receives stripped message (plan only, no user context)
  - ESLint `no-restricted-imports` rule enforced
  - `dependency-cruiser` rule: `sentinel/ → journal/` is forbidden

**Test Deliverables**:

- `tests/integration/sentinel-axis.test.ts`:
  - Sentinel registers with Axis
  - Validation request dispatched and response received
  - Information barrier verified (Sentinel handler never receives user message or Journal data)

**Test Deliverables** (security):

- `tests/security/sentinel-barrier.test.ts`:
  - Verify Sentinel cannot access Journal data
  - Verify Sentinel cannot see original user messages
  - Verify plan with embedded user context is rejected if smuggled through metadata

---

## Phase 5: Gear — Plugin System

**Goal**: Build the sandboxed plugin runtime with manifest validation and the 3 built-in Gear for v0.1 (file-manager, web-fetch, shell).

**Architecture References**: Section 5.6 (Gear), Section 9.3 (Gear API)

---

### Phase 5.1: Gear Manifest & Registry

**PR Scope**: Manifest parsing, validation, and the Gear registry in SQLite.

**Deliverables** (`src/gear/`):

- `manifest.ts`:
  - Parse and validate `GearManifest` (Section 5.6.2)
  - JSON Schema validation for all manifest fields
  - Permission structure validation (filesystem paths, network domains, secret names)
  - Resource limit validation with defaults (256 MB memory, 50% CPU, 5 min timeout, `maxNetworkBytesPerCall`)
  - Checksum computation (SHA-256 of Gear package)
  - Vulnerability scanning at install time: check manifest and dependencies against known patterns (Section 5.6.4)
- `registry.ts`:
  - CRUD operations on `gear` table in `meridian.db`
  - `install(manifest, packagePath): Promise<void>` — validates, computes checksum, stores
  - `uninstall(gearId): Promise<void>`
  - `get(gearId): Promise<GearManifest | undefined>`
  - `list(filter?): Promise<GearManifest[]>`
  - `enable(gearId) / disable(gearId)`
  - `updateConfig(gearId, config): Promise<void>` — update Gear-specific configuration (`config_json` column)
  - Built-in Gear auto-registered on first startup (origin: `'builtin'`)

**Test Deliverables**:

- `src/gear/manifest.test.ts`:
  - Valid manifest passes validation
  - Missing required fields rejected
  - Invalid permission patterns rejected
  - Checksum computation correctness
- `src/gear/registry.test.ts`:
  - Install/uninstall/list operations
  - Built-in auto-registration
  - Enable/disable toggle

---

### Phase 5.2: Process Sandbox (Level 1)

**PR Scope**: `child_process.fork()` sandbox with OS-level restrictions.

**Deliverables** (`src/gear/`):

- `sandbox/process-sandbox.ts` — Level 1 sandbox (Section 5.6.3, ~10-15 MB overhead, 50-150ms cold start):
  - `child_process.fork()` with restricted environment
  - OS-level restrictions:
    - macOS: `sandbox-exec` profiles to restrict syscalls
    - Linux: `seccomp` BPF filtering to restrict syscalls
  - Filesystem isolation: only declared paths accessible
  - Resource limits: memory and CPU via OS mechanisms (cgroups on Linux, process limits on macOS)
  - Sandbox lifecycle: create → mount workspace → inject secrets → execute → collect output → destroy
  - Secrets injection via tmpfs-mounted files at `/run/secrets/<name>` (NOT environment variables, per Section 5.6.3)
  - Communication: JSON over stdin/stdout with HMAC-SHA256 signing (v0.1)
  - Execution-time integrity check: re-compute SHA-256 of Gear package, verify against stored checksum (Section 5.6.3)
  - If checksum mismatch: block execution, disable Gear, notify user
- `sandbox/gear-host.ts` — Host-side Gear communication:
  - Spawn sandbox process
  - Send action request (JSON, signed)
  - Receive result (JSON, verified)
  - Timeout enforcement (per step timeout)
  - Clean kill on timeout: SIGTERM → 10s grace → SIGKILL
  - Progress reporting via structured stdout messages
  - **Output provenance tagging**: gear-host automatically wraps ALL Gear output with `source: "gear:<gear-id>"` provenance tag before returning results to Axis (Section 6.2 LLM01). This is applied uniformly at the host level, not within individual Gear implementations.

**Test Deliverables**:

- `src/gear/sandbox/process-sandbox.test.ts`:
  - Sandbox creation and teardown
  - Filesystem isolation (cannot read outside declared paths)
  - Secret injection via tmpfs
  - Timeout enforcement
  - HMAC signature verification
  - Checksum integrity check
- `tests/security/sandbox-escape.test.ts`:
  - Attempt to read `/etc/passwd` (should fail)
  - Attempt to access undeclared network (should fail)
  - Attempt to read environment variables for secrets (should fail — secrets are tmpfs files)

---

### Phase 5.3: Gear Context Implementation

**PR Scope**: The constrained API available to Gear code inside the sandbox.

**Deliverables** (`src/gear/`):

- `context.ts` — `GearContext` implementation (Section 9.3):
  - `params`: Read parameters passed to the action
  - `getSecret(name)`: Read allowed secrets (only those declared in manifest, ACL enforced)
  - `readFile(path)`: Read files within declared paths only
  - `writeFile(path, content)`: Write files within declared paths only
  - `listFiles(dir)`: List files within declared paths only
  - `fetch(url, options)`: Network requests to declared domains only
  - `log(message)`: Append to execution log
  - `progress(percent, message)`: Update progress for Bridge UI
  - `createSubJob(description)`: Spawn sub-tasks (goes through full Axis → Scout → Sentinel pipeline)
  - **Filesystem access enforcement**: paths canonicalized, `..` resolved, checked against manifest
  - **Network access enforcement**: URL domain checked against manifest `permissions.network.domains`
  - **Private IP filtering**: 10.x, 172.16.x, 192.168.x, 127.x blocked by default for Gear network requests (Section 6.5)
  - **DNS rebinding prevention**: DNS resolution filtered to prevent DNS rebinding attacks — resolved IPs checked against private ranges even after DNS resolution (Section 6.5)
- `sandbox/gear-runtime.ts` — Runs inside the sandbox process:
  - Receives `GearContext` proxy from host
  - Loads and executes Gear code
  - Marshals results back to host via stdout JSON

**Test Deliverables**:

- `src/gear/context.test.ts`:
  - File operations respect declared paths
  - Undeclared file access rejected
  - Network requests respect declared domains
  - Undeclared network requests blocked
  - Private IP ranges blocked
  - Secret ACL enforcement
  - Sub-job creation routes through Axis

---

### Phase 5.4: Built-in Gear — file-manager

**PR Scope**: First built-in Gear — file operations within the workspace.

**Deliverables** (`src/gear/builtin/file-manager/`):

- `manifest.json`:
  - id: `file-manager`
  - origin: `builtin`
  - Actions: `read_file`, `write_file`, `list_files`, `search_files`, `delete_file`
  - Permissions: filesystem read/write within `data/workspace/`
  - Risk levels: read=low, write=medium, delete=high
- `index.ts` — Implementation:
  - `read_file`: Read file contents at given path
  - `write_file`: Write content to file at given path (creates directories)
  - `list_files`: Recursive directory listing with optional glob filter
  - `search_files`: Text search within files (grep-like)
  - `delete_file`: Delete file (high risk, always requires approval)
  - Path traversal prevention: canonicalize all paths, reject `..` sequences

**Test Deliverables**:

- `src/gear/builtin/file-manager/index.test.ts`:
  - All 5 actions work correctly
  - Path traversal attempts blocked
  - Delete requires high risk classification

---

### Phase 5.5: Built-in Gear — web-fetch

**PR Scope**: Web page fetching Gear.

**Deliverables** (`src/gear/builtin/web-fetch/`):

- `manifest.json`:
  - id: `web-fetch`
  - origin: `builtin`
  - Actions: `fetch_page`, `fetch_json`
  - Permissions: network access (all HTTPS domains by default)
  - Risk level: low
- `index.ts`:
  - `fetch_page`: Fetch URL, return HTML content (with optional text extraction)
  - `fetch_json`: Fetch URL, parse and return JSON
  - URL validation: reject private IP ranges, validate HTTPS
  - Content size limit enforcement
  - Provenance tagging on returned content (`source: "gear:web-fetch"`)

**Test Deliverables**:

- `src/gear/builtin/web-fetch/index.test.ts`:
  - Successful page fetch (mock HTTP)
  - Private IP rejection
  - Content size limit enforcement
  - Provenance tagging on output

---

### Phase 5.6: Built-in Gear — shell

**PR Scope**: Shell command execution Gear with special hardening.

**Deliverables** (`src/gear/builtin/shell/`):

- `manifest.json`:
  - id: `shell`
  - origin: `builtin`
  - Actions: `execute`
  - Permissions: `shell: true`
  - Risk level: `critical`
- `index.ts`:
  - `execute`: Run a shell command, return stdout/stderr/exit code
  - **Hardening** (Section 5.6.5):
    - Disabled by default: must be explicitly enabled by user
    - Exempt from Sentinel Memory auto-approval: every command requires fresh user approval
    - No parameter interpolation into commands (structured data only)
    - Output size limit enforcement
    - Timeout enforcement
  - Large output handling: writes to `data/workspace/` and returns file reference

**Test Deliverables**:

- `src/gear/builtin/shell/index.test.ts`:
  - Command execution with stdout/stderr capture
  - Disabled by default
  - Timeout enforcement
  - Output size limiting
- `tests/security/shell-gear.test.ts`:
  - Cannot bypass approval requirement
  - No command injection via parameters

---

### Phase 5.7: Gear Integration & Index

**PR Scope**: Wire Gear system together, register with Axis.

**Deliverables**:

- `src/gear/index.ts` — Public API:
  - `createGearRuntime(config): GearRuntime`
  - Registers as message handler with Axis for `execute.request` messages
  - Handles `execute.request`:
    1. Look up Gear in registry
    2. Verify integrity (checksum)
    3. Create sandbox
    4. Inject secrets
    5. Execute action
    6. Collect results
    7. Destroy sandbox
    8. Return `execute.response`
- Auto-registration of built-in Gear during startup

**Test Deliverables**:

- `tests/integration/gear-axis.test.ts`:
  - Execute request dispatched through Axis
  - Sandbox created and destroyed
  - Results returned correctly
  - Integrity check failure blocks execution

---

## Phase 6: Bridge — Backend API

**Goal**: Build the Fastify HTTP server, REST API endpoints, WebSocket real-time streaming, and authentication.

**Architecture References**: Section 5.5 (Bridge), Section 9.2 (External API), Section 6.3 (Auth)

---

### Phase 6.1: Fastify Server & Authentication

**PR Scope**: HTTP server setup, security headers, password auth, session management.

**Deliverables** (`src/bridge/api/`):

- `server.ts`:
  - Fastify server creation
  - Bind to `127.0.0.1` by default (Section 6.5)
  - Configurable port (default: 3000)
  - Security headers on all responses (Section 6.5.1):
    - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* wss://localhost:*; frame-ancestors 'none'`
    - `X-Content-Type-Options: nosniff`
    - `X-Frame-Options: DENY`
    - `Referrer-Policy: strict-origin-when-cross-origin`
    - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
    - `Strict-Transport-Security` (conditional: only when TLS is enabled, see Phase 9.7)
  - CORS: only exact Bridge origin, no wildcard
  - Rate limiting: 100 requests/minute default (Section 9.2)
  - Response credential filtering: scan outgoing responses for common credential patterns (API keys, tokens, passwords) before sending to client (Section 6.2 LLM02)
  - System prompt leakage detection: if Scout's output contains fragments of its system prompt, flag for review (Section 6.2 LLM07)
- `auth.ts`:
  - Password creation during onboarding (stored as bcrypt hash in encrypted SQLite)
  - Login endpoint with password verification
  - Session tokens: cryptographically random, HTTP-only, Secure, SameSite=Strict
  - Configurable session duration (default: 7 days)
  - Brute-force protection: exponential backoff after 5 failures, lockout after 20 (Section 6.3)
  - CSRF protection: per-session tokens in `X-CSRF-Token` header on all state-changing requests (Section 6.5.4)
  - Per-job approval nonce for the approval endpoint
- `middleware.ts`:
  - Authentication middleware (session cookie or Bearer token)
  - CSRF validation middleware
  - Rate limiting middleware

**Test Deliverables**:

- `src/bridge/api/server.test.ts`:
  - Security headers present on all responses
  - Binds to 127.0.0.1
  - Rate limiting enforced
- `src/bridge/api/auth.test.ts`:
  - Password hash and verify round-trip
  - Session token creation and validation
  - Brute-force protection (exponential backoff)
  - CSRF token validation
- `tests/security/auth.test.ts`:
  - Session hijacking resistance (HTTP-only, Secure, SameSite)
  - Brute-force protection
  - CSRF protection

---

### Phase 6.2: REST API Endpoints

**PR Scope**: All REST endpoints with Fastify schema validation.

**Deliverables** (`src/bridge/api/`):

- `routes/messages.ts`:
  - `POST /api/messages` — Send message (creates job via Axis)
  - `GET /api/messages` — List conversation messages (with pagination)
- `routes/jobs.ts`:
  - `GET /api/jobs` — List jobs (with status filter, pagination)
  - `GET /api/jobs/:id` — Get job details (plan, validation, result, error)
  - `POST /api/jobs/:id/approve` — Approve pending job (requires per-job nonce)
  - `POST /api/jobs/:id/cancel` — Cancel a job
- `routes/conversations.ts`:
  - `GET /api/conversations` — List conversations
  - `POST /api/conversations` — Create new conversation
  - `GET /api/conversations/:id` — Get conversation with messages
  - `PUT /api/conversations/:id/archive` — Archive conversation (prevents new messages, preserves history)
- `routes/memories.ts`:
  - `GET /api/memories` — List memories (filter by type, date, keyword; paginated)
  - `PUT /api/memories/:id` — Update a memory entry
  - `DELETE /api/memories/:id` — Delete a memory entry
  - `POST /api/memories/export` — Export memories (JSON/Markdown)
  - `PUT /api/memories/pause` — Pause/resume memory recording
  - Note: Journal storage is stubbed in v0.1; these endpoints are wired to the full Journal in Phase 10.1
- `routes/gear.ts`:
  - `GET /api/gear` — List installed Gear
  - `POST /api/gear/install` — Install Gear (manifest review required, displays permission manifest for user review)
  - `DELETE /api/gear/:id` — Uninstall Gear
  - `PUT /api/gear/:id/enable` / `PUT /api/gear/:id/disable`
- `routes/config.ts`:
  - `GET /api/config` — Get configuration (secrets redacted)
  - `PUT /api/config` — Update configuration
- `routes/health.ts`:
  - `GET /api/health/live` — Liveness probe (returns 200 after startup step 1)
  - `GET /api/health/ready` — Readiness probe (returns 200 after step 6, 503 during startup)
  - `GET /api/health` — Full health check with component status (Section 12.3)
- `routes/audit.ts`:
  - `GET /api/audit` — Query audit log with date range, actor, action filters
- `routes/secrets.ts`:
  - `GET /api/secrets` — List secret metadata (names and ACLs, never values)
  - `POST /api/secrets` — Store a new secret
  - `DELETE /api/secrets/:name` — Delete a secret
  - `PUT /api/secrets/:name/acl` — Update secret ACL
- All routes use Fastify schema validation (JSON Schema for request/response bodies)
- All state-changing endpoints require CSRF token

**Test Deliverables**:

- Route-level tests for each endpoint (happy path + error cases)
- Schema validation tests (malformed input rejected)
- Authentication required on all endpoints

---

### Phase 6.3: WebSocket Server

**PR Scope**: Real-time event streaming and authenticated WebSocket connections.

**Deliverables** (`src/bridge/api/`):

- `websocket.ts`:
  - WebSocket endpoint at `/api/ws` using `ws` via Fastify plugin
  - Authentication flow (Section 6.5.2):
    1. Origin validation during HTTP upgrade
    2. Session cookie validation during HTTP upgrade
    3. One-time connection token as first message (consumed on use, no replay)
    4. Periodic re-validation every 15 minutes (close with `4001 Session Expired` if invalid)
  - Rate limiting: 60 messages per minute per connection
  - Ping/pong heartbeat: 30s interval, 10s timeout (Section 11.5)
  - Connections missing 2 consecutive pongs terminated
  - Message types (discriminated union per Section 9.2):
    - `chunk` — Token-by-token streaming from Scout
    - `status` — Job status updates
    - `approval_required` — Sentinel escalation with plan and risks
    - `result` — Job completion result
    - `error` — Error messages
    - `notification` — System notifications
    - `progress` — Step-by-step progress
    - `connected` — Initial connection with session ID
    - `ping` / `pong` — Keepalive
  - Connection token endpoint: `POST /api/ws/token` (REST endpoint issuing one-time WS tokens)

**Test Deliverables**:

- `src/bridge/api/websocket.test.ts`:
  - Authentication flow (all 5 steps)
  - Message serialization/deserialization for each type
  - Rate limiting enforcement
  - Ping/pong timeout detection
  - Re-validation of expired sessions

---

### Phase 6.4: Bridge Backend Integration & Index

**PR Scope**: Wire Bridge backend together with Axis, export public API.

**Deliverables**:

- `src/bridge/api/index.ts`:
  - `createBridgeServer(config, axis): BridgeServer`
  - Server connects to Axis for dispatching messages and receiving events
  - WebSocket broadcasts job events to connected clients
  - Static file serving for frontend SPA (production mode)
- Integration wiring:
  - `POST /api/messages` → creates message in DB → creates job via Axis → returns job ID
  - Job status changes propagated via WebSocket
  - Approval requests forwarded via WebSocket `approval_required` message

**Test Deliverables**:

- `tests/integration/bridge-axis.test.ts`:
  - Message submission creates job
  - Job status updates received via WebSocket
  - Approval flow end-to-end (request → display → approve → execute)

---

## Phase 7: Bridge — Frontend SPA

**Goal**: Build the React single-page application with dual-mode interface (Chat + Mission Control), onboarding wizard, and real-time streaming.

**Architecture References**: Section 5.5.2-5.5.14 (Bridge UI)

---

### Phase 7.1: Frontend Project Setup

**PR Scope**: Initialize React SPA with build tooling, routing, theme system.

**Deliverables** (`src/bridge/ui/`):

- Vite configuration with React + TypeScript
- Tailwind CSS setup with dark mode as default (`dark:` variants, respects `prefers-color-scheme`)
- Zustand store setup (initial empty stores)
- React Router setup for SPA routing
- Base layout component with responsive breakpoints:
  - > = 1280px: side-by-side (conversation left, Mission Control right)
  - < 1280px: toggle between views, badge on MC toggle for pending approvals
- Theme system: dark mode default, light mode toggle
- Shared UI components: Button, Input, Dialog, Toast, Badge, Spinner, Card
- WebSocket client hook (`useWebSocket`) with reconnection logic
- API client with auth token handling and CSRF token management
- TypeScript types shared from `@meridian/shared` (WSMessage, etc.)

**Acceptance Criteria**:

- `npm run dev` serves the SPA at localhost
- Dark mode renders correctly
- Responsive layout switches at breakpoint

---

### Phase 7.2: Onboarding Wizard

**PR Scope**: Four-step first-run setup wizard (Section 5.5.4).

**Deliverables** (`src/bridge/ui/`):

- `pages/onboarding/`:
  - **Step 1 — Create Password** (~30s target):
    - Single password field with strength indicator
    - No username or email (single-user)
    - Calls `POST /api/auth/setup`
  - **Step 2 — Add AI Key** (~2min target):
    - Grid of provider logos (Anthropic pre-selected)
    - One key sufficient to start
    - UI does NOT mention "Scout" or "Sentinel" — just "AI provider key"
    - Test API call validation before proceeding
    - Key stored in secrets vault via API
  - **Step 3 — Choose Comfort Level** (~30s target):
    - Plain-language descriptions mapping to trust profiles:
      - "Ask me before doing anything" → Supervised
      - "Ask me for important stuff" → Balanced
      - "Just get it done" → Autonomous
    - Default: Supervised for first week
  - **Step 4 — First Message**:
    - Welcome screen with capabilities explanation
    - 3-4 clickable starter prompts (e.g., "Search the web for...", "Summarize this file...", "Set up a daily reminder...")
- Onboarding state tracked in `config` table

**Test Deliverables**:

- Component tests for each wizard step
- Password strength validation
- API key validation flow

---

### Phase 7.3: Conversation View (Chat)

**PR Scope**: Scrolling message thread with real-time streaming.

**Deliverables** (`src/bridge/ui/`):

- `pages/chat/`:
  - Message list with role-based styling (user, assistant, system)
  - Rich formatting: Markdown rendering, code blocks with syntax highlighting, tables, images
  - Real-time token streaming from WebSocket `chunk` messages
  - Typing indicator during planning ("Thinking...")
  - Running task reference cards inline with conversation:
    - Task name, progress percentage, "View progress" link to Mission Control
    - Conversation not blocked by running tasks
  - **Privacy visual indicator**: display when data is being transmitted externally vs processed locally, so the user always knows where their data is going (Section 7.1)
  - User-facing vocabulary module (Section 5.5.5): maps internal terms to user-friendly language (Scout planning → "Thinking...", Sentinel validating → "Checking safety...", Gear → "tool"/"skill", Sentinel Memory → "Trust settings"). Shared across all UI components.
  - Text input with Markdown support
  - `Cmd+Enter` to send message
  - `/` to focus chat input
  - Conversation sidebar: list, create new, archive
  - Auto-create new conversation after 30 minutes of inactivity
- Zustand store: `useConversationStore`
  - Active conversation ID
  - Messages list
  - Streaming state
  - Input state

**Test Deliverables**:

- Component tests for message rendering (various content types)
- Streaming message accumulation
- Keyboard shortcuts

---

### Phase 7.4: Mission Control (Dashboard)

**PR Scope**: Spatial, status-oriented view for monitoring and management.

**Deliverables** (`src/bridge/ui/`):

- `pages/mission-control/`:
  - **Active Tasks**: Real-time progress with step trackers (collapsible), elapsed time, progress percentage, Cancel button
  - **Pending Approvals**: Always-visible, prominent placement — actions waiting for user confirmation
  - **Recent Completions**: Last N completed tasks with outcome summaries
  - **Scheduled Jobs**: Upcoming and recurring tasks (v0.2, placeholder for now)
  - **System Health**: Connection status, resource usage, active Gear count (from `GET /api/health`)
- Loading states: "Thinking...", "Checking safety...", step tracker, retry indicator (Section 5.5.7)
- Empty states: "No active tasks" with suggestion, "No memories yet" explanation (Section 5.5.7)
- Zustand store: `useJobStore`
  - Active jobs list
  - Job status updates from WebSocket

**Test Deliverables**:

- Component tests for each dashboard section
- WebSocket status update handling
- Loading and empty state rendering

---

### Phase 7.5: Approval Dialog

**PR Scope**: User approval UI for Sentinel escalations.

**Deliverables** (`src/bridge/ui/`):

- `components/approval-dialog/`:
  - **Plain-language summary**: Non-technical explanation of what Meridian wants to do
  - **Step checklist**: Each step with color-coded risk indicator (green/yellow/orange/red per risk level)
  - **Three options**: Approve (proceed), Details (expand full plan), Reject (cancel with optional reason)
  - **Multi-step plans**: unified dialog showing all steps, "Review individually" option for per-step approve/deny
  - **Standing rule suggestion**: After user approves same action category N times (default: 5), suggest creating standing rule
  - User-facing vocabulary translation (Section 5.5.5):
    - Sentinel → "safety check"
    - `needs_user_approval` → "I need your OK before proceeding"
    - Gear → "tool" or "skill" in UI
    - Sentinel Memory → "Trust settings"
  - Calls `POST /api/jobs/:id/approve` with per-job nonce

**Test Deliverables**:

- Component tests for approval dialog rendering
- Risk indicator color mapping
- Approve/reject API calls
- Standing rule suggestion trigger after N approvals

---

### Phase 7.6: Error Communication & Settings

**PR Scope**: Error display, settings panel, developer mode.

**Deliverables** (`src/bridge/ui/`):

- `components/error-display/`:
  - Brief non-technical explanation
  - "See Details" expandable technical section
  - **Side-effect disclosure**: list what was already done before the error (Section 5.5.6)
  - Rollback option if available
  - Suggestion for next steps
- `pages/settings/`:
  - Trust profile selector (Supervised/Balanced/Autonomous)
  - Shell Gear enable/disable with persistent indicator when enabled (Section 5.6.5)
  - AI provider configuration (add/remove/edit keys)
  - Session management
  - **Developer mode** toggle (Section 5.5.5): shows internal component names, raw plan JSON, message routing, Sentinel reasoning
  - Same-provider warning banner when Scout and Sentinel use same LLM provider (Section 6.1.2)
- Command palette (Section 5.5.10):
  - `Cmd+K` — opens command palette for quick action search
  - Commands: new conversation, switch conversations, open settings, toggle developer mode, cancel running task, focus chat input
- Keyboard shortcuts:
  - `Escape` — dismiss dialog / cancel
  - `Cmd+.` — cancel running task

**Test Deliverables**:

- Error display component tests
- Settings persistence via API
- Developer mode toggle behavior

---

### Phase 7.7: Notification System & Accessibility

**PR Scope**: In-app notifications and accessibility foundations.

**Deliverables** (`src/bridge/ui/`):

- `components/notifications/`:
  - In-app toast notifications (always available, Section 5.5.12)
  - Browser push notifications (opt-in via Web Push API)
  - Notification queue management
  - External notifications via webhook (configured in settings, delivered via Gear) — placeholder for v0.2
- Accessibility (Section 5.5.14):
  - Keyboard navigation for all actions
  - ARIA labels on interactive elements
  - Focus management for dialogs and modals
  - Screen reader support for status updates
  - High contrast mode option
  - Configurable font size

**Test Deliverables**:

- Toast notification rendering and dismissal
- Keyboard navigation tests (axe-core or similar)
- ARIA attribute verification

---

## Phase 8: Integration, End-to-End Flows & v0.1 Release

**Goal**: Wire all components together, implement the complete request lifecycle, validate against the architecture's end-to-end user story traces, and prepare for v0.1 release.

**Architecture References**: Sections 4.5 (Request Lifecycle), 4.7 (User Story Traces), 16 (v0.1 criteria)

---

### Phase 8.1: Full Pipeline Integration

**PR Scope**: Connect Axis, Scout, Sentinel, Gear, and Bridge into the complete request lifecycle.

**Deliverables** (`src/`):

- `main.ts` — Application entry point:
  - Instantiates all components
  - Follows startup sequence (Section 5.1.14):
    1. Load config, init logging → liveness probe
    2. Open databases, run migrations
    3. Axis core startup
    4. Register Scout, Sentinel, Journal (stub), built-in Gear
    5. Crash recovery
    6. Bridge startup → readiness probe
    7. Begin processing queue
  - Graceful shutdown on SIGTERM/SIGINT
- Complete request lifecycle (Section 4.5):
  1. **Ingestion**: Message received via Bridge
  2. **Normalization**: Standard message format with metadata
  3. **Routing**: Axis creates Job, dispatches to Scout
  4. **Path Selection**: Inspect Scout output shape (text vs JSON plan)
  5. **Planning** (full path): Scout produces `ExecutionPlan`
  6. **Validation**: Axis sends plan to Sentinel (not user message)
  7. **User Approval** (if needed): Route through Bridge
  8. **Execution**: Dispatch to Gear in sandbox
  9. **Result Collection**: Gear returns results; failures route to Scout for replanning
  10. **Response**: Results through Bridge to user
  11. **Reflection**: Stubbed for v0.1 (Journal only stores conversation history)
- Conversation threading (Section 4.6):
  - Jobs from same conversation execute serially
  - Jobs from different conversations execute concurrently
  - New conversation on explicit user action or 30 minutes inactivity
  - Title populated by Scout after first exchange
- Graceful degradation (Section 4.4):
  - Scout API unreachable: queue, retry with backoff, notify after first failure
  - Sentinel API unreachable: queue validation (rule-based in v0.1 doesn't use API, but structure is ready)
  - Gear sandbox failure: report error, ask Scout to replan without that Gear
  - Journal database corrupted: continue without memory

**Test Deliverables**:

- `tests/integration/full-pipeline.test.ts`:
  - Message → Job → Scout → Sentinel → Gear → Response (with mock LLM)
  - Fast path flow end-to-end
  - Full path with approval flow
  - Conversation serial execution
  - Graceful degradation scenarios

---

### Phase 8.2: End-to-End User Story Validation

**PR Scope**: Implement and test the 3 user story traces from Section 4.7 as acceptance tests.

**Deliverables**:

- `tests/integration/user-stories.test.ts`:
  - **Story 1: Simple Question (Fast Path)**:
    - "What time is it in Tokyo?"
    - Scout returns plain text → Axis fast-path verification → Bridge delivers
    - No Sentinel, no Gear, no Journal
    - Validate latency budget (fast path under 5 seconds with mock LLM)
  - **Story 2: File Task (Full Path)**:
    - "Find all TODO comments in my project and save them to todos.txt"
    - Scout produces 2-step plan (file-search + file-write)
    - `journalSkip: true`
    - Sentinel approves (read + workspace write = low risk)
    - Gear executes both steps
    - Journal reflection skipped
  - **Story 3: High-Risk Task with Approval**:
    - "Delete all .tmp files in my project"
    - Scout produces plan with `riskLevel: 'high'`
    - Sentinel returns `NEEDS_USER_APPROVAL`
    - Approval routed to Bridge → user approves
    - Gear executes deletion
    - Journal reflects on the interaction (v0.1: verify reflection hook is called; actual Journal reflection is stubbed — no-op behavior)

---

### Phase 8.3: Observability & Debugging Tools

**PR Scope**: Health checks, metrics endpoint, debugging tools.

**Deliverables**:

- Health endpoint implementation (Section 12.3):
  - `/api/health` returns structured response (Section 12.3): `version`, `uptime_seconds`, per-component `status` (Axis `queue_depth`, Scout `provider`, Sentinel `provider`, Journal `memory_count`, Bridge `active_sessions`)
- Metrics endpoint (Section 12.2):
  - `/api/metrics` (Prometheus format, opt-in)
  - Counters: `meridian_jobs_total`, `meridian_llm_calls_total`, `meridian_llm_tokens_total{provider,model,type}`, `meridian_gear_executions_total`, `meridian_sentinel_verdicts_total`
  - Histograms: `meridian_jobs_duration_seconds`, `meridian_llm_latency_seconds`
  - Gauges: `meridian_memory_count`, `meridian_system_memory_bytes`, `meridian_system_disk_bytes`
- Debugging tools (Section 12.4):
  - Job inspector in Bridge UI: original message, Scout plan, Sentinel validation, execution logs, final result
  - Dry run support: `POST /api/messages?dry_run=true` to see plan without executing
  - Event loop monitoring: `perf_hooks.monitorEventLoopDelay()` with p99 thresholds (Section 11.4)
  - Replay mode (Section 12.4): re-run a completed job with the same inputs for debugging
  - Sentinel explain (Section 12.4): view Sentinel's full reasoning for any approval or rejection
  - Memory watchdog with graduated responses (Section 11.4)

---

### Phase 8.4: Docker & Deployment Configuration

**PR Scope**: Docker image, Docker Compose, deployment documentation.

**Deliverables**:

- `docker/Dockerfile`:
  - Multi-stage build (build + runtime)
  - Node.js 20 LTS base
  - `no-new-privileges`, read-only root filesystem, tmpfs for temp
  - Deployment-tier-aware Node.js flags: `--max-old-space-size=2048` (desktop), `--max-old-space-size=1024` (RPi 8GB), `--max-old-space-size=512 --optimize-for-size` (RPi 4GB)
  - Note: RPi 4 GB model only viable without local Ollama; Ollama embeddings require 8 GB model (Section 10.1)
- `docker/docker-compose.yml` (Section 10.3):
  - `meridian` service with volume mounts, secrets, security options
  - `searxng` service (optional, for web search Gear)
  - Localhost-only port binding
- `scripts/install.sh` — Installation script for Mac Mini/RPi
- Configuration documentation:
  - Example `config.toml` with all options documented
  - Environment variable reference (`MERIDIAN_*`)
  - Deployment guides per target environment (Section 10.1)

---

### Phase 8.5: v0.1 Release Preparation

**PR Scope**: Final polish, release checklist, documentation.

**Deliverables**:

- `CHANGELOG.md` for v0.1
- Update mechanism (Section 10.5):
  - `meridian update --check` command (no automatic checks, no telemetry)
  - Pre-update backup
  - `meridian rollback` support
- Verify v0.1 success criteria (Section 16):
  - [ ] Install to first message in under 3 minutes
  - [ ] Fast-path response under 5 seconds
  - [ ] Simple task completes under 10 seconds
  - [ ] Approval flow works end-to-end
- Minimal Playwright E2E test suite (validates v0.1 success criteria in a real browser):
  - Onboarding flow: password → API key → trust profile → first message
  - Chat fast path: send question → receive response
  - Full path with approval: send action → approval dialog → approve → result
  - Note: full E2E suite expanded in Phase 10.7
- Run full test suite: unit, integration, security, E2E
- Verify all module boundaries enforced (`dependency-cruiser`)
- Tag and build v0.1.0

---

## Phase 9: v0.2 — Safety, Scheduling & Observability

**Goal**: Upgrade Sentinel to full LLM-based validation, add scheduling, signing, cost tracking, and additional Gear.

**Architecture References**: Section 16 Phase 2 (v0.2)

---

### Phase 9.1: Sentinel LLM Validation

**PR Scope**: Upgrade Sentinel from rule-based to full dual-LLM pipeline.

**Deliverables** (`src/sentinel/`):

- `llm-validator.ts`:
  - LLM-based plan evaluation using the Sentinel's independently configured provider/model
  - Evaluation against all validation categories (Section 5.3.2):
    - Fully assessable: security, privacy, financial, policy compliance, composite risk
    - Partially assessable: ethical (structural patterns only), legal (common patterns)
  - System prompt construction for Sentinel (no user message, no Journal data, no Gear catalog)
  - Structured output parsing for `ValidationResult`
- `plan-stripper.ts` — Plan stripping before Sentinel review (Section 5.3.2/5.3.7):
  - Strip all non-required fields from `ExecutionPlan` and `ExecutionStep`
  - Sentinel receives ONLY: `id`, `jobId`, `steps` (each with `id`, `gear`, `action`, `parameters`, `riskLevel`)
  - Prevents compromised Scout from embedding persuasive framing in free-form fields
- Same-provider warning: when Scout and Sentinel use same provider, log warning and show in Bridge

**Test Deliverables**:

- `src/sentinel/llm-validator.test.ts` — Mock LLM returns validation results, structured output parsing
- `src/sentinel/plan-stripper.test.ts` — All non-required fields removed, required fields preserved
- `tests/security/sentinel-llm.test.ts`:
  - Known-dangerous plans rejected
  - Information barrier maintained (no user context leaks)
  - Risk divergence anomaly logging

---

### Phase 9.2: Ed25519 Message Signing

**PR Scope**: Upgrade from shared HMAC to per-component Ed25519 keypairs.

**Architecture References**: Section 6.3

**Deliverables**:

- `src/shared/signing.ts`:
  - Ed25519 keypair generation per component
  - Private keys stored in encrypted vault
  - Public keys held by Axis
  - Ephemeral keypairs for Gear (valid per-execution only)
  - Message signing and verification
  - Replay protection: sliding window of message IDs, reject timestamps > 60s old
- Update `src/axis/router.ts` to verify signatures on all messages
- Update `src/gear/sandbox/` to use ephemeral keypairs

**Test Deliverables**:

- Sign/verify round-trip
- Reject forged signatures
- Reject replayed messages
- Ephemeral keypair lifecycle (created, used, destroyed)

---

### Phase 9.3: Additional Built-in Gear

**PR Scope**: Add web-search, scheduler, and notification Gear.

**Deliverables**:

- `src/gear/builtin/web-search/`:
  - Search via SearXNG or similar privacy-respecting engine
  - Actions: `search` (query → results list)
  - Permissions: network access to configured search engine
  - Risk level: low
- `src/gear/builtin/scheduler/`:
  - Actions: `create_schedule`, `update_schedule`, `delete_schedule`, `list_schedules`
  - Interacts with `schedules` table in `meridian.db`
  - Risk level: medium
- `src/gear/builtin/notification/`:
  - Actions: `send_notification`
  - In-app notifications through Bridge
  - Risk level: low

---

### Phase 9.4: Cron Scheduling

**PR Scope**: Time-based recurring job scheduling.

**Architecture References**: Section 5.1.5

**Deliverables** (`src/axis/`):

- `scheduler.ts`:
  - Cron-like recurring jobs stored in `schedules` table
  - Evaluation every 60 seconds
  - Cron expression parsing and validation
  - Job creation from schedule templates
  - Schedule enable/disable
  - Next-run calculation
- Bridge UI updates:
  - Scheduled jobs section in Mission Control
  - Create/edit/delete schedule UI

**Test Deliverables**:

- Cron expression parsing
- Job creation from schedule at correct times
- Enable/disable behavior

---

### Phase 9.5: Cost Tracking & Token Management

**PR Scope**: Per-task cost display, daily limits, cost dashboard.

**Architecture References**: Sections 11.2 (LLM Optimization)

**Deliverables**:

- `src/shared/cost-tracker.ts`:
  - Track token usage per API call (input, output, cached tokens)
  - Aggregate daily/weekly/monthly costs based on provider pricing
  - Alert at 80% and 95% of daily limit
  - Hard stop at daily limit (configurable override for critical tasks)
  - Token counting using `tiktoken` or provider-specific tokenizers
- Bridge UI: cost dashboard showing usage trends and per-task costs
- Provider pricing data: configurable pricing tables per provider/model

**Test Deliverables**:

- Token counting accuracy
- Cost aggregation calculations
- Alert threshold triggers
- Hard stop enforcement

---

### Phase 9.6: Approval Improvements, Circuit Breaker & Cross-DB Consistency

**PR Scope**: Batch approval, standing rules, circuit breaker (deferred from v0.1), cross-database consistency scanner.

**Deliverables**:

- `src/axis/circuit-breaker.ts` (Section 5.1.12, deferred from v0.1 per Section 16):
  - Track Gear failure counts
  - 3 consecutive failures within 5 minutes → temporarily disable Gear
  - Notify user when Gear is disabled
  - Auto-reset after configurable cooldown
- Approval improvements:
  - Batch approval for multi-step plans
  - Standing approval rules (after N same-category approvals, auto-create rule)
- Cross-database consistency (Section 8.6):
  - Consistency scanner: periodic detection of orphaned cross-DB references
  - Write-ahead audit enforcement
  - Application-managed cascades for deletion

---

### Phase 9.7: TLS, Audit Partitioning & LLM Eval Framework

**PR Scope**: TLS configuration, monthly audit partitioning, LLM evaluation framework, prompt versioning.

**Deliverables**:

- TLS configuration (Section 6.5.3):
  - Minimum TLS 1.2, prefer 1.3
  - AEAD cipher suites only
  - HSTS header when TLS enabled
  - OCSP stapling for Let's Encrypt
  - Let's Encrypt ACME support or user-provided certificate
- Audit partitioning:
  - Monthly database files (`audit-YYYY-MM.db`)
  - Current month is write target
  - Archived monthly files compressed after retention period (default 1 year)
- LLM evaluation framework (Section 13.6):
  - `tests/evaluation/` benchmark suite with graded difficulty
  - Evaluation dimensions: plan validity, Sentinel acceptance, true/false positive rates, memory recall
  - CI integration: runs on changes to Scout, Sentinel, Journal, or prompts
- Prompt versioning (Section 13.7):
  - Prompts in `src/<module>/prompts/` as versioned template files
  - Version metadata (version string, description, model compatibility)
  - Prompt changes trigger eval suite in CI
- Provider privacy summary cards (Section 7.3): display during provider configuration

---

### Phase 9.8: Multi-Provider Support & Database Encryption Option

**PR Scope**: Implement the additional LLM providers deferred from Phase 3.2, plus database encryption.

**Deliverables**:

- Implement Phase 3.2 deliverables (OpenAI, Google, Ollama, OpenRouter provider adapters)
- Sentinel configuration guidance in Bridge: surface recommendations during provider setup (different providers = high security, same provider different model = balanced, same model = budget per Section 5.3.6)
- Database-level encryption option:
  - `@journeyapps/sqlcipher` as configurable drop-in replacement for `better-sqlite3` (Section 8.1.1)
  - AES-256-CBC encryption with HMAC-SHA512 per page
  - Setup wizard recommends database-level encryption by default; for RPi on SD card, recommends filesystem-level encryption with tradeoff explanation
  - Storage detection in setup wizard: detect removable storage, warn user, recommend SSD (Section 10.1)
- Security patch notification: users notified on next Bridge login about available security patches (Section 15.4)

---

### Phase 9.9: DAG Execution, Conditional Steps & Step Output References

**PR Scope**: Implement DAG-based parallel step execution, conditional execution, and step output references (all v0.2 per architecture Section 5.2.2).

**Deliverables** (`src/axis/`):

- `dag-executor.ts` — Plan dependencies as DAG (Section 5.2.2):
  - `dependsOn` field fully utilized for step ordering
  - DAG-based execution: Axis computes topological order, dispatches independent steps with maximal parallelism
  - `$ref:step:<stepId>` placeholder resolution: step parameters can reference outputs of prior steps
  - Cycle detection at plan validation time (added to `plan-validator.ts`)
  - `parallelGroup` field support: steps in the same group run concurrently
- `condition-evaluator.ts` — Conditional execution (Section 5.2.2):
  - `StepCondition` evaluation: JSONPath against prior step results, LLM-evaluated booleans
  - Skipped steps marked as `skipped` (not `failed`)

**Test Deliverables**:

- `src/axis/dag-executor.test.ts`:
  - Topological ordering correctness
  - Parallel execution of independent steps
  - `$ref:step` placeholder resolution
  - Cycle detection rejection
- `src/axis/condition-evaluator.test.ts`:
  - JSONPath condition evaluation
  - Skipped step handling

---

### Phase 9.10: v0.2 Release Preparation

**PR Scope**: Final integration, release checklist, and documentation for v0.2.

**Deliverables**:

- `CHANGELOG.md` for v0.2
- Run full test suite: unit, integration, security, LLM evaluation
- Verify all v0.2 features integrated and functional:
  - [ ] LLM-based Sentinel validation works end-to-end
  - [ ] Ed25519 signing replaces HMAC for component messages
  - [ ] Cron scheduling creates and triggers jobs
  - [ ] Cost tracking displays accurate per-task costs
  - [ ] Multi-provider support works with all 5 providers
  - [ ] TLS configuration functional with Let's Encrypt
  - [ ] Circuit breaker activates after consecutive failures
- Verify all module boundaries still enforced (`dependency-cruiser`)
- Tag and build v0.2.0

---

## Phase 10: v0.3 — Memory & Learning

**Goal**: Implement Journal (full memory system), vector search, reflection pipeline, Sentinel Memory, container sandbox, encrypted backups, and E2E tests.

**Architecture References**: Section 16 Phase 3 (v0.3)

---

### Phase 10.1: Journal — Memory Storage & Retrieval

**PR Scope**: Implement the three memory types and hybrid search.

**Architecture References**: Section 5.4 (Journal)

**Deliverables** (`src/journal/`):

- `memory-store.ts`:
  - **Episodic memory** — chronological interactions, configurable retention (default 90 days), auto-summarization and archival
  - **Semantic memory** — distilled facts and preferences, persists indefinitely, updated when contradicted
  - **Procedural memory** — strategies and workflows, success/failure tracking
  - CRUD for all three types
  - User transparency API: view, edit, delete, export, pause recording (Section 5.4.6)
- `retrieval.ts` — Hybrid search (Section 5.4.5):
  - Recency: last N messages from current conversation
  - Semantic search: `sqlite-vec` extension for vector similarity (cosine distance)
  - Keyword search: SQLite FTS5 full-text search
  - Scored fusion: Reciprocal Rank Fusion (RRF) combining semantic + keyword results
  - Returns `MemoryResult[]` with relevance scores
- `embeddings.ts`:
  - Local embedding via Ollama (`nomic-embed-text`)
  - API-based embedding (OpenAI, Anthropic) as alternative
  - Batch embedding for multiple memories (batch into single API call per Section 11.2)
  - Dimensionality-reduced representations to resist reconstruction of original text (Section 6.2 LLM08)
- FTS5 content-sync triggers (Section 8.3):
  - `AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE` triggers on `facts`, `procedures`, `episodes`
  - Periodic FTS index rebuild during idle maintenance

**Test Deliverables**:

- Memory CRUD for all three types
- Hybrid search relevance (semantic + keyword fusion)
- FTS5 sync trigger correctness
- Embedding generation and storage

---

### Phase 10.2: Journal — Reflection Pipeline

**PR Scope**: Post-task reflection, memory extraction, and Gear Suggester briefs.

**Deliverables** (`src/journal/`):

- `reflector.ts` — Reflection pipeline (Section 5.4.3):
  - LLM-based analysis of completed tasks:
    1. Success or failure? Why?
    2. What worked well? What didn't?
    3. New facts about user or environment?
    4. Reusable patterns worth remembering?
    5. Contradictions with existing memories?
    6. Could a new Gear address a recurring gap?
  - Runs asynchronously (does not block user response)
  - Journal-skip logic: skip for simple info-retrieval; always reflect on failures
  - PII reduction before writing to long-term memory:
    - Pass 1: regex for structured PII (emails, phone numbers, SSNs)
    - Pass 2: LLM review for contextual PII (names in narrative, indirect identifiers)
  - Memory staging: 24-hour review period before entering long-term storage
  - **Memory fact validation** (Section 6.2 LLM04): Reflector validates extracted facts for consistency with existing semantic memory before writing — contradictory or suspicious facts are flagged rather than silently stored
  - **Instruction/data classifier** (Section 6.2, LLM01 multi-hop defense): Before writing Gear output or external content to Journal memory, the Reflector applies a classifier. Content resembling instructions (imperative sentences, system-prompt-like phrasing) is flagged for review rather than stored as trusted memory.
- `memory-writer.ts`:
  - Extract and write semantic facts
  - Update procedural memory (strategies, patterns)
  - Create episode summaries
  - Conflict resolution: reduce confidence of contradicted memories
- `gear-suggester.ts` — Gear Suggester (v0.4 scope, but interface defined now):
  - Produces **structured Gear brief** (NOT executable code):
    - Problem description
    - Proposed solution
    - Example input/output
    - Manifest skeleton
    - Pseudocode
  - Triggers: multi-step manual orchestration, failed task with identifiable pattern, repeated failures, explicit user request
  - Output stored in `workspace/gear/` with `origin: "journal"`, flagged for user review

**Test Deliverables**:

- Reflection pipeline produces correct memory updates
- PII reduction catches structured PII (email, phone patterns)
- Journal-skip respected for simple tasks
- Failure always reflected regardless of skip flag
- Gear Suggester brief structure validation

---

### Phase 10.3: Sentinel Memory

**PR Scope**: Isolated approval decision store with matching semantics.

**Architecture References**: Section 5.3.8

**Deliverables** (`src/sentinel/`):

- `memory.ts`:
  - Store user approval/denial decisions in `sentinel.db` (isolated from Journal)
  - Decision matching before LLM validation:
    - Match found (allow, not expired) → auto-approve
    - Match found (deny, not expired) → auto-reject
    - No match → proceed to LLM validation
  - Matching semantics:
    - Action type: exact string match only
    - Scope — file operations: prefix match on directory boundaries (canonicalized paths)
    - Scope — network: exact domain match
    - Scope — financial: numeric comparison
    - Shell commands: excluded entirely (always require fresh approval)
  - Cap: 500 active decisions, oldest evicted when exceeded
  - Optional expiry on decisions (security-sensitive approvals default to 24h)
  - Shell commands (`shell.execute`) excluded from Sentinel Memory entirely — every shell command requires fresh approval regardless of prior decisions (Section 5.3.8)
  - Isolation guarantees: only Sentinel reads/writes, Scout cannot access
- Bridge UI: Trust Settings page for viewing/revoking/managing Sentinel Memory decisions

**Test Deliverables**:

- Decision storage and retrieval
- Matching semantics for each scope type
- Shell command exclusion
- Cap enforcement and eviction
- Expiry handling
- Isolation (other components cannot access)

---

### Phase 10.4: Container Sandbox (Docker)

**PR Scope**: Level 3 Gear sandbox using Docker containers.

**Architecture References**: Section 5.6.3

**Deliverables** (`src/gear/sandbox/`):

- `container-sandbox.ts`:
  - Container per Gear execution
  - Read-only root filesystem
  - No host network access; traffic through filtered proxy
  - Resource limits via Docker (memory, CPU, pids)
  - Automatic container destruction after completion
  - Secrets via tmpfs mount (not env vars)
  - Workspace mount (read-only by default)
  - Communication: JSON over stdin/stdout
- Level 2 (`isolated-vm`) sandbox:
  - V8 isolate with own heap
  - No Node.js APIs unless explicitly bridged
  - Memory and CPU limits via V8
- Sandbox level selection based on Gear manifest and deployment configuration

**Test Deliverables**:

- Container sandbox creation and teardown
- Resource limit enforcement
- Filesystem isolation
- Network filtering
- `tests/security/container-escape.test.ts` — escape attempt testing

---

### Phase 10.5: Gear Signing, Encrypted Backups & Audit Integrity

**PR Scope**: Manifest signing, backup encryption, audit hash chain.

**Deliverables**:

- Gear signing (Section 5.6.6):
  - Cryptographic signature of manifest + code
  - Signature verification on install and execution
  - Configurable: allow/deny unsigned Gear
- Encrypted backups (Section 8.4):
  - Daily automated backup of all SQLite databases
  - AES-256-GCM encryption for backup files
  - Backup rotation: 7 daily, 4 weekly, 3 monthly
  - `PRAGMA integrity_check` after each backup
  - `meridian restore <backup-path>` command
  - `meridian export` for full portable archive
- Audit integrity chain (Section 6.6):
  - `previousHash`: SHA-256 of preceding entry
  - `entryHash`: SHA-256 of entry's canonical form
  - Bridge "Audit Integrity" panel for chain verification
  - Detects casual tampering and accidental corruption

---

### Phase 10.6: Data Retention, Right to Deletion & Idle Maintenance

**PR Scope**: Automated data lifecycle management, user deletion rights, and background maintenance.

**Deliverables**:

- `src/shared/retention.ts` — Data retention enforcement (Section 7.4):
  - Conversation messages: auto-archive after 90 days (configurable)
  - Episodic memories: auto-summarize and archive after 90 days
  - Gear execution logs: purge after 30 days (configurable)
  - Audit logs: archive monthly files after 1 year (configurable)
  - Runs during idle maintenance
- `src/shared/data-deletion.ts` — Right to deletion (Section 7.5):
  - `deleteAllUserData(): Promise<void>`:
    1. Purge all conversation history
    2. Delete all memory entries (episodic, semantic, procedural)
    3. Clear the workspace
    4. Remove all stored secrets
    5. Reset all configuration to defaults
    6. Audit logs retained (no user content, only action records)
  - API endpoint: `POST /api/data/delete-all`
- `src/axis/maintenance.ts` — Idle maintenance scheduler:
  - `ANALYZE` on all databases periodically
  - `INCREMENTAL VACUUM` on all databases
  - FTS5 index rebuild check (rebuild if last rebuild > 7 days)
  - Memory reflection backlog processing
  - Backup operations (daily automated backups)
  - Runs during idle periods (no active jobs)

**Test Deliverables**:

- Retention enforcement: correct archival/deletion by age
- Right to deletion: complete data purge verification
- Idle maintenance: runs only when idle, completes correctly

---

### Phase 10.7: E2E Tests, Memory UI & v0.3 Release

**PR Scope**: Playwright browser tests, memory management UI, v0.3 release prep.

**Deliverables**:

- `tests/e2e/`:
  - Onboarding flow: password → API key → trust profile → first message
  - Chat flow: send message → see response (fast path)
  - Full path flow: send action → approval dialog → approve → result
  - Mission Control: view active tasks, pending approvals, completions
  - Memory browser: view, search, edit, delete memories
  - Trust settings: view/revoke Sentinel Memory decisions
- Bridge UI — Memory browser (`pages/memory/`):
  - Browse all memories filtered by type, date, keyword
  - Edit memory entries
  - Delete individual memories
  - Export memories (JSON/Markdown)
  - Pause memory recording toggle
- Bridge UI — Input modalities:
  - Image upload (file upload or clipboard paste, sent as base64 or file reference)
  - File drag-and-drop upload (stored in workspace)
- Prompt injection test suite (`tests/security/prompt-injection.test.ts`):
  - Curated set of direct and indirect prompt injection attempts
  - Verified against both Scout and Sentinel
  - Regression test cases from real-world failures
- `CHANGELOG.md` for v0.3, tag and build v0.3.0

---

## Phase 11: v0.4 — Growth & Ecosystem

**Goal**: Activate the Gear Suggester, implement adaptive model selection, MCP compatibility, voice input, TOTP, and the Gear SDK.

**Architecture References**: Section 16 Phase 4 (v0.4+)

---

### Phase 11.1: Gear Suggester & Adaptive Model Selection

**PR Scope**: Activate the Gear Suggester pipeline and implement adaptive model routing.

**Deliverables**:

- Gear Suggester activation (Section 5.4.4):
  - End-to-end flow: task execution → Journal reflection → Gear brief generation → user notification
  - Gear brief review UI in Bridge
  - User actions: implement from brief, refine brief, dismiss
  - Journal notes rejection when dismissed
- Adaptive model selection (Section 5.2.6):
  - `secondary` model configuration now active
  - Task-type routing:
    - Secondary: simple single-step Gear ops, summarization, parsing, parameter generation
    - Primary: multi-step planning, complex reasoning, replanning, novel requests
  - Model decision logged in job metadata

---

### Phase 11.2: MCP Compatibility & Gear SDK

**PR Scope**: MCP integration and the standalone Gear development toolkit.

**Deliverables**:

- MCP compatibility (Section 9.4):
  - Gear-as-MCP-server: expose Gear actions as MCP tools
  - MCP-server-as-Gear: wrap existing MCP servers with Meridian sandboxing
  - Scout native MCP tool-use when provider supports it
- Gear SDK (`@meridian/gear-sdk`):
  - Standalone npm package for third-party Gear developers
  - Type definitions, manifest schema, testing utilities
  - Documentation and examples

---

### Phase 11.3: Voice Input & TOTP

**PR Scope**: Voice input modality and two-factor authentication.

**Deliverables**:

- Voice input (Section 5.5.9):
  - Web Speech API for recording
  - Whisper API (or local whisper.cpp) for transcription
  - Voice indicator in Bridge UI
- TOTP (Section 5.5.13):
  - Optional two-factor authentication
  - TOTP setup flow in settings
  - QR code generation for authenticator apps

---

### Phase 11.4: Plan Replay Cache, Semantic Cache & v0.4 Release

**PR Scope**: Performance optimizations via caching, and v0.4 release preparation.

**Deliverables**:

- Plan replay cache:
  - Skip Scout for known patterns (identical plans for repeated scheduled tasks)
  - Cache keyed on normalized plan inputs
- Semantic response cache (Section 11.2):
  - For identical or near-identical queries, return cached LLM response
  - Embedding similarity threshold > 0.98
  - Per-user, per-model, 24h expiry
  - Time-sensitive queries bypass cache
- Sentinel approval caching:
  - Identical plans (common for scheduled tasks) reuse cached approvals
- `CHANGELOG.md` for v0.4, tag and build v0.4.0

---

## Appendix A: Deferred Items & Feasibility Notes

### Deferred Indefinitely (v1.0+)

Per Section 16, these are explicitly deferred:

| Feature                                                    | Status   | Notes                                                                                                                                                |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-user support                                         | Deferred | Requires auth model rework, RBAC, data isolation per user                                                                                            |
| Messaging platform integrations (Telegram, Discord, Slack) | Deferred | Would be Gear-based, no core architecture changes needed                                                                                             |
| Gear marketplace                                           | Deferred | Requires trust infrastructure, review pipeline, hosting                                                                                              |
| Full local LLM as primary provider                         | Deferred | Quality may not meet Scout planning requirements on constrained devices                                                                              |
| Agent-to-agent federation                                  | Deferred | Requires protocol design, trust model across instances                                                                                               |
| Proactive behavior                                         | Deferred | Requires event-driven triggering, careful safety design                                                                                              |
| Video input processing                                     | Deferred | High compute requirement, complex processing pipeline                                                                                                |
| Full WCAG 2.1 AA accessibility                             | Deferred | Partial in v0.1 (keyboard, ARIA); full compliance is ongoing effort. Architecture sets WCAG 2.1 AA as a target (Section 5.5.14), tracked as ongoing. |
| Prometheus metrics export                                  | Deferred | `/api/metrics` endpoint defined but Prometheus-format export is opt-in                                                                               |
| Event-driven scheduling                                    | Deferred | Jobs triggered by webhooks, filesystem changes (Section 5.1.5)                                                                                       |
| `@meridian/cli` package                                    | v0.2+    | Published npm artifact (Section 15.1) — defer until distribution packaging                                                                           |

### Feasibility Notes

1. **seccomp/sandbox-exec Gear sandboxing** (Phase 5.2): macOS `sandbox-exec` is deprecated by Apple and may be removed in future macOS versions. The architecture acknowledges this by providing Level 2 (`isolated-vm`) and Level 3 (Docker) as alternatives. For production macOS deployments, recommend Level 2 or Level 3. Level 1 with `sandbox-exec` is acceptable for development but should not be the sole sandbox mechanism on macOS in the long term.

2. **sqlite-vec extension** (Phase 10.1): The `sqlite-vec` extension is relatively new. If it proves unstable or has compatibility issues with `better-sqlite3` / `@journeyapps/sqlcipher`, a fallback plan is to use a separate lightweight vector store (e.g., `hnswlib-node`) or API-based vector search. This should be validated early in Phase 10.1.

3. **Secrets as Buffer with zeroing** (Phase 1.6): Node.js garbage collection cannot be forced, and V8 may copy Buffer data internally. The `buffer.fill(0)` approach is a best-effort defense. The architecture acknowledges this and mentions a potential future N-API addon for managing secret memory outside the V8 heap. For v0.1, the Buffer approach is sufficient.

4. **PII reduction** (Phase 10.2): The architecture explicitly states that NER achieves only 85-92% recall. The two-pass approach (regex + LLM) in v0.3 improves coverage but cannot guarantee complete PII removal. This is documented as a known limitation, not a bug.

5. **Single-binary distribution** (Section 10.2): The architecture notes that `pkg` is unmaintained and incompatible with native modules. Distribution remains as Node.js application or Docker image. No workaround needed — this is an accepted constraint.

6. **Database-level encryption** (`@journeyapps/sqlcipher`): Section 8.1.1 recommends this as a drop-in replacement for `better-sqlite3`. This should be offered as a configuration option. Implementation: use `@journeyapps/sqlcipher` when encryption is enabled in config; fall back to `better-sqlite3` otherwise. Performance overhead (5-15% read, 15-25% write) is acceptable per architecture. Should be validated during Phase 1.4 database infrastructure to ensure compatibility.

### Architecture Internal Inconsistencies

The following inconsistencies were found in the architecture document during plan validation:

1. **HMAC signing**: Section 16 roadmap lists "HMAC signing" as deferred from v0.1 Axis, but Section 6.3 requires HMAC-SHA256 for Gear messages in v0.1. **Resolution**: This plan follows Section 6.3 (HMAC for Gear messages in v0.1). The roadmap deferral likely refers to HMAC for all internal component messages, which is correct — in-process components do not sign messages in v0.1.

2. **Watchdog thresholds**: Section 5.1.12 says "blocked > 10 seconds" for the watchdog. Section 11.4 says "blocked > 5s" for event loop monitoring. **Resolution**: These may be separate mechanisms — this plan defines both constants (`WATCHDOG_BLOCK_THRESHOLD_MS = 10_000` for Axis watchdog, `EVENT_LOOP_BLOCK_DIAGNOSTIC_MS = 5_000` for perf_hooks monitoring).

3. **`jobs` table missing columns**: The `Job` TypeScript interface (Section 5.1.2) includes `revisionCount`, `replanCount`, and the CAS claim pattern (Section 5.1.3) references `workerId`, but the explicit SQL DDL for the `jobs` table (Section 8.3) does not include `revision_count`, `replan_count`, or `worker_id` columns. **Resolution**: The initial migration (Phase 1.4) must include these columns in the `jobs` table DDL: `worker_id TEXT`, `revision_count INTEGER DEFAULT 0`, `replan_count INTEGER DEFAULT 0`. These are required for the CAS operations in Phase 2.2 and cycle limit enforcement.

4. **Test phasing mismatch**: Section 13.5 states v0.2 requires "Journal memory CRUD" tests, but Journal (full memory) is implemented in v0.3 (Phase 10). Section 13.5 also states v0.3 requires "Gear Suggester output validation" tests, but Gear Suggester activation is v0.4 (Phase 11). **Resolution**: This plan follows the implementation phasing from Section 16 (delivery roadmap), which is more authoritative than the test matrix in Section 13.5. The test matrix appears to have off-by-one version assignments for these two items.

---

## Appendix B: Cross-Cutting Concerns

These concerns apply across multiple phases and must be addressed continuously:

### Security

- **Every PR** must be checked for OWASP Top 10 (both web and LLM) violations
- **No `any` types** — use `unknown` and narrow with type guards
- **No `eval()` or `Function()`** except within `isolated-vm` sandboxes
- **No `child_process.exec()`** — use `execFile()` or `fork()` to prevent shell injection
- **Secrets never in logs** — enforce via logger redaction and code review
- **All external input validated** at the boundary (Fastify schema validation)
- **Model version pinning**: LLM provider config must specify exact model version strings, not "latest" aliases (Section 6.1.2)
- **No telemetry**: the application must never make outbound calls except for user-configured LLM/Gear requests (Section 7.1)
- **Data classification** (Section 7.2): All data handled according to classification tiers — Public (system prompts, Gear manifests), Internal (conversation history, plans, execution logs), Confidential (memories, preferences), Secret (API keys, passwords). Classification guides access control and audit granularity.

### Testing

- Minimum test coverage: 80% for security-critical code (Sentinel, Gear sandbox, auth, secrets)
- All PRs include tests for new functionality
- Security tests in `tests/security/` for each security-sensitive feature
- Mock LLM providers for deterministic Scout/Sentinel tests
- LLM evaluation targets (Section 13.6): Scout plan validity > 95%, Sentinel true positive > 99%, Sentinel false positive < 10%, Journal Recall@5 > 80%
- **Regression test protocol**: when a real-world failure is fixed, add its inputs as a regression test case (Section 13.4)
- **Migration testing**: any phase modifying database schema must include a numbered migration file and a migration test. Each migration is tested against all previous schema versions in CI (Section 8.5).
- **No `ATTACH` in production**: cross-database ATTACH queries must not be used for production operations (Section 8.6). Enforce via code review and tests.

### Performance

- Main thread never touches SQLite (database worker thread)
- All LLM calls use streaming
- Event loop monitoring active from Phase 2.6 with graduated thresholds (p99 > 50ms warn, > 200ms error, blocked > 5s diagnostic)
- Memory watchdog active from Phase 8.3 with graduated responses (RSS 70% warn, 80% pause background, 90% reject sandboxes, system free < 256 MB emergency)
- Cold start target: < 3 seconds on RPi with SSD (budget: Node.js < 800ms, SQLite < 300ms, migrations < 200ms, Fastify < 200ms, Gear manifests < 300ms, job recovery < 200ms)
- Lazy-load after startup: Ollama connection, LLM provider connections, sqlite-vec extension, semantic cache
- Memory leak defenses (Section 11.5): sandbox disposal deadline, WS ping/pong, prepared statement LRU cache, job-scoped event listener auto-deregistration, LLM stream AbortController
- Disk monitoring: alert at 80%, pause non-critical at 90% (Section 11.3)
- Per-tier connection limits: enforce concurrent Gear, WS, LLM stream limits per deployment tier (Section 11.4)

### Documentation

- Each module's `index.ts` has JSDoc comments on exported functions
- API endpoints documented via Fastify schema (auto-generated OpenAPI)
- Deployment guides per target environment, including hardened Nginx/Caddy reverse proxy configurations (Section 6.5)
- Architecture decision records for significant deviations from the document
- Safe contribution zones documented in `CONTRIBUTING.md` (Section 15.3)

---

## Appendix C: Phase-to-Architecture Traceability

This table maps each implementation phase to the architecture sections it addresses:

| Phase     | Architecture Sections                                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1       | 14 (Tech Stack), 15.1 (Code Org), 15.3 (Contribution)                                                                                                                                                                |
| 1.2       | 15.3, 15.5 (Governance), 6.1.1 (Supply Chain)                                                                                                                                                                        |
| 1.3       | 5.1.2 (Job Model), 5.2.2 (Plan Format), 5.3.3 (Validation), 5.3.8 (Sentinel Memory), 5.4.5 (Memory Query), 5.6.2 (Gear Manifest), 6.6 (Audit), 9.1-9.3 (APIs), 6.2 LLM10 (Token Limits), 11.3-11.4 (Resource Limits) |
| 1.4       | 8.1-8.6 (Data Architecture), 11.1 (SQLite Worker Thread)                                                                                                                                                             |
| 1.5       | 10.4 (Configuration), 12.1 (Logging)                                                                                                                                                                                 |
| 1.6       | 6.4 (Secrets Management)                                                                                                                                                                                             |
| 2.1       | 5.1 (Axis), 9.1 (Internal API), 4.2.2 (Message Bus)                                                                                                                                                                  |
| 2.2       | 5.1.2-5.1.3 (Job Model, State Machine), 5.1.6 (Queue)                                                                                                                                                                |
| 2.3       | 5.1.7 (Idempotency), 5.1.9 (Deduplication)                                                                                                                                                                           |
| 2.4       | 5.1.4 (Concurrency), 5.1.10 (Timeouts), 5.1.11 (Error Classification)                                                                                                                                                |
| 2.5       | 5.1.8 (Plan Pre-Validation)                                                                                                                                                                                          |
| 2.6       | 5.1.12 (Fault Tolerance), 5.1.14-5.1.15 (Startup/Shutdown, Self-Diagnostic)                                                                                                                                          |
| 2.7       | 6.6 (Audit Logging)                                                                                                                                                                                                  |
| 3.1       | 5.2.4 (LLM Provider), 5.2.5 (Tool Use Translation)                                                                                                                                                                   |
| 3.2       | 5.2.4-5.2.5 (Additional Providers — deferred to v0.2)                                                                                                                                                                |
| 3.3       | 5.2.1-5.2.3 (Scout Responsibilities, Plans, Context), 4.3 (Fast/Full Path), 5.2.7 (Failure Modes)                                                                                                                    |
| 3.4       | 5.2.8 (Prompt Injection), 6.2 LLM01 (Prompt Injection)                                                                                                                                                               |
| 4.1-4.3   | 5.3 (Sentinel), 5.3.5 (Risk Policies), 5.3.4 (Approval Flow)                                                                                                                                                         |
| 5.1-5.7   | 5.6 (Gear), 9.3 (Gear API), 6.5 (Network Security)                                                                                                                                                                   |
| 6.1-6.4   | 5.5 (Bridge), 9.2 (External API), 6.3 (Auth), 6.5 (Network), 7.1 (Privacy), 6.2 LLM02/LLM07                                                                                                                          |
| 7.1-7.7   | 5.5.2-5.5.14 (Bridge UI, all subsections), 7.1 (Privacy Indicator)                                                                                                                                                   |
| 2.8       | 5.1 (Axis) — integration of all sub-systems                                                                                                                                                                          |
| 3.5       | 5.2 (Scout) — integration and Axis registration                                                                                                                                                                      |
| 8.1-8.5   | 4.5 (Lifecycle), 4.7 (User Stories), 10 (Deployment), 12 (Observability)                                                                                                                                             |
| 9.1-9.10  | 16 Phase 2 (v0.2 roadmap), 5.3 (Sentinel LLM), 6.3 (Ed25519), 5.2.2 (DAG/Conditions), 5.2.4-5.2.5 (Providers), 8.1.1 (Encryption), 13.6-13.7 (Eval/Prompts), 15.4 (Security Patches)                                 |
| 10.1-10.7 | 16 Phase 3 (v0.3), 5.4 (Journal), 5.3.8 (Sentinel Memory), 7.4-7.5 (Retention/Deletion), 8.4 (Backup)                                                                                                                |
| 11.1-11.4 | 16 Phase 4 (v0.4), 5.4.4 (Gear Suggester), 5.2.6 (Adaptive Model), 9.4 (MCP), 5.5.9 (Voice)                                                                                                                          |
