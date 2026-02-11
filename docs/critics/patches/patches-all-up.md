# Consolidated Patch Plan

> **Status**: Draft
> **Source**: Synthesized from 14 critic patch files in `docs/critics/patches/`
> **Scope**: Changes to `docs/architecture.md` and project setup

This document consolidates feedback from 14 domain-expert reviews into a single actionable plan. Recommendations are grouped by theme, deduplicated where multiple critics raised the same issue, and assigned to delivery phases.

---

## Table of Contents

- [1. Delivery Phasing](#1-delivery-phasing)
- [2. Architecture & Core Design](#2-architecture--core-design)
- [3. Security Hardening](#3-security-hardening)
- [4. Database & Storage](#4-database--storage)
- [5. Reliability & Systems Engineering](#5-reliability--systems-engineering)
- [6. Performance & Resource Management](#6-performance--resource-management)
- [7. User Experience & Interface](#7-user-experience--interface)
- [8. Privacy & Data Handling](#8-privacy--data-handling)
- [9. Developer Experience & Open Source](#9-developer-experience--open-source)
- [10. Documentation & Framing](#10-documentation--framing)
- [11. Deferred / Future Considerations](#11-deferred--future-considerations)

---

## 1. Delivery Phasing

**Raised by**: Open-Source Maintainer (Critical), Product Manager (Critical), Software Architect (Major)

The architecture document describes the full vision but lacks a phased delivery plan. Multiple critics flagged this as the single most important addition. Without it, every feature appears to be a launch requirement, which is unrealistic and paralyzing.

### 1.1 Add Section 17: Delivery Roadmap

Replace the vague "Future Considerations" section (Section 16) with a concrete phased roadmap. The phases below synthesize the Open-Source Maintainer's 3-milestone plan, the Product Manager's 5-phase plan, and the Software Architect's scoping recommendations.

**Phase 1 — v0.1: Core Loop (8-10 weeks)**

The minimum system that demonstrates the value proposition: natural language in, safe task execution out.

| Component | Included | Explicitly Deferred |
|-----------|----------|-------------------|
| **Shared** | Types, error classes, Result\<T,E\>, constants, ID utils | — |
| **Axis** | Job queue (SQLite-backed), message dispatch, sequential execution, graceful shutdown, single worker pool | HMAC signing, cron scheduling, event bus, parallel step execution, circuit breakers |
| **Scout** | Single provider (Anthropic), single model, basic plan generation, fast-path detection | Adaptive model selection, multi-provider, plan replay cache, prompt versioning |
| **Sentinel** | Rule-based policy engine only (no LLM), user approval flow | LLM-based validation, Sentinel Memory, composite-action analysis |
| **Bridge** | Text-only chat, password auth, WebSocket streaming, job status, basic approval dialog | Voice, TOTP, push notifications, mission control view, mobile optimization |
| **Gear** | 3 built-in (file-manager, web-fetch, shell), process-level sandbox, manifest validation | Container sandbox, Gear signing, web-search, scheduler, notification |
| **Journal** | Conversation history storage only | Memory types, vector search, reflection, Gear Synthesizer |

**Journal is explicitly omitted from v0.1.** The core value proposition (safe task execution) does not require memory. The system is stateless per session.

v0.1 success criteria:
- Install to first message in under 3 minutes
- Fast-path response under 5 seconds
- Simple task (find files, fetch web page) under 10 seconds
- Approval flow works end-to-end
- Stable for 5-10 testers

**30-second demo** that v0.1 must execute flawlessly:
```
User: "Find all TODO comments in my project and save a summary to todos.txt"
[~6 seconds]
Meridian: Found 23 TODOs across 8 files. [summary] Saved to /workspace/todos.txt
```

**Phase 2 — v0.2: Safety & Scheduling (4-6 weeks)**

| Addition | Details |
|----------|---------|
| Sentinel LLM validation | Full dual-LLM pipeline with information barrier |
| Additional Gear | web-search, scheduler, notification |
| Message signing | HMAC-SHA256 on Gear boundary (internal remains unsigned) |
| Cron scheduling | Stored in SQLite, evaluated every 60s |
| Approval improvements | Batch approval, standing rules |
| Token/cost tracking | Per-task display, daily limit, cost dashboard |

**Phase 3 — v0.3: Memory & Learning (4-6 weeks)**

| Addition | Details |
|----------|---------|
| Journal | Episodic + semantic + procedural memory |
| Vector search | sqlite-vec, hybrid retrieval (RRF) |
| Two-phase reflection | Deterministic extraction + LLM analysis |
| Sentinel Memory | Isolated approval decision store |
| Container sandbox | Optional Docker-based Gear isolation |
| Gear signing | Manifest signatures, checksum verification |
| Network filtering | Local proxy for Gear, domain restrictions |
| Memory viewer | Browse, edit, delete memories in Bridge |
| Multi-provider LLM | Support for OpenAI, Google, Ollama, OpenRouter |

**Phase 4 — v0.4+: Growth**

| Addition | Details |
|----------|---------|
| Gear Suggester | Composition-only suggestions (structured briefs, not code gen) |
| Procedural memory | Distilled strategies and patterns |
| Adaptive model selection | Primary/secondary model routing |
| Plan replay cache | Skip Scout for known patterns |
| Gear SDK | `@meridian/gear-sdk` for third-party development |
| MCP compatibility | Wrap existing MCP servers as Gear |
| Voice input | Whisper transcription, browser TTS |
| TOTP | Two-factor authentication |
| Push notifications | Web Push API |

**Deferred Indefinitely (v1.0+)**

Multi-user, messaging platform integrations (WhatsApp/Discord/Telegram), Gear marketplace, full local LLM as primary, agent-to-agent federation, proactive behavior, video input, WCAG 2.1 AA, Prometheus metrics, image/video processing.

### 1.2 Evaluate Architecture Decisions Against v0.1

Every architectural decision in the document should be re-evaluated against whether it makes the v0.1 demo better or worse. The document should clearly mark which sections are v0.1 requirements vs. future phases.

---

## 2. Architecture & Core Design

### 2.1 Single Package for v1 (v0.1)

**Raised by**: Software Architect (Major), Open-Source Maintainer (Medium)

Replace 7 npm workspace packages with a single TypeScript package using directory-based module boundaries. Each module's `index.ts` is its public API.

```
src/
  axis/          # Runtime & scheduler
  scout/         # Planner LLM
  sentinel/      # Safety validator
  journal/       # Memory system
  bridge/
    api/         # Backend API
    ui/          # Frontend SPA
  gear/          # Plugin runtime + builtin/
  shared/        # Shared types and utilities
```

Enforce boundaries via ESLint `no-restricted-imports` or `dependency-cruiser`:
- `sentinel/` cannot import `journal/`
- `axis/` cannot import LLM provider SDKs
- No cross-module internal file imports (only through `index.ts`)
- `shared/` imports nothing

Split into packages when a concrete need arises (publishing `@meridian/gear-sdk`, build times > 30 seconds, independent deployment).

Published artifacts:
- `@meridian/cli` (npm) — the single installable
- `@meridian/gear-sdk` (npm, standalone) — for Gear developers
- `meridian/meridian` (Docker image)

### 2.2 Refine Loose Schema to Typed-with-Metadata (v0.1)

**Raised by**: Software Architect (Major)

Replace `[key: string]: unknown` on every core interface with: required fields, typed optional fields for commonly-used properties, and a single `metadata?: Record<string, unknown>` for genuinely ad-hoc content.

Apply to: `ExecutionPlan`, `ExecutionStep`, `Job`, `ValidationResult`, `StepValidation`, `SentinelDecision`, `MemoryQuery`, `MemoryResult`, `WSMessage`, `AxisMessage`.

Example for `ExecutionStep`:

```typescript
interface ExecutionStep {
  // Required
  id: string;
  gear: string;
  action: string;
  parameters: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';

  // Typed optional
  description?: string;
  order?: number;
  dependsOn?: string[];  // Step IDs (empty = run immediately)
  rollback?: string;
  condition?: StepCondition;

  // Ad-hoc
  metadata?: Record<string, unknown>;
}
```

Update CLAUDE.md: rename "Loose schema principle" to "Typed-with-metadata principle."

### 2.3 Type WSMessage as Discriminated Union (v0.1)

**Raised by**: Software Architect (Major)

Replace the untyped `{ type: string; [key: string]: unknown }` with a TypeScript discriminated union covering message types: `chunk`, `status`, `approval_required`, `result`, `error`, `notification`, `progress`, `connected`, `ping`, `pong`. Each type has a fully typed payload. Frontend uses `switch` with exhaustiveness checking.

### 2.4 Specify Message Bus Semantics (v0.1)

**Raised by**: Software Architect (Critical), Distributed Systems (Medium)

The document says "message-passing through Axis" but never specifies what that means in practice.

**Core components (same process)**: In-process typed function dispatch with middleware. Each component registers a handler during startup. Axis calls handlers directly as async functions. Middleware chain provides audit logging, error handling, and latency tracking. Request-reply via Promises with correlationIds. Timeouts via AbortSignal.

**Gear (cross-process)**: Structured JSON over stdin/stdout or Unix domain socket. Full signing and verification (real trust boundary). At-most-once delivery; retries at job level.

Add `correlationId` and `timestamp` as required fields on `AxisMessage`. Define enumerated message types.

### 2.5 Acknowledge Hybrid Process Model (v0.1)

**Raised by**: Software Architect (Major)

Explicitly document that core components share a single Node.js process (shared V8 heap, shared failure domain). Gear runs in separate processes/containers with real isolation. The component boundaries are designed so the split can happen later if needed.

### 2.6 Scope Down Gear Synthesizer to "Gear Suggester" (v0.4)

**Raised by**: AI Researcher (Critical), Software Architect (Critical), Open-Source Maintainer (Critical)

This was the most universally flagged concern. Autonomous code generation from reflections is a research problem, not an implementation detail.

**v1 scope**: Rename to "Gear Suggester." It produces a structured Gear brief (problem description, proposed solution, example I/O, manifest skeleton, pseudocode), not executable code. User can implement manually or dismiss.

If Gear Suggester does generate executable Gear (v2+), restrict to composition-only: orchestrating sequences of existing built-in Gear with control flow and data transformation. No arbitrary code, no dynamic dependency installation, no npm packages not already in sandbox runtime. Require at least one smoke test per action. Bound improvement loop to max 3 attempts and 50,000 tokens.

### 2.7 Explicit Plan Dependencies as DAG (v0.2)

**Raised by**: AI Tooling Engineer (Critical), Product Manager (Medium)

Make `dependsOn: string[]` a required field on `ExecutionStep` (IDs of steps that must complete first; empty array = run immediately). Axis computes the execution DAG, dispatches in maximal parallelism, and detects cycles during pre-validation.

Add data flow between steps: producing steps include an `outputKey` field; downstream steps reference via `$ref:step:<stepId>` placeholders in parameters, resolved by Axis at dispatch time.

### 2.8 Add Conditional Execution to Plan Format (v0.2)

**Raised by**: Product Manager (Medium)

Add `condition?: StepCondition` to `ExecutionStep`:

```typescript
type StepCondition =
  | { type: 'jsonpath'; expression: string }  // Evaluated against dependency result
  | { type: 'llm-evaluate' };                 // Round-trip to Scout for complex conditions
```

Skipped steps marked as `skipped` in job result. Axis evaluates JSONPath deterministically (no LLM call).

### 2.9 Add Conversation Threading Model (v0.1)

**Raised by**: Software Architect (Major), UI/UX Designer (Low), Distributed Systems (High)

Add `conversations` table (id, title, status, created_at, updated_at). Add `conversation_id` to `messages` and `jobs` tables. Jobs from the same conversation execute serially; jobs from different conversations execute concurrently. New conversation starts on explicit user action or after 30-minute inactivity.

### 2.10 Make Fast-Path Selection Structural (v0.1)

**Raised by**: Software Architect (Minor), Security Expert (High)

Path is determined by the shape of Scout's output: plain text response = fast path; ExecutionPlan JSON = full path. Axis verifies structurally. Scout cannot "choose" fast path while producing a plan.

Additionally, Axis performs deterministic checks before delivering a fast-path response: response does not contain JSON structures resembling execution plans, does not reference registered Gear/action names, does not contain deferred-action patterns ("I've gone ahead and..."). If any check fails, re-route through full path.

### 2.11 MCP-Compatible Gear Architecture (v0.4)

**Raised by**: AI Tooling Engineer (Critical), Power User (High)

Promote MCP from a compatibility section to the Gear protocol. Each Gear wraps an MCP server. Axis intercepts MCP tool calls, validates against the Gear manifest, injects secrets, enforces resource limits, logs to audit trail, then forwards to the MCP server.

For v0.4, implement `meridian gear wrap <mcp-server>` to discover tools via MCP `tools/list`, generate draft GearManifest, and register after user review.

Add `mcp` field to GearManifest:

```typescript
mcp?: {
  command: string;
  args?: string[];
  transport: 'stdio' | 'sse';
  env?: Record<string, string>;
};
```

### 2.12 Tool Use Translation Layer (v0.1)

**Raised by**: AI Tooling Engineer (Critical)

Add bidirectional translation between Meridian's plan format and each LLM provider's native tool-calling format. Specify outbound mapping (GearAction to Anthropic/OpenAI/Google/Ollama tool schemas) and inbound parsing (provider responses to Meridian plan steps). Define fallback structured-output prompting mode for models without native tool calling. Each adapter independently tested against a conformance suite.

### 2.13 Defer Adaptive Model Selection (v0.4)

**Raised by**: AI Researcher (Medium), Software Architect (Minor)

v0.1-v0.3 use a single configured model. Primary/secondary config fields are defined but secondary unused. When implemented, use explicit task-type enumeration for model routing (not LLM-based judgment). Soften cost savings claims from "30-50%" to "meaningful, depending on task distribution."

### 2.14 Defer Event Bus (v2)

**Raised by**: Distributed Systems (Medium)

The full event bus needs delivery guarantees, ordering, handler failure semantics, backpressure, persistence, subscription model, event schemas, security, and rate limiting — each non-trivial. v1 supports webhook-triggered jobs only: Bridge exposes `POST /api/webhooks/:hookId` creating a job from a pre-configured template with per-webhook secret token authentication.

---

## 3. Security Hardening

### 3.1 Strip Free-Form Fields Before Sentinel Review (v0.2)

**Raised by**: Security Expert (Critical), AI Researcher (High)

Before Axis sends a plan to Sentinel, strip all non-required fields from ExecutionPlan and ExecutionStep. Sentinel receives only: `id`, `jobId`, `steps` (each with `id`, `gear`, `action`, `parameters`, `riskLevel`). This prevents a compromised Scout from embedding persuasive framing or the user's original message in fields like `reasoning` or `description`, bypassing the information barrier.

Scout's `riskLevel` is included but Sentinel performs independent assessment. Divergence by >1 level logged as anomaly.

Acknowledged limitation: `parameters` inherently carry user intent. The barrier prevents Sentinel from seeing the original message with conversational context and framing, not all traces of user intent.

### 3.2 Per-Component Asymmetric Signing (v0.2)

**Raised by**: Security Expert (Critical)

A single shared HMAC key means any component can forge messages from any other, contradicting the claim that "a compromised Gear cannot impersonate Scout or Sentinel."

Switch to Ed25519 per-component keypairs. Core component private keys stored in encrypted vault. Gear receives ephemeral keypairs per-execution, not stored. Axis holds all public keys and verifies inbound messages.

**v0.1 simplification**: Internal components (same process) skip signing entirely (see 2.4). Signing only applies to the Gear trust boundary. HMAC-SHA256 is acceptable for v0.1 Gear communication; upgrade to Ed25519 in v0.2.

Add replay protection: reject duplicate message IDs (sliding window), reject messages with timestamp > 60 seconds old.

### 3.3 Harden Prompt Injection Defenses (v0.2)

**Raised by**: Security Expert (High), AI Researcher (High)

Explicitly state that `<external_content>` tagging is a **soft defense layer**, not a security boundary. LLMs do not reliably respect delimiter boundaries.

Document the four actual security boundaries:
1. Structured plan output (must be valid JSON)
2. Plan sanitization (strips free-form fields before Sentinel)
3. Sentinel's independent review (no original input)
4. Sandbox enforcement (Gear cannot exceed permissions)

Add multi-hop injection defense:
- Gear output results tagged with `source: "gear:<gear-id>"` provenance
- Reflector applies instruction/data classifier before writing to memory; content with instruction-like patterns flagged with `external_content_involved: true` and reduced confidence
- Users can review externally-influenced memories separately

### 3.4 Harden Shell Gear (v0.1)

**Raised by**: Security Expert (High)

- Shell Gear is **exempt from Sentinel Memory auto-approval**. Every shell command requires fresh user approval regardless of precedent.
- Shell Gear **disabled by default**, must be explicitly enabled in settings.
- Persistent indicator in Bridge when shell Gear is active.
- Rationale: shell commands are opaque (glob patterns can be tricked), run with Meridian process permissions outside the sandbox.

### 3.5 Expand Threat Model (v0.2)

**Raised by**: Security Expert (High)

Add four adversaries to Section 6.1:
- **Malicious contributor**: PRs weakening security
- **npm supply chain attacker**: typosquatting, dependency confusion, compromised maintainers, malicious postinstall scripts
- **Compromised LLM provider**: modified responses producing subtly harmful plans, simultaneous Scout/Sentinel compromise with same provider
- **Denial-of-service attacker**: API flooding, economic DoS, concurrent Gear exhaustion

Add supply chain defenses (Section 6.1.1): register `@meridian` npm scope, `--ignore-scripts` by default with explicit allowlist, lockfile integrity hashes, CVE scanning, SBOM generation.

Add LLM provider risk mitigation (Section 6.1.2): default recommendation is **different providers for Scout and Sentinel** (not just "high security" option); same-provider warning displayed persistently in Bridge.

### 3.6 Harden Gear Sandbox (v0.1)

**Raised by**: Security Expert (High), Performance Engineer (P1)

Clarify sandbox layering for Level 1 (process isolation): `child_process.fork()` + OS-level restrictions (seccomp on Linux, sandbox-exec on macOS).

Replace secrets injection via environment variables with tmpfs-mounted temporary files at `/run/secrets/<name>`. Environment variables are visible via `/proc/1/environ`.

Add execution-time integrity check: before loading Gear code, Axis re-computes SHA-256 checksum and verifies against stored checksum from install time. Mismatches block execution, disable Gear, notify user.

### 3.7 Web Security Headers (v0.1)

**Raised by**: Security Expert (Medium)

Specify required headers:
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* wss://localhost:*; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- CORS: allow only exact Bridge origin, no wildcards

### 3.8 WebSocket Authentication (v0.1)

**Raised by**: Security Expert (Medium)

- Origin validation on upgrade
- Session validation during HTTP upgrade handshake (401 on invalid)
- Connection token: one-time token issued by REST API, sent after upgrade, consumed on use
- Periodic re-validation every 15 minutes
- Rate limiting: 60 messages/minute per connection

### 3.9 CSRF Protection (v0.1)

**Raised by**: Security Expert (Medium)

All state-changing REST endpoints require CSRF token validation (defense in depth alongside SameSite=Strict). Approval endpoint additionally requires per-job nonce matching.

### 3.10 Acknowledge JavaScript Secret-Zeroing Limitations (v0.1)

**Raised by**: Security Expert (High)

JavaScript strings are immutable and GC-managed. Document that `secret = ''` does not zero the original in memory.

Mitigations: handle secrets as `Buffer` objects (explicitly zeroed with `buffer.fill(0)`), never convert Buffer to string except at point of use. Optional N-API native addon for managing secret memory outside V8 heap is a future enhancement.

Document master key lifecycle: Argon2id derivation (64 MiB/3 iterations standard, 19 MiB/2 iterations on Pi), key held in memory for process duration, no password recovery mechanism.

### 3.11 Audit Log Integrity Chain (v0.3)

**Raised by**: Security Expert (Medium)

Add `previousHash` and `entryHash` fields to AuditEntry (SHA-256 hash chain). Modifying any entry breaks chain for subsequent entries. Bridge "Audit Integrity" panel verifies full chain on demand. Does not prevent sophisticated tampering but detects casual tampering and corruption.

### 3.12 Sentinel Memory Scope Matching Semantics (v0.3)

**Raised by**: Software Architect (Major), Security Expert (High)

- Action type: exact string match only
- Scope: file operations use canonicalized paths with prefix match on directory boundaries; network uses exact domain match (no subdomain wildcards); financial uses numeric comparison
- No regex or glob patterns (deliberately simple)
- Shell commands excluded from scope matching entirely
- Path canonicalization: resolve `..`, normalize separators, reject null bytes
- Cap at 500 active decisions (bounds the profile)

### 3.13 Encrypt Backups (v0.3)

**Raised by**: Security Expert (Medium)

Backups encrypted with AES-256-GCM, key derived from master password via Argon2id with a different salt than the secrets vault key.

### 3.14 TLS Configuration (v0.2)

**Raised by**: Security Expert (Medium)

Minimum TLS 1.2, TLS 1.3 recommended. Only AEAD cipher suites (AES-GCM, ChaCha20-Poly1305). HSTS header when TLS enabled. OCSP stapling for Let's Encrypt.

---

## 4. Database & Storage

### 4.1 Add FTS5 Content-Sync Triggers (v0.3)

**Raised by**: Database Engineer (Critical)

External content FTS5 tables do NOT auto-update. Add mandatory AFTER INSERT, AFTER UPDATE, and AFTER DELETE triggers for all FTS tables (facts_fts, procedures_fts, episodes_fts). Nine triggers total.

Safety net: rebuild FTS during idle maintenance and on startup if last rebuild > 7 days.

### 4.2 Add Missing Database Indexes (v0.1)

**Raised by**: Database Engineer (Critical)

Add indexes for:
- jobs: `idx_jobs_status`, `idx_jobs_queue (status, priority, created_at)`, `idx_jobs_parent_id`, `idx_jobs_created_at`, `idx_jobs_completed_at`
- messages: `idx_messages_job_id`, `idx_messages_created_at`
- schedules: `idx_schedules_next_run (enabled, next_run_at)`
- gear: `idx_gear_origin`, `idx_gear_enabled`
- Journal DB: `idx_episodes_created_at`, `idx_facts_category`, `idx_procedures_category`

Run `ANALYZE` periodically during idle maintenance.

### 4.3 Resolve Encryption-at-Rest Gap (v0.1)

**Raised by**: Database Engineer (Critical)

`better-sqlite3` does NOT support encrypted databases. The architecture's claim that "memories are stored locally in encrypted SQLite databases" is incorrect.

**Resolution**: Offer two tiers documented in Section 6.4.1:
1. **Database-level** (recommended): Replace `better-sqlite3` with `@journeyapps/sqlcipher` (same API, AES-256-CBC + HMAC-SHA512). Document ~5-15% read / ~15-25% write overhead.
2. **Filesystem-level**: LUKS (Linux), FileVault (macOS), BitLocker (Windows).

Both can be combined. `secrets.vault` always uses AES-256-GCM regardless.

Setup wizard recommends database-level encryption by default; for Pi users on SD cards, recommends LUKS instead.

### 4.4 Merge journal-vectors.db into journal.db (v0.3)

**Raised by**: Database Engineer (High)

Vector embeddings and content are always queried together. Separate databases force ATTACH or two round-trips, plus cross-database sync without triggers. sqlite-vec works fine in the same database. No security boundary between them.

Remove `journal-vectors.db` from the database layout. Add `memory_embeddings` virtual table using vec0 to journal.db.

### 4.5 Document Required PRAGMA Configuration (v0.1)

**Raised by**: Database Engineer (Medium)

Every connection MUST set PRAGMAs at open time:
- `journal_mode = WAL`
- `synchronous = NORMAL` (except audit.db which uses `FULL`)
- `busy_timeout = 5000`
- `foreign_keys = ON` (OFF by default in SQLite!)
- `auto_vacuum = INCREMENTAL` (must be set before database has data)
- `temp_store = MEMORY`

Tunable per deployment:
- `cache_size`: -20000 (Mac Mini/VPS), -8000 (Pi)
- `mmap_size`: 256MB (Mac Mini/VPS), 64MB (Pi)

Export a `configureConnection(db)` function from `shared/` that all modules must call.

### 4.6 Per-Database Migration Strategy (v0.1)

**Raised by**: Database Engineer (Medium)

Each database tracks its own schema version independently. Each migration runs in its own transaction within its database; failure rolls back and aborts startup. Before any migration, back up ALL databases using `VACUUM INTO`. Migrations are forward-only; backups serve as rollback.

### 4.7 Add Sentinel Database Schema (v0.3)

**Raised by**: Database Engineer (Medium)

Provide the missing SQL schema for `sentinel.db` with `decisions` table and indexes.

### 4.8 Replace Audit Log Rotation with Time-Based Partitioning (v0.2)

**Raised by**: Database Engineer (High)

SQLite databases cannot be "rotated by size." Replace with monthly database files: `audit-YYYY-MM.db`. Current month is write target. Monthly files older than retention period (default: 1 year) archived to compressed exports.

### 4.9 Add JSON Validity CHECK Constraints (v0.1)

**Raised by**: Database Engineer (Low)

Add `CHECK (json_valid(...))` constraints to all JSON columns. Catches malformed JSON at write time near its origin.

### 4.10 Document UUID v7 Storage Tradeoff (v0.1)

**Raised by**: Database Engineer (Low)

UUID v7 as TEXT is 36 bytes per occurrence vs. 16 as BLOB. For a single-user system, LLM API latency dwarfs database access. Document migration path (BLOB(16), WITHOUT ROWID) as future option if needed.

### 4.11 Address Cross-Database Consistency (v0.2)

**Raised by**: Database Engineer (High), Distributed Systems (High), DevOps (High)

Acknowledge that cross-database foreign keys and transactions do not exist. Mitigations:
1. Write-ahead audit: audit entry written before action commit
2. Periodic consistency scanner during idle maintenance: detect orphans, flag but do not auto-delete
3. No ATTACH for production queries; each module opens its own connection
4. Application-managed deletion cascades; consistency scanner catches orphans

---

## 5. Reliability & Systems Engineering

### 5.1 Add Idempotency Framework (v0.1)

**Raised by**: Distributed Systems (Critical)

At-least-once delivery (crash recovery resets executing jobs to pending) without idempotency means duplicate side effects (duplicate emails, API calls).

Add `executionId` (derived from jobId + stepId, stable across retries) to GearContext. Maintain durable `execution_log` table in meridian.db. Before dispatching: if execution_log shows 'completed', return cached result and skip; if 'started', mark as 'failed' and re-execute; if not found, insert 'started' and dispatch.

Gear authors encouraged to pass executionId as idempotency key to external APIs. Built-in notification and shell Gear use execution log automatically.

### 5.2 Add Step-Level Checkpointing (v0.2)

**Raised by**: Distributed Systems (Critical)

Add `currentStepIndex: number` to Job (updated atomically as each step completes). Crash recovery resumes from last incomplete step using cached results for completed steps.

### 5.3 Complete Job State Machine (v0.1)

**Raised by**: Distributed Systems (High), Software Architect (Major)

Define all valid transitions with triggers and guards. All transitions implemented as atomic compare-and-swap: `UPDATE jobs SET status = ? WHERE id = ? AND status = ?`.

Add cycle limits as typed fields (not free-form): `revisionCount` (per plan cycle, limit 3), `replanCount` (per job lifetime, limit 2), `stepAttempts` (per step per plan, limit 3).

Fix inconsistency: Section 4.5 lists 3 Sentinel verdicts, Section 5.3.3 lists 4. Add `NEEDS_REVISION` to Section 4.5.

Full transition table:

| From | To | Trigger |
|------|-----|---------|
| pending | planning | Worker claims job |
| planning | validating | Scout produces plan |
| planning | completed | Fast path |
| planning | failed | Scout API down / max retries |
| validating | executing | Sentinel approves |
| validating | awaiting_approval | Needs user approval |
| validating | planning | Needs revision (revisionCount < 3) |
| validating | failed | Rejected or revisionCount >= 3 |
| awaiting_approval | executing | User approves |
| awaiting_approval | cancelled | User rejects |
| executing | completed | All steps succeed |
| executing | failed | Max retries exceeded |
| executing | planning | Replan requested (replanCount < 2) |
| any non-terminal | cancelled | User cancels |

Terminal states: completed, failed, cancelled. No transitions out.

### 5.4 Specify Timeout Hierarchy (v0.1)

**Raised by**: Distributed Systems (High)

Nested timeout hierarchy: job timeout (default 300s) > planning timeout > validation timeout > step timeout. Each inner timeout capped by outer's remaining budget.

Per-call LLM timeout: 30s for first token. Stream stall timeout: 30s between consecutive tokens. Three-phase cooperative cancellation: signal, 5s grace period, force kill.

### 5.5 Specify Delivery Guarantee and Queue Semantics (v0.1)

**Raised by**: Distributed Systems (High)

Explicitly state: Meridian provides **at-least-once delivery**, NOT exactly-once.

SQLite IS the queue. No in-memory queue. Workers claim jobs directly from the jobs table using atomic compare-and-swap. Jobs survive restarts because they're never removed from SQLite until terminal state. Queue polled at configurable interval (default 100ms).

### 5.6 Specify Circuit Breaker Lifecycle (v0.2)

**Raised by**: Distributed Systems (Medium)

Per-Gear-action circuit breaker. Three states: Closed, Open, Half-open. Transitions: Closed to Open when failure rate > 50% over last 10 executions (min 5). Open to Half-open after exponential backoff (initial 30s, max 15m). Half-open to Closed on success. Half-open to Open on failure.

Transient failures (timeouts, 5xx) count toward breaker; permanent failures (4xx, auth errors) do not.

### 5.7 Add Replanning Context for Step Failures (v0.2)

**Raised by**: AI Tooling Engineer (High), Distributed Systems (High)

Define `ReplanContext` interface with: original plan, completed steps (including results and side effects), failed step (including error). Scout instructions: do NOT re-execute completed steps, do NOT undo completed side effects unless necessary, build on completed work.

When Sentinel returns NEEDS_REVISION, Axis assembles: rejected plan, Sentinel's feedback, previously rejected plans in this cycle, available Gear catalog. Scout does NOT receive the user's original message during revision.

Progressive escalation: iteration 1 = targeted modifications, iteration 2 = fundamentally different approach, iteration 3 (final) = clarification request to user.

### 5.8 Plan Pre-Validation in Axis (v0.1)

**Raised by**: AI Researcher (Medium)

Before sending a plan to Sentinel, Axis performs deterministic pre-validation: verify every referenced Gear exists in the registry, every action is defined in the Gear's manifest, and parameters conform to the action's declared JSON Schema. Plans that fail pre-validation are returned to Scout for correction without consuming a Sentinel LLM call.

### 5.9 LLM-Aware Backpressure (v0.2)

**Raised by**: Distributed Systems (Medium), Software Architect (Major)

Three layers:
1. **Rate limit tracking**: Track provider rate limit headers. Below 20% remaining: defer non-interactive jobs, warn interactive users.
2. **Cost budget tracking**: Warnings at 80% daily limit. Only interactive jobs at 95%. All paused at 100%.
3. **Queue depth**: Above threshold (default 50), accept but inform user of depth.

Reserve 30% of LLM rate limit capacity for Sentinel when sharing a provider with Scout.

### 5.10 Request Deduplication at Ingestion (v0.1)

**Raised by**: Distributed Systems (Medium)

Compute SHA-256 of normalized message (user ID + content + timestamp rounded to 5 seconds). If a non-terminal job with same hash exists, return existing job ID. Add `dedup_hash` column with unique partial index.

### 5.11 Crash-Consistent Backups (v0.2)

**Raised by**: DevOps (Critical), Database Engineer (Medium)

Use SQLite Backup API or `VACUUM INTO` exclusively. **Never file-copy** in WAL mode.

Cross-database near-consistent snapshots: quiesce (stop dispatching new jobs, allow running to finish with 30s timeout), backup all databases in rapid succession, backup secrets.vault atomically, resume.

Daily during configurable maintenance window. Rotation: 7 daily, 4 weekly, 3 monthly. Verify with `PRAGMA quick_check`. CI testing of backup/restore on every release.

### 5.12 Process Management (v0.1)

**Raised by**: DevOps (High)

Provide systemd unit file with: `Type=notify`, `Restart=on-failure`, `RestartSec=5s`, `StartLimitBurst=5`, `MemoryMax=75%`, `WatchdogSec=30`, `NoNewPrivileges=true`.

macOS launchd plist at `~/Library/LaunchAgents/dev.meridian.plist`.

Instance locking: acquire advisory flock() on `data/.lock` on startup. Refuse to start if another instance is running.

### 5.13 Startup Reconciliation (v0.2)

**Raised by**: DevOps (High), Software Architect (Major)

On every startup, Axis runs a reconciliation scanner:
- Jobs in `executing` reset to `pending` with partial side effects included in retry context
- Jobs in `validating`/`awaiting_approval` check sentinel.db for existing results
- Expired Sentinel decisions cleaned up
- Pending audit entries marked as `incomplete`
- Gear registry vs. filesystem consistency check

### 5.14 Error Classification in Retry Logic (v0.1)

**Raised by**: DevOps (Medium)

Classify external API errors:
- **Retriable/transient** (429, 500, 502, 503, 504, timeout): exponential backoff
- **Non-retriable/credential** (401, 403): stop immediately, notify user
- **Non-retriable/client-error** (400, 404, 422): do not retry
- **Non-retriable/quota** (402): stop, notify user

### 5.15 Dead Letter Classification (v0.2)

**Raised by**: Distributed Systems (Medium)

When a job exhausts retries, classify: transient, gear_bug, plan_rejected, user_error, resource_limit. Bridge surfaces failure patterns. Users can filter by classification and retry transient failures in bulk.

### 5.16 Handle LLM Reasoning Failures (v0.1)

**Raised by**: AI Researcher (Medium)

Add table of LLM failure modes and responses: malformed JSON (retry up to 2 times), model refusal (retry once rephrased, then escalate to user), infinite replanning loop (break at 3 iterations), truncated output (retry with reduced context), empty/nonsensical output, repetitive output.

### 5.17 Startup Self-Diagnostic (v0.1)

**Raised by**: DevOps (High)

On startup, check: data directory writable, port available, database files readable, disk space > 500MB, RAM > 1GB, Node.js >= 20. Warnings don't prevent startup; abort-level failures exit with non-zero code.

### 5.18 Message Size Limits (v0.1)

**Raised by**: Distributed Systems (Medium)

Enforce 1 MB maximum serialized message size. For large results, use file references instead of inline content. Log warning when messages exceed 100 KB.

### 5.19 Add Startup and Lifecycle Sequence (v0.1)

**Raised by**: Software Architect (Major)

Document 7-step startup: load config + init logging, open DBs + run migrations, Axis startup, component registration, crash recovery, Bridge startup (readiness gate), ready.

Health probes: liveness (`/api/health/live`, 200 after step 1), readiness (`/api/health/ready`, 200 after step 6, 503 during startup).

Graceful shutdown: stop new connections -> stop new jobs -> wait 30s for running jobs -> SIGTERM Gear (SIGKILL after 10s) -> persist state -> close DBs -> exit 0.

---

## 6. Performance & Resource Management

### 6.1 SQLite Worker Thread (v0.1)

**Raised by**: Performance Engineer (P1), Database Engineer (Medium), Software Architect (Major)

`better-sqlite3` is synchronous and blocks the Node.js event loop. WAL checkpoints take 50-200ms on SD card.

All database operations run in a dedicated `worker_threads` worker. Main thread handles HTTP/WS/LLM/routing and never touches SQLite. Use `MessagePort` for async communication (~0.05-0.1ms overhead). Open two connections per database: write connection and `readonly: true` read connection.

`shared/` exports an async database client wrapping synchronous calls.

### 6.2 Publish Tested Memory Budget for Raspberry Pi (v0.1)

**Raised by**: Performance Engineer (P1)

Replace vague "Raspberry Pi Optimizations" with concrete memory budget:

| Component | 4GB Pi | 8GB Pi |
|-----------|--------|--------|
| OS | ~600 MB | ~600 MB |
| V8 heap | 512 MB | 1024 MB |
| SQLite page caches | 160 MB | 400 MB |
| Gear sandboxes | 300 MB | 600 MB |
| LLM SDK + buffers | 40 MB | 60 MB |
| Ollama (optional) | 0 or 800 MB | 0 or 800 MB |
| Headroom | ~400 MB | ~500 MB+ |

Critical: Running Ollama with Gear on 4GB Pi exceeds budget. Default to API-based embeddings on 4GB. Node.js MUST start with explicit `--max-old-space-size` (512/1024/2048 by tier). These budgets MUST be validated with real measurements before claiming Pi 4 support.

### 6.3 Recommend SSD Over SD Card (v0.1)

**Raised by**: Performance Engineer (P1), Database Engineer (Medium), DevOps (Medium)

SD cards have 0.5-2 MB/s random write vs. 200-300 MB/s for USB 3.0 SSD (100-600x difference). Amend deployment table to say "32+ GB SSD (recommended) or SD card (limited)."

Setup wizard should detect removable storage and warn. SD card I/O tuning: `PRAGMA wal_autocheckpoint = 5000`, stagger checkpoint timing, run FTS5 optimize only during idle.

Estimate write volume: ~50-200 MB/day. SD card may degrade within 2-3 years.

### 6.4 Clarify Gear Sandbox Mechanism and Concurrency Limits (v0.1)

**Raised by**: Performance Engineer (P1)

Three sandboxing levels with resource profiles:

| Level | Mechanism | Memory | Cold Start | Max Concurrent (Pi) |
|-------|-----------|--------|------------|---------------------|
| 1 (default) | `child_process.fork()` + seccomp/sandbox-exec | ~10-15 MB | 50-150ms | 3-4 |
| 2 (optional) | `isolated-vm` V8 isolates | ~30-50 MB | 135-360ms | 2 |
| 3 (Docker) | Containers | Variable | 1-3s | 2 |

Define concurrency limits per deployment target. Excess parallel steps are serialized.

### 6.5 Add Performance Infrastructure (v0.1)

**Raised by**: Performance Engineer (P1)

New Section 11.3:
- **V8 GC tuning**: `--max-old-space-size` and `--optimize-for-size` per deployment tier
- **Memory watchdog**: Graduated response at 70%/80%/90% RSS thresholds. Emergency response when system free memory < 256MB: kill all Gear, pause all jobs
- **Event loop monitoring**: Continuous `monitorEventLoopDelay()` sampling. Warn at p99 > 50ms, error at p99 > 200ms. If blocked > 5 seconds, capture diagnostic dump
- **Connection limits** per deployment tier

### 6.6 Address sqlite-vec Brute-Force Search Scaling (v0.3)

**Raised by**: Performance Engineer (P2), Software Architect (Minor)

sqlite-vec uses brute-force kNN scan. At 10,000 vectors/768 dims: 50-120ms warm cache on Pi.

Mitigations in order: (1) LRU embedding cache keyed on content hash, (2) page cache pre-warming on startup, (3) dimensionality reduction via PCA from 768 to 256 for >5,000 vectors, (4) monitoring with notification at 10,000 threshold, (5) tiered search — search last N days first.

### 6.7 Phase-Aware Scheduling (v0.2)

**Raised by**: Performance Engineer (P2)

Axis tracks current phase of each in-flight job. Each resource-intensive phase has an independent semaphore: `gearSemaphore` (2-3 on Pi, 6-8 on Mac Mini), `llmSemaphore` (3/6), `reflectionSemaphore` (1/2).

### 6.8 Address Memory Leak Vectors (v0.1)

**Raised by**: Performance Engineer (P2)

Five specific vectors with defenses:
1. Gear sandbox: track creation timestamp, mandatory disposal deadline
2. WebSocket: ping/pong heartbeat (30s interval, 10s timeout)
3. Prepared statements: cache at module level, not per-request
4. Event listeners: job-scoped auto-deregistered on terminal state
5. LLM streams: wrap with abort controllers, never leave unconsumed

### 6.9 Cold Start Optimization (v0.1)

**Raised by**: Performance Engineer (P2)

Target cold start: < 3 seconds on Pi 4 with SSD. Startup budget: Node.js + modules < 800ms, SQLite < 300ms, migrations < 200ms, Fastify < 200ms, Gear manifests < 300ms, queue recovery < 200ms. Total < 2,000ms.

Lazy loading: Ollama, LLM provider connections, sqlite-vec warm-up. Pre-warming in background after startup.

### 6.10 Embedding Model Migration Strategy (v0.3)

**Raised by**: Performance Engineer (P2)

When the user changes embedding models, all existing vectors become incompatible. Mark stale vectors, use mixed-model querying (weight fresh 1.5x), background re-embed in batches during idle. Show user time/cost estimate and ask for confirmation.

### 6.11 Drop pkg Single-Binary Strategy (v0.1)

**Raised by**: Software Architect (Minor)

`pkg` has compatibility issues with native modules (better-sqlite3) and limited ARM64 support, not maintained since 2023. Distribute as Node.js application or Docker image.

### 6.12 Honest RAM Requirements (v0.1)

**Raised by**: DevOps (High)

Correct the Pi 4 minimum RAM: native install needs 2GB, Docker Meridian-only needs 4GB, Docker Compose with SearXNG needs 8GB. Docker Compose + SearXNG is NOT viable on 4GB Pi.

Add Docker Compose profiles: SearXNG behind a `search` profile. Add explicit `deploy.resources.limits`.

---

## 7. User Experience & Interface

### 7.1 Dual-Mode Interface: Chat + Mission Control (v0.1)

**Raised by**: UI/UX Designer (Critical)

Single scrolling chat is wrong for a task automation platform. Long-running tasks get buried, parallel tasks interleave, approvals get lost.

**Conversation View (Chat)**: scrolling message thread for dialogue. Running tasks shown as compact reference cards with "View progress" link.

**Mission Control (Dashboard)**: spatial, status-oriented view with active tasks (real-time progress, step trackers), pending approvals (always-visible, prominent), recent completions, scheduled jobs, system health.

On wider screens (>=1280px): both visible simultaneously (conversation left, mission control right). On narrower: toggle between them.

### 7.2 Approval UX and Trust Tiers (v0.1)

**Raised by**: UI/UX Designer (Critical), Power User (Critical), Non-Technical User (Critical), Product Manager (Medium)

**Approval dialog**: plain-language summary, step checklist with color-coded risk levels, three options (Approve, Details, Reject). Single unified dialog for multi-step plans (batch approval). "Review individually" for per-step approve/deny.

**Trust profiles** selectable during onboarding:
- **Supervised** (default for first week): prompt for every approval-required action
- **Balanced**: auto-approve low/medium risk, prompt for high/critical
- **Autonomous**: auto-approve everything except critical

Hard floor policies (financial, system config, shell) cannot be overridden.

**Approval fatigue mitigation** (Power User):
- After N approvals of same category (default: 5), suggest creating a standing rule
- Session-scoped auto-approval for bounded duration (max 4 hours)
- Quiet hours: approval prompts queued, delivered when hours end
- Trust maturity indicator in Bridge

### 7.3 Mobile Responsiveness and PWA (v0.2)

**Raised by**: UI/UX Designer (Critical)

Breakpoints: Mobile (<768px) single-column, Tablet (768-1279px) collapsible sidebar, Desktop (>=1280px) side-by-side.

Progressive Web App: service worker for offline notification queuing, web app manifest for "Add to Home Screen", Push API support.

Mobile approval: Web Push notifications with action buttons (Approve/Reject/View Details). Time-limited, single-use approval URLs for webhook-based approval.

### 7.4 Onboarding Wizard (v0.1)

**Raised by**: Non-Technical User (Critical), Product Manager (Critical), UI/UX Designer (Critical), Power User (High)

Four steps, target under 3 minutes:
1. **Create password** (30 seconds): single field, no username/email.
2. **Add AI key** (2 minutes): provider logos, Anthropic pre-selected, one key is enough. Do NOT mention Scout/Sentinel or ask for two keys. Validate immediately with test call.
3. **Choose comfort level** (30 seconds): plain-language mapping to Supervised/Balanced/Autonomous trust profiles.
4. **First message**: welcome message with 3-4 clickable starter prompts chosen from installed Gear.

Wizard stores progress for resume. Re-accessible from settings.

### 7.5 User-Facing Vocabulary (v0.1)

**Raised by**: Product Manager (High), UI/UX Designer (High), Non-Technical User (High)

Comprehensive mapping:
| Internal | User-Facing |
|----------|------------|
| Scout planning | "Thinking..." or "Figuring out how to do this..." |
| Sentinel validating | "Checking safety..." |
| Sentinel rejected | "This was flagged: [plain reason]" |
| needs_user_approval | "I need your OK before proceeding" |
| Gear executing | "Working on it..." or specific ("Searching the web...") |
| Gear failed | "Something went wrong: [plain reason]. Try different approach?" |
| Journal reflecting | Nothing visible (async) |
| ExecutionPlan | Not surfaced |
| Gear | "skill" or "tool" in UI; "Gear" in developer docs only |
| Sentinel Memory | "Trust settings" in UI |

Error messages: "Couldn't fetch the web page. [Reason]. Want me to try a different approach?" not "Gear web-fetch failed with exit code 1."

Developer mode (opt-in in settings) shows internal names, raw plans, Sentinel details, Gear logs.

### 7.6 Step-by-Step Progress and Error Communication (v0.1)

**Raised by**: UI/UX Designer (High), AI Tooling Engineer (High)

Task cards for full-path tasks: task name, step tracker (collapsible, like shipping order tracker), elapsed time, progress percentage, Cancel button.

Failure communication: brief non-technical explanation + "See Details" + side-effect disclosure + rollback option if available.

Background-first: tasks don't block conversation. Completion/failure triggers notification. Clicking goes to mission control task card.

### 7.7 Cost Visibility (v0.2)

**Raised by**: Non-Technical User (High), Product Manager (High), Power User (Medium)

Per-task cost display (expandable). Cost dashboard: today/week/month breakdown by component and model, savings from mitigations, estimated monthly cost, remaining budget.

Cost estimation during setup with representative table: light ($0.50-1.50/day), moderate ($1.50-3.00/day), heavy ($3.00-5.00+/day).

### 7.8 Memory Profile Page (v0.3)

**Raised by**: UI/UX Designer (Medium)

Two interaction modes:
- **Conversational**: "What do you know about me?" / "Forget X" / "Stop remembering for now"
- **Profile page**: "About You" (preferences, environment), "Skills Learned" (procedures/Gear), "Recent History" (timeline), "Privacy Controls"

Does NOT use terms "episodic/semantic/procedural memory."

### 7.9 Notification Hierarchy (v0.2)

**Raised by**: UI/UX Designer (High)

Default triggers: approval needed (in-app + push + external), task failed (in-app + push), task completed (in-app only), system health warning (in-app + push). Quiet hours: only approvals break through. Digest mode: daily summary for low-priority (opt-in).

### 7.10 Loading States and Empty States (v0.1)

**Raised by**: UI/UX Designer (Medium)

Loading state for every transition: typing indicator, "Thinking..." animation, "Checking safety...", step-by-step tracker, "Having trouble connecting. Retrying..."

Empty state for every surface: welcome + starter prompts, empty task list, empty memory.

### 7.11 Dark Mode (v0.1)

**Raised by**: UI/UX Designer (Low)

Dark mode as default, light mode toggle. Respect system `prefers-color-scheme` on first visit. Tailwind `dark:` variants.

### 7.12 Keyboard Shortcuts (v0.1)

**Raised by**: UI/UX Designer (Low)

`/` = focus chat, `Cmd+K` = command palette, `Cmd+Enter` = send, `Escape` = dismiss, `Cmd+.` = cancel task.

### 7.13 Undo Semantics (v0.2)

**Raised by**: UI/UX Designer (Low)

Undoable: file writes (previous version kept for session), file deletes (workspace/trash/ for 24 hours), config changes. Show "Done. [Undo]".

Non-undoable: sent emails, external API calls, shell commands. Show "Done. (This action can't be undone.)"

### 7.14 Built-in Status Dashboard (v0.2)

**Raised by**: DevOps (Medium)

Add `/status` page: system health (CPU, memory, disk with trends), component status, job metrics, cost tracking, recent errors. Auto-refreshes via WebSocket. Prometheus metrics remain opt-in.

---

## 8. Privacy & Data Handling

### 8.1 Honest Privacy Framing (v0.1)

**Raised by**: Privacy Advocate (High)

The lead sentence "All data stays on the user's device" is technically inaccurate for external LLM API deployments.

Rewrite Core Principle #2: "All persistent data is stored locally on your device. Task processing requires sending portions of your data to the LLM API providers you configure -- Meridian transmits the minimum context necessary and logs every external transmission for your review. You can eliminate external data sharing entirely by using local models via Ollama."

Add Bridge: visual indicator when data is transmitted externally vs. processed locally.

### 8.2 Acknowledge PII Stripping Limitations (v0.3)

**Raised by**: Privacy Advocate (High), Security Expert (Medium)

Replace "PII stripping" with "PII reduction" — a defense-in-depth measure with known limitations. Even SOTA NER achieves 85-92% recall on standard PII categories.

Two-pass PII reduction: (1) pattern-based (regex for emails, phones, SSNs, credit cards, IPs), (2) LLM-based pass for context-dependent PII.

Add memory staging: new memories enter a "staging" state visible in Bridge for configurable review period (default 24 hours) before committed.

Add special category data handling: per-category settings for GDPR Article 9 data (health, biometrics, political, religious, sexual orientation): store normally, store with extra review, or never store.

### 8.3 Surface LLM Provider Data Handling Policies (v0.2)

**Raised by**: Privacy Advocate (Medium)

During provider configuration, display standardized privacy summary card: training data usage, retention period, data residency, sub-processors, link to DPA.

### 8.4 Correct Embedding Inversion Claims (v0.3)

**Raised by**: Privacy Advocate (Medium)

Change "No embedding inversion" to "Embedding inversion resistance." Research shows partial inversion is possible. Strongly recommend local embedding via Ollama (default).

### 8.5 Audit Log Verbosity Modes (v0.2)

**Raised by**: Privacy Advocate (Medium)

Full (default): records specific targets/details. Reduced: records action type and risk level but replaces specific targets with generalized categories. On deletion request, anonymize audit logs rather than deleting.

### 8.6 Voice Data Privacy Lifecycle (v0.4)

**Raised by**: Privacy Advocate (Medium)

Default to local whisper.cpp transcription. Voice data lifecycle: captured in-browser memory only, never written to disk, local transcription by default, raw audio deleted immediately after transcription, never persisted or sent to LLM APIs.

### 8.7 Image/Video Privacy Handling (v1.0+)

**Raised by**: Privacy Advocate (Medium)

EXIF metadata stripping before processing. Face detection advisory before external LLM transmission. Video: extract keyframes locally. Defer to when image/video processing is implemented.

### 8.8 Tighten Data Retention Defaults (v0.3)

**Raised by**: Privacy Advocate (Low)

Reduce conversation message default from 90 to 30 days. Add memory decay review: memories not retrieved for 180 days surfaced for user review. Data minimization mode preset available.

### 8.9 Complete Right to Deletion (v0.3)

**Raised by**: Privacy Advocate (Low)

Expand to cover all data stores. External data notice: inform user that data sent to LLM providers may be retained per their policies. Deletion verification: Axis runs integrity check confirming all stores purged.

### 8.10 Add Privacy Governance Foundations (v0.3)

**Raised by**: Privacy Advocate (Low)

Add Section 7.6 mapping GDPR data subject rights to Meridian features. Add Section 7.7: External Data Flow Summary table listing every external data flow with what data is sent and how to avoid it.

### 8.11 Classification-Aware Context Retrieval (v0.3)

**Raised by**: Privacy Advocate (Medium)

Reduce default recent conversation window from 20 to 10 messages. Reduce default top-k memories from 5 to 3. Confidential-tier memories require higher relevance threshold (>0.90 vs. default >0.75).

---

## 9. Developer Experience & Open Source

### 9.1 License Declaration (v0.1)

**Raised by**: Open-Source Maintainer (Critical)

Apache-2.0. Explicit patent grant, no enterprise bans, broad compatibility. Require CLA from contributors for sublicense rights without transferring copyright.

### 9.2 Gear Developer Kit (v0.4)

**Raised by**: Open-Source Maintainer (High), AI Tooling Engineer (Medium)

Ship `@meridian/gear-sdk`:
- TypeScript types for GearManifest/GearContext/GearAction
- MockGearContext with injectable responses
- Factory functions for test fixtures

CLI commands:
- `meridian gear create <name>`: scaffold with manifest template, entry point, test file
- `meridian gear validate <path>`: validate manifest, permissions, JSON Schema
- `meridian gear test <path>`: run in sandbox environment mimicking production

Built-in Gear serve as reference implementations.

### 9.3 Right-Size Contribution Guidelines (v0.1)

**Raised by**: Open-Source Maintainer (High)

Single maintainer review (not two). Security-critical code MUST include tests; other code SHOULD. Define "safe contribution zones": Bridge UI components, documentation, built-in Gear, test improvements, CLI/error messages.

### 9.4 Governance Model (v0.1)

**Raised by**: Open-Source Maintainer (Medium)

Document current BDFL model. Security non-negotiable rules cannot be weakened without public RFC. Security disclosure process: email to security contact, 48-hour ack, 7-day assessment, 72-hour patch for critical, 90-day coordinated disclosure. SECURITY.md in repo root. Contributor Covenant v2.1 in CODE_OF_CONDUCT.md.

### 9.5 Simplify Release Strategy (v0.1)

**Raised by**: Open-Source Maintainer (Medium)

Pre-1.0: single version number for entire project (no per-package versioning). Single channel (no beta). Manual changelogs. Breaking changes expected and frequent.

### 9.6 Phased Testing Requirements (v0.1)

**Raised by**: Open-Source Maintainer (Medium)

Not all testing ships with v0.1:
- **v0.1**: Integration tests (message flow e2e), mock LLM provider, security tests for Sentinel/Gear sandbox, unit tests for Axis job scheduling
- **v0.2**: Journal memory CRUD, LLM evaluation framework, prompt injection test suite
- **v0.3**: E2E Playwright tests, Gear Synthesizer validation, sandbox escape tests

Principle: no PR may break existing tests; security-critical code must include tests.

### 9.7 Add LLM Evaluation Framework (v0.2)

**Raised by**: AI Researcher (Critical)

New Section 13.5:
- Evaluation dimensions: Scout plan validity/acceptance rate, Sentinel true/false positive rate, Journal Recall@5/MRR, Gear Synthesizer pass rate
- Benchmark suite in `tests/evaluation/` with graded difficulty
- Run automated evaluation in CI on any change to Scout, Sentinel, Journal, or prompt templates
- A/B testing for prompts
- Track per-task-type success rate as "learning curve" metric

### 9.8 Add Prompt Versioning Strategy (v0.2)

**Raised by**: AI Researcher (Medium)

Store prompts as versioned template files in each module's `src/prompts/` directory. Changes to prompt files trigger the LLM evaluation suite in CI. Treat prompt changes with the same rigor as security-sensitive code.

### 9.9 Acknowledge AI-Assisted Development (v0.1)

**Raised by**: Open-Source Maintainer (Medium)

Explicitly document that the project uses AI coding assistants. Explain what the AI config files do. State that contributors do not need to use AI tools.

### 9.10 Blessed Installation Method Per Platform (v0.1)

**Raised by**: DevOps (High)

One CI-tested method per platform:
- Raspberry Pi: install script (no Docker overhead)
- Mac Mini: install script or npm global
- Linux VPS: Docker Compose
- Development: npm install from git clone

CI installation testing matrix on every release.

### 9.11 CLI Diagnostics (v0.2)

**Raised by**: DevOps (Medium)

- `meridian doctor`: comprehensive diagnostic (Node.js version, DB integrity, disk/memory, port, config, vault). Both human-readable and JSON output.
- `meridian debug-bundle`: sanitized diagnostic archive for bug reports. Excludes user content, API keys, memories.
- Structured error codes: `<COMPONENT>_<CATEGORY>_<SPECIFIC>`. Displayed in UI, included in logs, linked to documentation.

---

## 10. Documentation & Framing

### 10.1 Soften OpenClaw Framing (v0.1)

**Raised by**: Open-Source Maintainer (High), Product Manager (High)

Rename Section 3 to "Lessons from Existing AI Agent Platforms." Rename "What OpenClaw Got Wrong" to "Common Failure Patterns." Frame as industry-wide analysis using OpenClaw as a concrete case study, not a direct attack. Move detailed competitive analysis to a separate `docs/competitive-analysis.md`.

### 10.2 Reframe Executive Summary (v0.1)

**Raised by**: Product Manager (High)

Add "Target User" subsection: technical power user who wants AI automation they control. Developer or technically proficient. Has/willing to get API key. Wants data on own hardware.

Rewrite Key Differentiators to lead with:
1. Gets better the more you use it (Journal + Gear Suggester)
2. Self-hosted and private
3. Safe by design (structural, not optional)
4. Starts small, grows with you

Rewrite opening paragraph to lead with learning capability, not low-power devices.

### 10.3 Reframe Deployment Targets (v0.1)

**Raised by**: Product Manager (Medium)

Reorder: Laptop/Desktop first ("Primary development and daily-use target"), Mac Mini/Home Server, Linux VPS, Raspberry Pi last ("Supported with documented tradeoffs").

### 10.4 Include Generic Terms Alongside Theme Names (v0.1)

**Raised by**: Open-Source Maintainer (Low)

Ensure all diagrams and flow descriptions include generic terms in parentheses alongside theme names on first reference in each section: Scout (planner), Sentinel (validator), Journal (memory), Bridge (UI/API), Gear (plugins), Axis (runtime).

### 10.5 Clarify "Learning" Terminology (v0.1)

**Raised by**: AI Researcher (Low)

Change "It learns and improves over time through reflection on successes, failures, and user feedback" to "It adapts and improves over time by accumulating knowledge from successes, failures, and user feedback -- storing reusable patterns, building new capabilities, and refining its behavior based on what works for each user."

### 10.6 Add End-to-End User Story Traces (v0.1)

**Raised by**: Product Manager (High)

Add 2-3 concrete stories traced through the full architecture with component, action, and timing at each step. These serve as acceptance tests for v0.1.

### 10.7 Narrow Sentinel's Documented Validation Scope (v0.1)

**Raised by**: Software Architect (Major)

Sentinel cannot meaningfully evaluate ethical or legal context because the information barrier withholds user intent. Split validation categories into "fully assessable" (security, privacy, financial, policy compliance, composite risk) and "partially assessable" (ethical — structural patterns only; legal — common patterns only).

### 10.8 Add Alternatives Considered (v0.1)

**Raised by**: Software Architect (Minor)

Add brief "Alternatives Considered" sections for key decisions: SQLite vs. PostgreSQL vs. DuckDB; Fastify vs. Hono vs. Express; Zustand vs. Redux; dual-LLM vs. single-LLM; single package vs. workspaces.

### 10.9 Position as Orchestration Layer (v0.1)

**Raised by**: Power User (Low)

Add "Intended Role" section: Meridian is not a replacement for Home Assistant, n8n, or IFTTT. It is an intelligent orchestration layer that makes existing tools accessible through natural language.

### 10.10 Cost Comparison Context (v0.1)

**Raised by**: Non-Technical User (Medium)

Acknowledge that API costs ($45-90/month for moderate use) exceed consumer AI subscriptions ($20/month). Explain the premium: local data storage, task execution, persistent memory, safety validation, no vendor lock-in. Note local models can reduce/eliminate costs at the expense of quality.

### 10.11 Acknowledge Sustainability Question (v0.1)

**Raised by**: Open-Source Maintainer (Low)

Acknowledge without committing. Options: open core, hosted service, sponsorship, support contracts. Apache-2.0 + CLA preserves all options.

---

## 11. Deferred / Future Considerations

These items were raised by critics but are explicitly deferred beyond the v0.4 horizon:

| Item | Raised By | Rationale for Deferral |
|------|-----------|----------------------|
| Multi-user support | Multiple | Adds auth complexity; single-user covers target audience |
| Messaging integrations (WhatsApp, Discord, Telegram) | AI Researcher, Open-Source Maintainer | Requires Bridge extensions; not core value |
| Gear marketplace | Open-Source Maintainer | Premature until 20+ community packages; use curated awesome-list |
| Full local LLM as primary | Power User | Requires significant model improvements for quality planning |
| Agent-to-agent federation | Open-Source Maintainer | Research problem; revisit with adoption |
| Proactive behavior | Open-Source Maintainer | Trust model and UX not ready |
| Video input processing | Architecture doc | Limited utility for task automation |
| WCAG 2.1 AA compliance | Architecture doc | Important but not blocking for target audience |
| Prometheus metrics | DevOps | Opt-in in v0.2, full implementation deferred |
| Wake word detection | Non-Technical User | Requires always-on audio, privacy concerns |
| Companion mobile app | Non-Technical User | PWA covers most needs |
| Home speaker integration | Non-Technical User | Requires voice pipeline maturity |
| One-click desktop installer | Non-Technical User | Requires packaging infrastructure |
| Managed hosting ("Meridian Cloud") | Non-Technical User | Sustainability decision |

### Memory & Learning Improvements (v0.4+)

| Item | Source | Details |
|------|--------|---------|
| Multi-tag memory classification | AI Researcher | Memories can have multiple type tags with cross-references |
| Multi-signal confidence scoring | AI Researcher | Source count, recency, user confirmations, temporal decay |
| Explicit conflict resolution rules | AI Researcher | Threshold-based supersession, user corrections |
| Procedural memory demotion | AI Researcher | Auto-exclude procedures with >40% failure rate |
| Dynamic context budgets | AI Researcher | Adapt token budgets by task type |
| Rolling conversation summary | AI Researcher | Compress older messages instead of dropping |
| Plan replay cache | Power User | Skip Scout for known patterns (cosine > 0.95) |

### Expanded Built-in Gear (v0.2+)

| Gear | Source | Phase |
|------|--------|-------|
| web-search | Architecture doc | v0.2 |
| scheduler | Architecture doc | v0.2 |
| notification | Architecture doc | v0.2 |
| email (IMAP/SMTP) | Non-Technical User, Power User | v0.3 |
| calendar (CalDAV) | Non-Technical User, Power User | v0.3 |
| http-api (generic REST client) | AI Tooling Engineer, Power User | v0.3 |
| code-runner (isolated JS/TS) | AI Tooling Engineer | v0.3 |
| data-transform (CSV/JSON/XML) | AI Tooling Engineer | v0.3 |
| reminders | Non-Technical User | v0.3 |
| weather | Non-Technical User | v0.4 |
| notes | Non-Technical User | v0.4 |
| ssh-remote | Power User | v0.4 |
| docker-manage | Power User | v0.4 |
| home-assistant | Power User | v0.4 |
| git-ops | Power User | v0.4 |
| rss-feed | Power User | v0.4 |

### Reliability Enhancements (v0.3+)

| Item | Source | Details |
|------|--------|---------|
| Completion verification | AI Tooling Engineer | Scout verifies aggregated results against original request |
| Output validation | AI Tooling Engineer | Null/empty detection, error-in-success, type conformance |
| Cost-aware planning | AI Tooling Engineer | Include remaining budget in Scout's context |
| Convergence detection in replanning | AI Tooling Engineer | Track plan similarity across revision iterations |
| Heartbeat for long-running Gear | AI Tooling Engineer | Heartbeat interval, stall detection |
| Multi-language Gear via Docker | AI Tooling Engineer | Python, Go, Rust base images |

### Security Enhancements (v0.3+)

| Item | Source | Details |
|------|--------|---------|
| Composite-action analysis | AI Researcher, Security Expert | Sentinel evaluates combined effect of all steps |
| Security advisory notifications | DevOps | Fetch signed advisory file daily |
| Internal secret rotation | DevOps | HMAC key, session key rotation |
| Security posture indicator | Security Expert | Persistent indicator in Bridge |
| Dual-validation for high-risk plans | Security Expert | Request Sentinel twice with different phrasing |

### Offline Mode Tiers (v0.4+)

**Raised by**: Power User (High)

Replace binary online/offline with tiered behavior:
- Tier 1 (full local): both Scout and Sentinel local
- Tier 2 (hybrid, recommended): cloud primary, local fallback
- Tier 3 (queue-only): no local model, all jobs queued

---

## Summary Statistics

| Category | v0.1 | v0.2 | v0.3 | v0.4+ | Total |
|----------|------|------|------|-------|-------|
| Architecture & Core Design | 8 | 3 | 0 | 3 | 14 |
| Security | 6 | 4 | 3 | 1 | 14 |
| Database & Storage | 6 | 2 | 3 | 0 | 11 |
| Reliability & Systems | 11 | 6 | 0 | 2 | 19 |
| Performance | 8 | 1 | 2 | 0 | 11 |
| UX & Interface | 8 | 5 | 1 | 0 | 14 |
| Privacy | 1 | 2 | 6 | 2 | 11 |
| Developer Experience | 6 | 4 | 0 | 1 | 11 |
| Documentation | 11 | 0 | 0 | 0 | 11 |
| **Total** | **65** | **27** | **15** | **9** | **116** |
