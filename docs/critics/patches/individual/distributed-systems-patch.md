# Architecture Patches: Distributed Systems Review

> **Source**: `docs/critics/distributed-systems.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Add Idempotency Framework to Gear Execution

**Severity**: Critical
**Review Findings**: #3, #4, #11 — Queue Durability Gap, Crash Recovery Retries Side Effects, No Idempotency Mechanism
**Target Sections**: 9.3 (Gear API), 5.1.5 (Fault Tolerance), 5.6.3 (Sandboxing Model)

### Rationale

The architecture has at-least-once delivery semantics (crash recovery resets `executing` jobs to `pending`) but no idempotency mechanism. This is the single most consequential design gap: a system that autonomously sends emails, executes shell commands, and makes API calls will inevitably duplicate side effects on crash recovery. The Gear API (`GearContext`) has no `executionId`, no `hasAlreadyExecuted()` check, and no transactional wrapper. Every Gear author would need to implement their own idempotency logic — most will not. The fix requires an execution log at the framework level that prevents re-execution of completed steps.

### Changes

**9.3 — Amend the `GearContext` interface to include idempotency primitives:**

Replace:
```typescript
interface GearContext {
  // Read parameters passed to this action
  params: Record<string, unknown>;

  // Read allowed secrets (only those declared in manifest)
  getSecret(name: string): Promise<string | undefined>;

  // Read files (only within declared paths)
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  listFiles(dir: string): Promise<string[]>;

  // Network (only to declared domains)
  fetch(url: string, options?: FetchOptions): Promise<Response>;

  // Communicate back to the user
  log(message: string): void;    // Append to execution log
  progress(percent: number, message?: string): void; // Update progress

  // Spawn sub-tasks (goes through Axis → Scout → Sentinel)
  createSubJob(description: string): Promise<JobResult>;
}
```

With:
```typescript
interface GearContext {
  // Execution identity (stable across retries of the same step)
  executionId: string;            // Derived from jobId + stepId, stable across retries

  // Read parameters passed to this action
  params: Record<string, unknown>;

  // Read allowed secrets (only those declared in manifest)
  getSecret(name: string): Promise<string | undefined>;

  // Read files (only within declared paths)
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  listFiles(dir: string): Promise<string[]>;

  // Network (only to declared domains)
  fetch(url: string, options?: FetchOptions): Promise<Response>;

  // Communicate back to the user
  log(message: string): void;    // Append to execution log
  progress(percent: number, message?: string): void; // Update progress

  // Spawn sub-tasks (goes through Axis → Scout → Sentinel)
  createSubJob(description: string): Promise<JobResult>;
}
```

**9.3 — Add after the `GearContext` interface and its description:**

```markdown
#### 9.3.1 Idempotency and Execution Log

Meridian provides at-least-once delivery: jobs that were `executing` at crash time are retried
(Section 5.1.5). To prevent duplicate side effects on retry, Axis maintains a durable
**execution log** in `meridian.db`:

```sql
CREATE TABLE execution_log (
  execution_id TEXT PRIMARY KEY,     -- jobId + ':' + stepId (stable across retries)
  gear_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_execution_log_status ON execution_log(status);
```

**Before dispatching a Gear action**, Axis checks the execution log:

```
Axis prepares to dispatch step
      │
      ▼
Check execution_log for this executionId
      │
      ├── Found, status = 'completed' ──► Return cached result, skip execution
      │
      ├── Found, status = 'started' ───► Previous attempt crashed mid-execution.
      │                                   Mark as 'failed', proceed with re-execution
      │                                   (Gear may receive duplicate if the previous
      │                                   attempt completed its side effect but crashed
      │                                   before recording — see note below)
      │
      └── Not found ───────────────────► INSERT (status: 'started'), then dispatch
```

**After Gear completes**, Axis updates the execution log to `completed` with the result.

**Important limitation:** The execution log cannot prevent *all* duplicates. If a Gear action
completes its side effect (e.g., sends an email) but the process crashes before Axis records
`completed` in the execution log, the retry will re-execute. This is an inherent limitation of
at-least-once delivery without distributed transactions. However, the execution log eliminates
the more common case: crash after Axis records completion but before the job status is updated.

**Gear author guidance:** For Gear that performs non-idempotent operations (sending messages,
making purchases, mutating external state), the `executionId` is available in `GearContext`.
Gear authors are encouraged to pass it as an idempotency key to external APIs that support
them (e.g., Stripe's `Idempotency-Key` header, SendGrid's `idempotency_key`). The built-in
`notification` and `shell` Gear use the execution log automatically.
```

**5.1.5 — Amend the crash recovery bullet to reference the execution log:**

Current:
> - **Crash recovery**: On restart, Axis loads persisted queue state. Jobs that were `executing` at crash time are reset to `pending` for retry.

Proposed:
> - **Crash recovery**: On restart, Axis loads persisted queue state. Jobs that were `executing` at crash time are retried using **step-level resume** (Section 9.3.1): Axis reads the execution log to determine which steps completed successfully and resumes from the first incomplete step. Completed steps are not re-executed — their cached results are used. Only steps that were `started` but not `completed` (indicating a crash during execution) are re-dispatched. This minimizes duplicate side effects, though Gear that completed a side effect but crashed before the execution log was updated may still experience one duplicate (see Section 9.3.1 for mitigation guidance).

---

## Patch 2: Add Step-Level Checkpointing to Execution Model

**Severity**: Critical
**Review Finding**: #4 — Crash Recovery Retries Side Effects (Partial-Execution Problem)
**Target Sections**: 5.1.2 (Job Model), 4.5 (Data Flow), 5.2.2 (Execution Plan Format)

### Rationale

A multi-step plan may complete steps 1-3 and crash during step 4. Resetting to `pending` reruns all steps including those that already had side effects. The architecture needs step-level checkpointing so crash recovery resumes from the last incomplete step, not from the beginning of the plan.

### Changes

**5.1.2 — Amend the Job interface to include step tracking:**

Replace:
```typescript
interface Job {
  // --- Required (Axis needs these for lifecycle management) ---
  id: string;                    // UUID v7 (time-sortable)
  status: 'pending' | 'planning' | 'validating' | 'awaiting_approval'
        | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;             // ISO 8601

  // --- Free-form (components attach whatever is relevant over the job's lifecycle) ---
  [key: string]: unknown;       // parentId, priority, source, plan, validation, result,
                                // error, attempts, maxAttempts, timeoutMs, metadata, etc.
}
```

With:
```typescript
interface Job {
  // --- Required (Axis needs these for lifecycle management) ---
  id: string;                    // UUID v7 (time-sortable)
  status: 'pending' | 'planning' | 'validating' | 'awaiting_approval'
        | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;             // ISO 8601
  currentStepIndex: number;      // Index of the step currently executing (0-based).
                                 // Updated atomically as each step completes.
                                 // On crash recovery, execution resumes from this index.

  // --- Free-form (components attach whatever is relevant over the job's lifecycle) ---
  [key: string]: unknown;       // parentId, priority, source, plan, validation, result,
                                // error, attempts, maxAttempts, timeoutMs, metadata, etc.
}
```

**4.5 — Amend step 8 (Execution) to describe step-level checkpointing:**

Current:
> 8. **Execution**: Axis dispatches approved steps to the appropriate Gear (built-in, user-installed, or Journal-generated), each running in a sandboxed environment. Steps execute sequentially or in parallel as specified by the plan.

Proposed:
> 8. **Execution**: Axis dispatches approved steps to the appropriate Gear, each running in a sandboxed environment. For sequential steps, Axis advances the job's `currentStepIndex` and records each step's result in the execution log (Section 9.3.1) before dispatching the next step. This ensures crash recovery resumes from the last incomplete step, not the beginning of the plan. For parallel steps (within the same `parallelGroup`), all steps in the group are dispatched concurrently and their completion is tracked individually in the execution log. The group is complete when all its steps have completed.

**4.5 — Amend step 9 (Result Collection) to describe partial-failure handling:**

Current:
> 9. **Result Collection**: Gear returns results to Axis. If a step fails, Axis routes back to Scout for replanning using a potentially different approach or Gear.

Proposed:
> 9. **Result Collection**: Gear returns results to Axis. Each step's result (success or failure) is recorded in the execution log. If a step fails, Axis routes back to Scout for replanning using a potentially different approach or Gear. The replanning context includes which steps already completed successfully (and their results) so that Scout can produce a plan that builds on completed work rather than re-executing it. See Section 5.2.7 for replanning context.

---

## Patch 3: Define Complete Job State Transition Table

**Severity**: High
**Review Findings**: #2 — Undefined Transitions, Unbounded Revision Loops, Inconsistency Between Section 4.5 and 5.3.3
**Target Sections**: 5.1.2 (Job Model), 5.3.3 (Validation Response Format), 4.5 (Data Flow)

### Rationale

The job lifecycle defines 8 states but never specifies the complete transition table. Several transitions are ambiguous: `validating -> planning` loops have no counter, `executing -> planning` transitions can oscillate indefinitely, and Section 4.5 lists three Sentinel verdicts while Section 5.3.3 lists four. Without explicit transition guards and cycle limits, jobs can loop unboundedly, consuming LLM API budget.

### Changes

**5.1.2 — Add after the Job interface:**

```markdown
#### 5.1.2.1 State Transition Table

All job state transitions are implemented as atomic compare-and-swap operations in SQLite:
`UPDATE jobs SET status = ? WHERE id = ? AND status = ?`. If the affected row count is 0,
the transition was invalid and is logged as a warning.

| From | To | Trigger | Guard |
|------|----|---------|-------|
| `pending` | `planning` | Worker claims job | None (atomic claim via UPDATE) |
| `planning` | `validating` | Scout produces plan (full path) | Plan is structurally valid |
| `planning` | `completed` | Scout responds directly (fast path) | Scout flagged as fast path |
| `validating` | `executing` | Sentinel approves | `verdict = 'approved'` |
| `validating` | `awaiting_approval` | Sentinel requests user approval | `verdict = 'needs_user_approval'` |
| `validating` | `planning` | Sentinel requests revision | `verdict = 'needs_revision'` AND `revisionCount < 3` |
| `validating` | `failed` | Sentinel rejects | `verdict = 'rejected'` OR `revisionCount >= 3` |
| `awaiting_approval` | `executing` | User approves | User action via Bridge |
| `awaiting_approval` | `cancelled` | User rejects | User action via Bridge |
| `executing` | `completed` | All steps succeed | No remaining steps |
| `executing` | `failed` | Step fails, max retries exceeded | `stepAttempts >= maxStepAttempts` AND `replanCount >= maxReplanCount` |
| `executing` | `planning` | Step fails, replan requested | `replanCount < maxReplanCount` |
| Any non-terminal | `cancelled` | User cancels | User action via Bridge |

**Terminal states**: `completed`, `failed`, `cancelled`. No transitions out of terminal states.

**Cycle limits** (tracked as required fields on the Job, not free-form):

| Counter | Scope | Default Limit | What Happens at Limit |
|---------|-------|---------------|----------------------|
| `revisionCount` | Per plan cycle | 3 | Sentinel rejection → job fails |
| `replanCount` | Per job lifetime | 2 | Step failure → job fails instead of replanning |
| `stepAttempts` | Per step per plan | 3 (existing `maxAttempts`) | Step failure → triggers replan or job failure |

These counters are stored as required fields in the Job record (not in the free-form catch-all)
so they are inspectable by monitoring and administrative tooling. The maximum total LLM calls
for a single job is bounded: `(1 + maxReplanCount) * (1 + maxRevisionCount) * Scout calls +
Sentinel calls ≤ 24` by default.

**Revision counter reset:** When a replan occurs (transition from `executing` back to
`planning`), the `revisionCount` resets to 0 for the new plan cycle, but `replanCount`
increments. This allows the new plan to go through Sentinel's revision process independently.
```

**5.3.3 — Add `needs_revision` to the Section 4.5 step 6 description for consistency:**

Current (Section 4.5, step 6):
> Sentinel returns one of: `APPROVED`, `REJECTED(reason)`, or `NEEDS_USER_APPROVAL(reason)`.

Proposed:
> Sentinel returns one of: `APPROVED`, `REJECTED(reason)`, `NEEDS_USER_APPROVAL(reason)`, or `NEEDS_REVISION(reason, suggestedRevisions)`. `NEEDS_REVISION` triggers Scout to revise the plan (up to 3 revision iterations per plan cycle, tracked by `revisionCount`).

---

## Patch 4: Add Per-Conversation Job Ordering

**Severity**: High
**Review Finding**: #10 — No Ordering Guarantee for Sequential User Messages
**Target Sections**: 5.1.3 (Concurrency Model), 5.1.4 (Scheduling)

### Rationale

Users naturally compose tasks by sending sequential messages: "Create report.txt" then "Add a summary to report.txt." With concurrent workers, the second job can begin executing before the first completes, failing because the file doesn't exist yet. The architecture has no cross-job ordering mechanism. Per-conversation serial execution is the simplest fix that covers the most common case.

### Changes

**5.1.3 — Add after the Step Parallelism bullet:**

```markdown
- **Per-conversation ordering**: Jobs originating from the same conversation (identified by
  a conversation ID assigned by Bridge) execute serially — Axis does not start job N+1 from
  a conversation until job N has reached a terminal state (`completed`, `failed`, or
  `cancelled`). Jobs from different conversations (including scheduled jobs and webhook-
  triggered jobs) execute concurrently, limited by the worker pool.

  This provides the ordering guarantee users expect when sending sequential messages, without
  serializing the entire system. The implementation is straightforward: when a worker claims a
  job, it checks whether any non-terminal job from the same conversation exists. If so, the job
  remains `pending` and the worker claims the next eligible job.

  ```sql
  -- Atomic job claim with per-conversation ordering
  UPDATE jobs SET status = 'planning', worker_id = ?
  WHERE id = (
    SELECT j.id FROM jobs j
    WHERE j.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.conversation_id = j.conversation_id
          AND j2.status NOT IN ('completed', 'failed', 'cancelled')
          AND j2.id != j.id
      )
    ORDER BY j.priority, j.created_at
    LIMIT 1
  );
  ```

  **Note**: Scheduled and event-driven jobs have no `conversation_id` (or a synthetic one per
  schedule/event source). They execute concurrently with each other and with interactive jobs.
```

**8.3 — Amend the `jobs` table to include `conversation_id`:**

Add to the jobs table schema:
```sql
  conversation_id TEXT,            -- Groups sequential user messages for ordering
```

Add to the indexes:
```sql
CREATE INDEX idx_jobs_conversation ON jobs(conversation_id, status);
```

---

## Patch 5: Specify Timeout Hierarchy and Cooperative Cancellation

**Severity**: High
**Review Finding**: #8 — Three Layers of Timeouts, Zero Specification of Interaction
**Target Sections**: 5.1.5 (Fault Tolerance), 5.6.2 (Gear Manifest), 5.2.4 (LLM Provider Abstraction)

### Rationale

The architecture defines timeouts at multiple layers (job-level, step-level, graceful shutdown, LLM API, watchdog) but never specifies how they interact. A job with a 5-minute timeout containing steps with 5-minute step timeouts will fire conflicting timeouts. LLM API calls have no per-call timeout specified. Timeouts during Gear execution leave cleanup unspecified. The graceful shutdown timeout (30s) is too short for any LLM-dependent job.

### Changes

**5.1.5 — Add after the existing fault tolerance bullets, as a new subsection:**

```markdown
#### 5.1.5.1 Timeout Hierarchy

Timeouts are nested with strict precedence. An inner timeout can never exceed its outer
timeout's remaining budget:

```
Job timeout (default: 300s)
  ├── Planning timeout: min(60s, remaining job budget)
  │     └── Scout LLM call timeout: min(30s, remaining planning budget)
  ├── Validation timeout: min(60s, remaining job budget)
  │     └── Sentinel LLM call timeout: min(30s, remaining validation budget)
  └── Step timeout: min(step.timeoutMs, remaining job budget)
        └── Gear execution timeout: equals step timeout
```

**Per-call LLM timeout:** Every LLM API call has a per-call timeout of 30 seconds by default
(configurable). This is separate from the step timeout. A streaming response that produces no
tokens for 30 seconds is treated as timed out — the request is aborted. A streaming response
that produces tokens slowly (below 1 token/second sustained for >60 seconds) is flagged as
stalled and the request is cancelled and retried.

**Timeout during Gear execution — cooperative cancellation:**

When a timeout fires while Gear is executing, Axis follows a three-phase shutdown:

1. **Signal** (0s): Axis sends a cancellation signal to the Gear sandbox. For process
   isolation, this is SIGTERM. For container isolation, this is `docker stop` (which sends
   SIGTERM).
2. **Grace period** (5s): Axis waits up to 5 seconds for the Gear to clean up and exit.
   During this period, the Gear can flush writes, close connections, and report partial
   results.
3. **Force kill** (after 5s): If the Gear has not exited, Axis sends SIGKILL (process) or
   `docker kill` (container). Any partial state is logged in the execution log as `failed`
   with reason `timeout`.

Partial state left by a killed Gear (temp files, open connections, incomplete writes) is
cleaned up during the next idle maintenance cycle. The workspace `temp/` directory is
purged of files older than 1 hour.

**Graceful shutdown interaction:**

The system-level graceful shutdown timeout (30 seconds) acts as a hard ceiling. When
SIGTERM/SIGINT is received:

1. Axis stops accepting new jobs.
2. Running jobs are given `min(30s, remaining job timeout)` to complete.
3. If a job cannot complete in time, its current step's state is recorded in the execution
   log as `started` (not `completed`). On restart, crash recovery resumes from this step
   (Section 9.3.1) rather than replaying the entire job.
4. Queue state is persisted. Axis exits.

This means a graceful shutdown followed by restart produces at most one duplicated step
(the one that was interrupted), not a full job replay.
```

**5.2.4 — Add to the LLM Provider interface:**

After the existing interface, add:
```markdown
**Timeout configuration:** LLM provider implementations must respect the following timeouts:

- `requestTimeoutMs` (default: 30000): Maximum time to wait for the first response token.
- `streamStallTimeoutMs` (default: 30000): Maximum time between consecutive tokens during
  streaming. Reset on each received token.
- `totalTimeoutMs`: Inherited from the enclosing step's remaining budget.

If any timeout fires, the provider implementation must abort the HTTP request and throw a
`TimeoutError` with details about which timeout fired and how far the response had
progressed.
```

---

## Patch 6: Add Replanning Context for Step Failures

**Severity**: High
**Review Finding**: #4 (partial) — Crash Recovery and Replanning Lose Context of Completed Steps
**Target Section**: 5.2 (Scout — Planner LLM) — add new subsection 5.2.7

### Rationale

When a step fails and Scout replans, or when a job resumes after crash recovery, Scout needs to know which steps already completed and what their results were. Without this, Scout produces a new plan from scratch that may re-execute completed steps or conflict with their outputs. The architecture mentions `rollback` as a free-form field but provides no mechanism for communicating completed-step context to Scout during replanning.

### Changes

**5.2 — Add new subsection 5.2.7 after 5.2.6:**

```markdown
#### 5.2.7 Replanning Context

When Scout is asked to replan (due to step failure, Sentinel revision, or crash recovery),
it receives additional context beyond the normal planning inputs:

```typescript
interface ReplanContext {
  // --- Required (Axis provides these from the execution log) ---
  originalPlan: ExecutionPlan;          // The plan that was being executed
  completedSteps: CompletedStep[];      // Steps that finished successfully
  failedStep: FailedStep;              // The step that failed (with error details)

  // --- Free-form ---
  [key: string]: unknown;             // replanReason, attemptNumber, etc.
}

interface CompletedStep {
  stepId: string;
  gear: string;
  action: string;
  result: unknown;                     // The Gear's return value
  sideEffects: string[];              // Human-readable description of what changed
                                       // (e.g., "wrote file /workspace/report.txt",
                                       //  "sent email to alice@example.com")
}

interface FailedStep {
  stepId: string;
  gear: string;
  action: string;
  error: unknown;                      // The error from Gear execution
  attempts: number;                    // How many times this step was tried
}
```

Scout's system prompt includes explicit instructions for replanning:

```
When replanning after a step failure:
1. DO NOT re-execute steps that already completed. Their results are provided.
2. DO NOT undo completed side effects unless explicitly necessary for a new approach.
3. Build on the completed work — adjust only the remaining steps.
4. If the failure is due to a missing prerequisite, add the prerequisite step and then
   retry the failed step.
5. If the failure is permanent (e.g., API not available, permission denied), report the
   failure to the user rather than retrying the same approach.
```

This context is assembled from the execution log (Section 9.3.1), which durably records
each step's status and result. The `sideEffects` field is populated by Gear via the
`log()` method in `GearContext` — Gear authors are encouraged to log human-readable
descriptions of side effects.
```

---

## Patch 7: Specify Delivery Guarantee and Queue Claim Semantics

**Severity**: High
**Review Finding**: #3 — Queue Durability Gap Between Dequeue and Commit
**Target Sections**: 5.1.3 (Concurrency Model), 5.1.5 (Fault Tolerance)

### Rationale

The architecture never states its delivery guarantee. The phrase "in-process priority queue backed by SQLite" is ambiguous — it could mean SQLite-as-queue or in-memory-queue-with-SQLite-persistence, each with different failure modes. The at-least-once semantics implied by crash recovery need to be explicit, and the job claim mechanism needs to be atomic to prevent duplicate dispatch.

### Changes

**5.1.3 — Replace the Job Queue bullet:**

Current:
> - **Job Queue**: In-process priority queue backed by SQLite for persistence. Jobs survive restarts.

Proposed:
> - **Job Queue**: SQLite is the queue. There is no in-memory queue. Workers claim jobs
>   directly from the `jobs` table using an atomic compare-and-swap operation:
>   ```sql
>   UPDATE jobs SET status = 'planning', worker_id = ?
>   WHERE id = (
>     SELECT id FROM jobs
>     WHERE status = 'pending'
>     ORDER BY priority, created_at
>     LIMIT 1
>   );
>   ```
>   If the UPDATE affects 0 rows, another worker claimed the job first (or no jobs are
>   pending). This eliminates the consistency gap between an in-memory queue and its SQLite
>   backing store — there is only one source of truth.
>
>   Jobs survive restarts because they are never removed from SQLite until they reach a
>   terminal state. The queue is polled at a configurable interval (default: 100ms) when
>   workers are idle.

**5.1.5 — Add a new bullet defining the delivery guarantee:**

```markdown
- **Delivery guarantee**: Meridian provides **at-least-once delivery**. A job will be
  executed at least once, but may be executed more than once if the process crashes between
  Gear execution and status update. Duplicate execution is mitigated by the execution log
  and idempotency keys (Section 9.3.1). Meridian does NOT provide exactly-once delivery —
  this is impossible without distributed transactions, and the architecture explicitly
  acknowledges this limitation.
```

---

## Patch 8: Separate Internal Component API from Gear Communication Protocol

**Severity**: Medium
**Review Finding**: #1 — In-Process Message Signing Is Unnecessary for Core Components
**Target Sections**: 4.2 (Component Interaction Model), 9.1 (Internal API), 6.3 (Internal Component Authentication)

### Rationale

Core components (Axis, Scout, Sentinel, Journal, Bridge) share a single Node.js process. HMAC-SHA256 signing of in-process messages creates the illusion of a trust boundary that does not exist — the signing key is in the same memory space. The reviewer correctly identifies that signing has real value only for Gear communication, which crosses a process/container boundary. Separating the two protocols reduces complexity and per-message overhead for internal calls while maintaining legitimate security at the Gear boundary.

### Changes

**4.2 — Amend the component interaction description:**

After the existing text, add:
```markdown
**Two communication tiers:**

Meridian distinguishes between two communication tiers based on trust boundary:

| Tier | Components | Mechanism | Signing |
|------|-----------|-----------|---------|
| **Internal** | Axis ↔ Scout, Sentinel, Journal, Bridge | Direct function calls through a typed message router | No HMAC signing (same process, same trust boundary) |
| **Sandbox boundary** | Axis ↔ Gear (child process/container) | Serialized messages over IPC/stdio | HMAC-SHA256 signed (cross-process trust boundary) |

The internal tier provides the same observability benefits as message passing (every
interaction is logged centrally, any component can be replaced with a mock) using typed
TypeScript interfaces and dependency injection. Stack traces through internal calls are
clean and follow the logical flow, rather than bottlenecking through a serialization layer.

The sandbox boundary tier uses the full `AxisMessage` protocol with HMAC-SHA256 signatures.
This is where signing has real value: the signing key is held only by the main process, and
a compromised Gear process cannot forge messages from Scout or Sentinel.
```

**9.1 — Amend the internal API section:**

After the `AxisMessage` interface, add:
```markdown
**Usage scope:** The `AxisMessage` type with HMAC-SHA256 signing is used exclusively for
communication across the Gear sandbox boundary. Internal component communication uses the
same message structure for consistency and observability, but the `signature` field is
omitted (set to an empty string) and not verified. This avoids the cost of signing and
verifying messages within a single trust boundary while maintaining a uniform message
format for logging and debugging.

If Meridian is ever refactored to run components in separate processes (Section 16),
enabling HMAC signing for internal messages requires only flipping a configuration flag —
the message format is already compatible.
```

**6.3 — Amend the internal component authentication section:**

Current:
> #### Internal Component Authentication
>
> - Components communicate through Axis using signed messages (HMAC-SHA256).
> - Signing key is generated at install time and stored in the encrypted vault.
> - A compromised Gear cannot impersonate Scout or Sentinel.

Proposed:
> #### Internal Component Authentication
>
> - **Gear boundary**: Messages between the main process and Gear sandbox processes are
>   signed with HMAC-SHA256. The signing key is generated at install time and stored in the
>   encrypted vault. It is never shared with Gear sandbox processes. A compromised Gear
>   cannot impersonate Scout or Sentinel.
> - **Internal components**: Scout, Sentinel, Journal, and Bridge run in the main process
>   and share the same trust boundary. Internal messages are not cryptographically signed
>   (the signature would protect against nothing — the key is in the same memory space).
>   Component isolation is enforced through TypeScript module boundaries and dependency
>   injection, not cryptographic signatures.

---

## Patch 9: Specify Circuit Breaker Full Lifecycle

**Severity**: Medium
**Review Finding**: #5 — Underspecified Reset Logic
**Target Section**: 5.1.5 (Fault Tolerance)

### Rationale

The circuit breaker specifies only the closed-to-open transition (3 consecutive failures in 5 minutes). The open duration, half-open testing, failure categorization, and per-action granularity are all missing. The consecutive-failure heuristic is also too aggressive for Gear interacting with unreliable external services.

### Changes

**5.1.5 — Replace the circuit breaker bullet:**

Current:
> - **Circuit breaker**: If a Gear repeatedly fails (3 consecutive failures within 5 minutes), Axis temporarily disables it and notifies the user.

Proposed:
> - **Circuit breaker**: Axis implements a per-Gear-action circuit breaker with three states:
>
>   | State | Behavior |
>   |-------|----------|
>   | **Closed** (normal) | Requests pass through. Failures are counted. |
>   | **Open** (tripped) | Requests fail immediately without executing. User is notified. |
>   | **Half-open** (testing) | A single request is allowed through to test recovery. |
>
>   **Transition rules:**
>   - **Closed → Open**: Failure rate exceeds 50% over the last 10 executions of this
>     Gear action (not consecutive failures, which is too sensitive to burst errors).
>     Minimum of 5 executions in the window before the circuit can trip.
>   - **Open → Half-open**: After a configurable cooldown period with exponential backoff
>     (initial: 30s, max: 15m, factor: 2x). The cooldown doubles on each failed half-open
>     test.
>   - **Half-open → Closed**: The test request succeeds. Failure counters reset.
>   - **Half-open → Open**: The test request fails. Cooldown period doubles.
>
>   **Granularity**: Per Gear action, not per Gear. If `file-manager.write` is failing,
>   `file-manager.read` remains available. The Gear itself is only fully disabled if all
>   of its actions are in the open state.
>
>   **Failure classification**: Not all failures trip the circuit:
>   - **Transient failures** (network timeout, 5xx, rate limit) → counted toward circuit
>     breaker threshold.
>   - **Permanent failures** (4xx, invalid parameters, authentication error) → not counted.
>     These are bugs, not availability issues. They are reported to the user immediately.
>   - **Timeout** → counted as transient failure.
>   - **Sentinel rejection** → not counted (not a Gear failure).
>
>   **Impact on queued jobs**: When a circuit is open and a job requires that Gear action,
>   Axis routes the job back to Scout for replanning with an alternative approach. If no
>   alternative exists, the job is held in `pending` until the circuit enters half-open and
>   the test succeeds, or until the user manually re-enables the Gear action via Bridge.

---

## Patch 10: Add LLM-Aware Backpressure

**Severity**: Medium
**Review Finding**: #9 — Backpressure is Queue-Level, Not LLM-Rate-Limit-Level
**Target Sections**: 5.1.3 (Concurrency Model), 5.1.4 (Scheduling)

### Rationale

The real bottleneck is the LLM API, not the queue. Rate limits, latency, and daily cost caps all constrain throughput at a level the queue-depth backpressure cannot detect. Scheduled jobs and interactive jobs compete for the same LLM capacity with no priority-aware allocation. The architecture needs rate-limit-aware scheduling with reserved capacity for interactive requests.

### Changes

**5.1.3 — Replace the Backpressure bullet:**

Current:
> - **Backpressure**: When the queue exceeds capacity, new jobs are accepted but deprioritized. Bridge informs the user of queue depth.

Proposed:
> - **Backpressure**: Axis implements multi-layer backpressure that is aware of both queue
>   depth and LLM API constraints:
>
>   **Layer 1 — LLM rate limit tracking**: Axis tracks rate limit headers from each LLM
>   provider (`x-ratelimit-remaining`, `retry-after`, or equivalent). When remaining
>   capacity drops below 20% of the provider's limit, Axis enters a **throttled** state:
>   - New non-interactive jobs (scheduled, event-driven) are deferred.
>   - Interactive jobs proceed but with a warning to the user about potential delays.
>   - Bridge displays estimated wait time based on current queue depth and rate limit
>     utilization.
>
>   **Layer 2 — Cost budget tracking**: Axis tracks cumulative daily LLM API costs. At 80%
>   of the daily limit, Bridge displays a warning. At 95%, only interactive jobs are
>   processed (scheduled jobs are deferred to the next day). At 100%, all jobs are paused
>   and the user is notified. The user can override the limit for critical tasks.
>
>   **Layer 3 — Queue depth**: When the pending queue exceeds a configurable threshold
>   (default: 50 jobs), new jobs are accepted but Bridge informs the user of the queue
>   depth and estimated processing time.
>
>   **Priority-aware capacity reservation**: Axis reserves a portion of the LLM rate limit
>   budget for interactive requests. By default, 30% of capacity is reserved — scheduled
>   jobs cannot consume more than 70% of the rate limit, ensuring interactive requests are
>   not starved by a burst of background tasks.

---

## Patch 11: Specify or Defer the Event Bus

**Severity**: Medium
**Review Finding**: #6 — Event Bus Specified in Name Only
**Target Section**: 5.1.4 (Scheduling)

### Rationale

The event bus is mentioned once and never specified. Delivery guarantees, ordering, handler failure, backpressure, persistence, subscription model, event schema, and security are all unanswered. An under-specified event bus will be a source of subtle, hard-to-reproduce bugs. The reviewer recommends either full specification or deferral to a future version.

### Changes

**5.1.4 — Replace the event-driven scheduling mode description:**

Current:
> 3. **Event-driven**: Jobs triggered by external events (webhooks, file system changes, system events). Axis exposes a lightweight event bus that Gear can publish to.

Proposed:
> 3. **Event-driven** *(v2 — deferred from initial release)*: Jobs triggered by external
>    events (webhooks, file system changes, system events).
>
>    The initial release supports only **webhook-triggered jobs** as a limited form of
>    event-driven scheduling. Bridge exposes a webhook endpoint
>    (`POST /api/webhooks/:hookId`) that creates a job from a pre-configured template when
>    called. Webhook handlers are registered via the Bridge API and associated with a job
>    template (similar to scheduled jobs). Authentication is per-webhook (each webhook has
>    a secret token).
>
>    A full event bus (with pub/sub, ordering guarantees, handler failure semantics,
>    backpressure, and Gear-to-Gear event communication) is deferred to a future release.
>    Designing an event bus correctly requires specifying delivery guarantees, persistence,
>    event schemas, and security properties — each of which is a non-trivial design decision.
>    Shipping a half-specified event bus creates a class of subtle bugs that are nearly
>    impossible to reproduce. The webhook mechanism covers the most common use case
>    (external service triggers a job) without the complexity of a general-purpose event
>    system.
>
>    **Future event bus requirements** (to be specified in a dedicated design document):
>    - Delivery guarantee (at-least-once with idempotent handlers)
>    - Event ordering (per-publisher FIFO)
>    - Handler failure isolation and dead-letter handling
>    - Backpressure (bounded queue per subscriber)
>    - Event persistence (SQLite-backed, survive restarts)
>    - Subscription model (topic-based, with Gear permission checks)
>    - Event schema (typed, validated, with provenance metadata)
>    - Rate limiting (per-publisher, to prevent DoS from malicious Gear)

---

## Patch 12: Add Request Deduplication at Ingestion

**Severity**: Medium
**Review Finding**: #13.3 — Request Deduplication
**Target Section**: 4.5 (Data Flow — step 2), 5.5.4 (Real-Time Streaming)

### Rationale

If a user double-clicks send, or Bridge's WebSocket reconnects and retransmits, two identical jobs can be created. There is no deduplication at the ingestion layer. Two identical messages sent within a short window should be collapsed into one job.

### Changes

**4.5 — Amend step 2 (Normalization) to include deduplication:**

Current:
> 2. **Normalization**: Bridge normalizes the input to a standard message format with metadata (timestamp, modality, attachments).

Proposed:
> 2. **Normalization & Deduplication**: Bridge normalizes the input to a standard message
>    format with metadata (timestamp, modality, attachments). Bridge then computes a
>    deduplication hash of the normalized message (SHA-256 of: user ID + message content +
>    timestamp rounded to the nearest 5 seconds). If a job with the same deduplication hash
>    already exists and is not in a terminal state, Bridge returns the existing job's ID
>    instead of creating a new job. This prevents duplicate job creation from double-clicks,
>    WebSocket retransmissions, or rapid repeated submissions.

**8.3 — Add to the `jobs` table:**

```sql
  dedup_hash TEXT,                 -- SHA-256 deduplication hash (nullable for scheduled jobs)
```

```sql
CREATE UNIQUE INDEX idx_jobs_dedup ON jobs(dedup_hash) WHERE dedup_hash IS NOT NULL
  AND status NOT IN ('completed', 'failed', 'cancelled');
```

The unique partial index ensures at most one active job per dedup hash, enforced at the
database level. Scheduled and event-driven jobs have a NULL `dedup_hash` and are excluded.

---

## Patch 13: Add Dead Letter Classification

**Severity**: Medium
**Review Finding**: #13.1 — Dead Letter Queue
**Target Sections**: 5.1.5 (Fault Tolerance), 8.3 (Schema Overview)

### Rationale

Failed jobs accumulate in the `jobs` table with no classification, no automated alerting on failure patterns, and no mechanism to retry after fixing the underlying issue. A dead letter classification system surfaces failure patterns and enables targeted retries.

### Changes

**5.1.5 — Add new bullet after the existing fault tolerance items:**

```markdown
- **Dead letter classification**: When a job exhausts its retries and enters the `failed`
  state, Axis classifies the failure:

  | Classification | Criteria | User Action |
  |---------------|----------|-------------|
  | `transient` | Network timeout, rate limit, 5xx error | Retryable. Bridge offers one-click retry. |
  | `gear_bug` | Gear crashed, returned invalid output, sandbox violation | Report to Gear author. Retryable after Gear update. |
  | `plan_rejected` | Sentinel rejected all plan attempts | Review Sentinel's reasoning. May require policy adjustment. |
  | `user_error` | Invalid input, missing prerequisites, cancelled by user | Not retryable without user action. |
  | `resource_limit` | Cost limit, disk full, memory exhaustion | Retryable after resource issue is resolved. |

  Bridge surfaces failure patterns: "3 jobs failed due to `transient` errors with the
  `web-fetch` Gear in the last hour" is more actionable than "3 jobs failed." Users can
  filter the job list by failure classification, and retry all `transient` failures in bulk.
```

**8.3 — Add to the `jobs` table schema:**

```sql
  failure_class TEXT CHECK (failure_class IS NULL
    OR failure_class IN ('transient', 'gear_bug', 'plan_rejected', 'user_error', 'resource_limit')),
```

---

## Patch 14: Address Loose Schema Size Limits

**Severity**: Medium
**Review Finding**: #14 — Loose Schema Enables Unbounded Message Sizes
**Target Sections**: 9.1 (Internal API), 5.2.2 (Execution Plan Format)

### Rationale

The `[key: string]: unknown` pattern allows unbounded message sizes. A verbose LLM model that includes extensive `reasoning` fields can produce multi-megabyte plan blobs that degrade SQLite read performance, stall WebSocket streaming on constrained devices, and inflate audit logs and backup sizes unpredictably. Axis does not need to inspect free-form fields, but it should enforce size limits.

### Changes

**9.1 — Add after the `AxisMessage` interface:**

```markdown
**Message size limits:** Axis enforces a maximum serialized message size of 1 MB for all
messages (internal and Gear boundary). Messages exceeding this limit are rejected with an
error. This prevents unbounded growth from verbose LLM output or large Gear results.

For messages that legitimately exceed 1 MB (e.g., a Gear returning a large file content),
the message should contain a reference (file path or job artifact ID) rather than the
content inline. Gear results larger than 1 MB are written to the workspace and referenced
by path.

Axis logs a warning when messages exceed 100 KB to help identify verbose patterns early.
```

**5.2.2 — Add after the ExecutionPlan interface:**

```markdown
**Plan size guidance:** Scout's system prompt includes instructions to keep execution plans
concise. The `reasoning` field (when included) should summarize the rationale in under 500
tokens, not reproduce the full chain-of-thought. If Scout's model produces verbose plans
that approach the 1 MB message limit, the secondary (smaller) model may actually produce
more appropriately-sized plans for simple tasks (Section 5.2.5).
```

---

## Patch 15: Specify Step-Level Parallelism Coordination

**Severity**: Medium
**Review Finding**: #7 (partial) — Step Result Coordination Unspecified
**Target Section**: 5.1.3 (Concurrency Model)

### Rationale

The architecture states Scout can mark steps as parallelizable, but the coordination semantics are unspecified: barrier behavior, partial failure handling, result assembly, and resource conflict resolution are all missing. Parallel steps writing to the same file, or one parallel step failing while siblings continue, create ambiguous states.

### Changes

**5.1.3 — Add after the per-conversation ordering addition (or replace the existing Step Parallelism bullet):**

```markdown
- **Step parallelism**: Within a job, Scout can mark steps as belonging to the same
  `parallelGroup`. All steps in a group are dispatched concurrently. Coordination follows
  a **barrier with fail-fast** model:

  **Barrier**: Axis waits for all steps in the parallel group to reach a terminal state
  (completed or failed) before proceeding to the next group or step. Results from all
  steps in the group are collected and made available to subsequent steps.

  **Fail-fast** (configurable per group): If any step in the group fails:
  - **Default behavior**: Cancel all remaining in-progress sibling steps (cooperative
    cancellation, same as timeout — Section 5.1.5.1). The entire group is marked as
    failed, triggering replanning.
  - **Optional `continueOnFailure: true`**: All sibling steps are allowed to complete.
    Only the failed step's result is marked as an error. This is useful when parallel
    steps are independent (e.g., fetching data from multiple sources where partial
    results are acceptable).

  **Result assembly**: Each step's result is stored independently in the execution log
  (Section 9.3.1). The job's `result_json` is assembled after the barrier: an array of
  step results, ordered by step ID within the group. There is no interleaving — results
  are written atomically after the group completes.

  **Resource conflicts**: Scout is responsible for ensuring parallel steps do not conflict
  (e.g., two steps writing to the same file). Sentinel validates this: if two parallel
  steps target the same resource, Sentinel flags it as `NEEDS_REVISION` with a suggestion
  to serialize them. This is a best-effort check — Sentinel may miss complex conflicts.
```

---

## Patch 16: Address Event Loop Blocking from Synchronous SQLite

**Severity**: Medium
**Review Finding**: #7 — Synchronous I/O on a Single Event Loop
**Target Section**: 14.1 (Core Technologies)

### Rationale

`better-sqlite3` blocks the Node.js event loop on every database operation. While individual indexed lookups are microseconds, operations like writing large JSON blobs, full table scans, and maintenance operations can block for noticeable durations — starving WebSocket messages, health checks, and timer callbacks. The architecture should specify which operations are offloaded to worker threads.

### Changes

This patch overlaps with Database Engineer Patch #12. If that patch is accepted, this patch adds only the following clarification to its text:

**14.1 — Add to the SQLite connection model section (or create it if Database Engineer Patch #12 is not accepted):**

```markdown
**Event loop protection:** The following operations are considered "heavy" and are
offloaded to a dedicated database worker thread (via `worker_threads`):

| Operation | Typical Duration (Raspberry Pi) | Why Offload |
|-----------|-------------------------------|-------------|
| Full `VACUUM` | 1-30s depending on DB size | Exclusive lock, full rewrite |
| FTS5 rebuild | 1-10s | Scans entire content table |
| `VACUUM INTO` (backup) | 1-10s | Full database copy |
| `ANALYZE` | 0.5-5s | Scans index statistics |
| Consistency checks | 1-5s | Cross-table scans |
| Queries scanning >10,000 rows | Variable | Unpredictable duration |
| Writing `result_json` > 100 KB | 10-50ms | Large blob I/O |

All other database operations (indexed lookups, single-row inserts, small JSON writes) run
on the main event loop. On target hardware, these complete in under 1ms and do not cause
observable blocking.

The watchdog (Section 5.1.5) monitors event loop responsiveness. If the event loop is
blocked for >10ms (not 10 seconds — a lower threshold for development/debugging), a
warning is logged with the operation that caused the block. The 10-second threshold from
Section 5.1.5 triggers a diagnostic dump for production alerting.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Add idempotency framework to Gear execution | Critical | 9.3, 5.1.5, 5.6.3, 8.3 |
| 2 | Add step-level checkpointing | Critical | 5.1.2, 4.5, 5.2.2 |
| 3 | Define complete job state transition table | High | 5.1.2, 5.3.3, 4.5 |
| 4 | Add per-conversation job ordering | High | 5.1.3, 5.1.4, 8.3 |
| 5 | Specify timeout hierarchy and cooperative cancellation | High | 5.1.5, 5.6.2, 5.2.4 |
| 6 | Add replanning context for step failures | High | 5.2 (new 5.2.7) |
| 7 | Specify delivery guarantee and queue claim semantics | High | 5.1.3, 5.1.5 |
| 8 | Separate internal API from Gear communication protocol | Medium | 4.2, 9.1, 6.3 |
| 9 | Specify circuit breaker full lifecycle | Medium | 5.1.5 |
| 10 | Add LLM-aware backpressure | Medium | 5.1.3, 5.1.4 |
| 11 | Specify or defer the event bus | Medium | 5.1.4 |
| 12 | Add request deduplication at ingestion | Medium | 4.5, 8.3 |
| 13 | Add dead letter classification | Medium | 5.1.5, 8.3 |
| 14 | Address loose schema size limits | Medium | 9.1, 5.2.2 |
| 15 | Specify step-level parallelism coordination | Medium | 5.1.3 |
| 16 | Address event loop blocking from synchronous SQLite | Medium | 14.1 |

### Findings NOT Patched (and why)

| Review Finding | Reason Not Patched |
|---------------|-------------------|
| #12 — Sentinel throughput under concurrent load | The Sentinel Memory optimization (Section 5.3.8) already addresses the most common case. Sentinel batching (combining multiple plan validations into one LLM call) is an optimization that can be added later without architectural changes. The concurrency model (parallel Sentinel calls are allowed) is already implied by the worker pool design. |
| #13.4 — Graceful queue draining for time-sensitive scheduled jobs | This is a real concern but an edge case. The correct fix (time-sensitivity metadata on scheduled jobs) adds complexity for a scenario that affects very few users. Documented as a known limitation for v1. |
| #13.5 — Queue observability metrics | Valid but low priority. The existing metrics (`meridian_jobs_total`, `meridian_llm_latency_seconds`) cover the critical signals. Queue wait time and worker utilization metrics can be added incrementally without architectural changes. |
| #15 — SQLite cross-database consistency | Addressed by Database Engineer Patch #5 (cross-database consistency model). No additional patch needed from this review. |

### Cross-References with Other Patches

| This Patch | Other Patch | Interaction |
|-----------|-------------|-------------|
| #1 (idempotency) | DB Engineer #2 (indexes) | The `execution_log` table introduced in this patch needs the indexes defined here. DB Engineer's index patch should include execution_log indexes if both are accepted. |
| #1 (idempotency) | DB Engineer #14 (JSON CHECK) | The `result_json` column in `execution_log` should have the same `json_valid()` CHECK constraint. |
| #2 (step checkpointing) | DB Engineer #5 (cross-DB consistency) | Step checkpointing writes to `meridian.db` (execution log) while Gear may write to `journal.db` (memories). The write-ahead audit pattern from DB Engineer #5 applies here too. |
| #4 (conversation ordering) | DB Engineer #2 (indexes) | The `conversation_id` column needs an index. Included in this patch. |
| #7 (queue claim) | DB Engineer #8 (PRAGMA config) | The atomic job claim relies on `busy_timeout` being set. DB Engineer's PRAGMA config patch is a prerequisite. |
| #8 (internal vs Gear signing) | DevOps/SRE patches | If DevOps patches add multi-process deployment, the internal signing bypass needs a configuration toggle. This patch includes that provision. |
| #11 (event bus deferral) | AI Tooling Engineer patches | If tooling patches assume event bus availability for MCP integration, those features also need to be deferred or adapted to use the webhook mechanism. |
| #16 (event loop blocking) | DB Engineer #12 (connection management) | These patches address the same concern. If DB Engineer #12 is accepted, this patch adds only the operation-specific duration table and watchdog threshold clarification. |
