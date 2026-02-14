# Changelog

All notable changes to the Meridian project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-13

Safety upgrades, cron scheduling, cost tracking, DAG execution, and additional Gear for v0.2.

### Added

#### Sentinel Upgrades (`src/sentinel/`)
- LLM-based plan validation using independently configured provider/model (Phase 9.1)
- Structured evaluation across security, privacy, financial, policy, ethical, and legal categories
- Confidence-scored verdicts with category-level breakdowns
- Versioned prompt templates for Sentinel system prompts

#### Ed25519 Message Signing (`src/shared/`, `src/axis/`)
- Ed25519 keypair generation, signing, and verification for component messages (Phase 9.2)
- Replaces HMAC-SHA256 for inter-component message integrity
- Key rotation support with configurable validity periods

#### Additional Built-in Gear (`src/gear/builtin/`)
- `web-search` Gear: DuckDuckGo HTML search with result parsing (Phase 9.3)
- `scheduler` Gear: CRUD operations on cron schedules via `executeCommand` (Phase 9.3)
- `notification` Gear: Send notifications via `executeCommand` (Phase 9.3)
- `executeCommand` API added to `GearContext` for structured command dispatch

#### Cron Scheduling (`src/axis/`)
- Custom 5-field cron parser with ranges, lists, steps, and aliases (`@hourly`, `@daily`, etc.) (Phase 9.4)
- `ScheduleEvaluator` polling for due schedules and creating jobs automatically
- REST API endpoints for schedule CRUD and toggle
- Mission Control UI section for managing scheduled jobs

#### Cost Tracking (`src/shared/`, `src/bridge/`)
- `CostTracker` class recording per-call LLM costs with daily aggregation (Phase 9.5)
- Built-in pricing data for Claude and GPT model families
- Alert thresholds at 80% (warning), 95% (critical), and 100% (hard stop)
- REST API endpoints for daily cost, date range, and per-job cost queries

#### Circuit Breaker, Standing Rules & Consistency (`src/axis/`)
- In-memory `CircuitBreaker` with closed/open/half_open states and sliding failure window (Phase 9.6)
- `StandingRuleEvaluator` for pattern-based auto-approval after repeated same-category approvals
- `ConsistencyScanner` for detecting orphaned cross-database references
- Batch approval endpoint for jobs

#### TLS, Evaluation & Prompt Versioning (`src/bridge/`, `tests/evaluation/`)
- TLS configuration support with HSTS headers (Phase 9.7)
- LLM evaluation framework with graded difficulty and mock/real modes
- Sentinel prompt versioning with `PromptTemplate` metadata
- Provider privacy cards showing data retention and training opt-out info

#### Database Encryption & Security Patches (`src/shared/`, `src/bridge/`)
- Optional SQLCipher integration for encrypted databases (Phase 9.8)
- Security patch notification endpoint (`GET /api/updates/check`)
- Sentinel configuration guidance UI for security level recommendations

#### DAG Execution & Conditional Steps (`src/axis/`)
- `DagExecutor` with topological sort (Kahn's algorithm) for step dependency ordering (Phase 9.9)
- Parallel layer execution with configurable concurrency (default: 4)
- `$ref:step:<stepId>` placeholder resolution with dot-path field access
- `ConditionEvaluator` with 6 operators: eq, neq, gt, lt, contains, exists
- DFS-based cycle detection in plan pre-validation
- Failed step propagation: transitive dependents automatically skipped

### Security
- Ed25519 message signing replaces HMAC-SHA256 for stronger integrity guarantees
- LLM Sentinel maintains strict information barrier (no user messages, Journal, or Gear catalog)
- Optional database encryption with SQLCipher and Argon2id key derivation
- Circuit breaker prevents cascading failures from compromised Gear
- Standing rules constrained to explicit patterns with expiration

## [0.1.0] - 2026-02-13

Initial release of Meridian — a self-hosted AI assistant platform with autonomous task execution, dual-LLM safety validation, and sandboxed plugin architecture.

### Added

#### Shared (`src/shared/`)
- Core type system with typed-with-metadata pattern for all component interfaces
- `Result<T, E>` type for expected-failure handling without exceptions
- Typed error classes with error codes extending `Error`
- UUID v7 (time-sortable) ID generation for all entities
- Constants, enums-as-unions, and shared configuration types
- `ComponentId` type for message routing (`'bridge' | 'scout' | 'sentinel' | 'journal' | 'gear:${string}'`)

#### Axis (`src/axis/`) — Runtime & Scheduler
- Component registry for dynamic registration of core components
- Message router with typed in-process dispatch and middleware pipeline
- SQLite-backed persistent job queue with atomic state transitions
- Job state machine: `pending` → `planning` → `validating` → `awaiting_approval` → `executing` → `completed` | `failed` | `cancelled`
- Request deduplication and idempotency layer to prevent duplicate processing
- Worker pool with configurable concurrency and timeout hierarchy
- Error classifier distinguishing transient vs permanent failures for retry logic
- Deterministic plan pre-validation before LLM-based safety review
- Crash recovery with job rehydration on startup
- Watchdog process for health monitoring and automatic recovery
- Periodic maintenance tasks (stale job cleanup, WAL checkpointing)
- Startup lifecycle with ordered component initialization and graceful shutdown
- Append-only audit log with monthly-partitioned SQLite databases
- Axis runtime class integrating all subsystems with full integration test coverage

#### Scout (`src/scout/`) — Planner LLM
- LLM provider abstraction layer with unified interface across providers
- Anthropic Claude adapter with streaming and structured output support
- OpenAI adapter (GPT-4 family) with function calling support
- Google Gemini adapter with structured output support
- Ollama adapter for local model inference
- OpenRouter adapter for multi-provider routing
- Plan generation producing structured JSON execution plans
- Structural fast-path detection: conversational responses bypass Sentinel/Gear pipeline
- Failure handling with retry logic and graceful degradation
- External content provenance tagging marking non-user content as untrusted data
- Prompt templates with system prompt enforcing security boundaries
- Security tests validating prompt injection resistance

#### Sentinel (`src/sentinel/`) — Safety Validator
- Rule-based policy engine evaluating execution plans against configurable security policies
- Risk assessor scoring plans by permission scope, resource access, and external interactions
- Approval flow routing: auto-approve low-risk, flag medium-risk, require approval for high-risk
- User approval handling with timeout and expiration for pending approvals
- Information barrier enforcement: Sentinel never receives user messages, Journal data, or Gear catalog
- Full integration with Axis message routing

#### Gear (`src/gear/`) — Plugin System
- Declarative Gear manifest format with JSON Schema permission declarations
- Gear registry with CRUD operations and manifest validation
- Level 1 process sandbox using `child_process.fork()` with platform-specific hardening
- GearHost managing Gear lifecycle, process spawning, and integrity verification
- GearContext providing a constrained API surface for Gear code (filesystem, network, secrets)
- JSON-over-stdin/stdout communication protocol with HMAC-SHA256 message signing
- Built-in `file-manager` Gear for sandboxed filesystem operations
- Built-in `web-fetch` Gear for HTTP requests with URL validation and private IP blocking
- Built-in `shell` Gear for command execution (disabled by default, exempt from auto-approval)
- Gear runtime integration with Axis registration and job execution pipeline

#### Bridge (`src/bridge/`) — API & UI
- Fastify HTTP server with JSON Schema request/response validation
- Mandatory authentication with bcrypt password hashing and secure session tokens
- Brute-force protection with exponential backoff after failed login attempts
- REST API routes for conversations, jobs, Gear management, system configuration, and health checks
- WebSocket server for real-time streaming of job progress, plan updates, and assistant responses
- Bridge-Axis integration layer and BridgeServer lifecycle management
- React SPA with Vite, Tailwind CSS, and Zustand state management
- Dual-mode interface: Chat view for conversations and Mission Control dashboard for system oversight
- Onboarding wizard for first-run configuration (model provider, API keys, preferences)
- Conversation view with message history, streaming responses, and job status indicators
- Mission Control dashboard with active jobs, system health, and recent activity
- Approval dialog for reviewing and approving/rejecting execution plans
- Error display components with contextual recovery suggestions
- Settings panel for configuration management
- Command palette for keyboard-driven navigation
- Notification system with toast messages and notification center
- Accessibility support (ARIA labels, keyboard navigation, screen reader compatibility)
- Dark mode by default

#### Infrastructure
- Repository skeleton with TypeScript, ESLint, Prettier, and tsup configuration
- CI pipeline with typecheck, lint, and test stages
- PR template and contributing guidelines
- SQLite database infrastructure with WAL mode, PRAGMA hardening, and worker thread isolation
- Database migrator with versioned forward migrations
- Multi-database architecture: `meridian.db`, `journal.db`, `sentinel.db`, `audit-YYYY-MM.db`
- Configuration loading from file, environment variables, and CLI arguments with validation
- Structured logging with automatic credential pattern redaction
- Encrypted secrets vault using AES-256-GCM with Argon2id key derivation
- Full pipeline integration tests validating the Scout → Sentinel → Gear execution flow
- End-to-end user story validation tests
- Observability tooling: structured log queries, job tracing, and performance metrics
- Docker configuration with multi-stage build for production deployment
- Deployment configuration for containerized and bare-metal environments
- Apache-2.0 license with CLA

### Security
- Dual-LLM trust boundary: every execution plan generated by Scout is independently validated by Sentinel before execution
- Strict information barrier: Sentinel operates without access to user messages, Journal memory, or Gear catalog to prevent prompt injection propagation
- Encrypted secrets vault with AES-256-GCM encryption and Argon2id key derivation; secrets are never included in LLM prompts or logged
- Secret ACL enforcement restricting which Gear can access which credentials
- Three-tier Gear sandboxing: Level 1 (`child_process.fork` + OS sandbox), Level 2 (`isolated-vm`), Level 3 (Docker container)
- Private IP range blocking (10.x, 172.16.x, 192.168.x, 127.x) for Gear network requests by default
- Gear manifest permission declarations validated against runtime behavior
- HMAC-SHA256 message signing for all Gear communication
- External content provenance tagging treating non-user content as data, never instructions
- Append-only audit log in separate monthly-partitioned databases; no UPDATE or DELETE permitted
- Mandatory authentication on all deployments including localhost
- Bridge binds to 127.0.0.1 by default; remote access requires explicit TLS configuration
- Credential pattern redaction in all log output
- Shell Gear disabled by default and exempt from auto-approval

[0.2.0]: https://github.com/meridian-ai/meridian/commits/v0.2.0
[0.1.0]: https://github.com/meridian-ai/meridian/commits/v0.1.0
