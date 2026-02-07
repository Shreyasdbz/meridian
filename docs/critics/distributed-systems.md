# Distributed Systems Review: Meridian Architecture Document

> **Reviewer perspective**: 12+ years designing distributed systems, message queues, consensus protocols, and fault-tolerant infrastructure. Built systems processing millions of events/second. Debugged more split-brain scenarios and message ordering bugs than I care to remember.
>
> **Documents reviewed**: `docs/architecture.md` (v1.2, ~2,077 lines), `docs/idea.md`
>
> **Date**: 2026-02-07

---

## Executive Summary

Meridian's architecture borrows the vocabulary of distributed systems -- message passing, event buses, worker pools, circuit breakers, backpressure, crash recovery -- but applies it to what is fundamentally a single-process, single-user, single-machine application backed by SQLite. This creates a tension that runs through the entire design: the document pays the complexity cost of distributed systems patterns without actually getting the benefits those patterns were invented for. Worse, by invoking these concepts loosely, the architecture creates a false sense of reliability. The hard problems -- idempotency, exactly-once delivery, ordered execution, crash recovery with side effects -- are either hand-waved or not addressed at all.

The architecture is not broken. Most of these issues will be invisible in the happy path. But the failure modes described below are real, and they will surface the moment the system encounters LLM API flakiness, process crashes during execution, or concurrent job processing. For a system that executes autonomous actions -- sending emails, deleting files, running shell commands -- these failure modes are not abstract concerns. They are the difference between "my assistant sent one email" and "my assistant sent three copies of the same email."

**Severity Scale Used in This Review**:
- **Critical**: Will cause data loss, duplicate side effects, or security-relevant failures under realistic conditions.
- **High**: Will cause user-visible bugs or incorrect behavior under moderate load or failure scenarios.
- **Medium**: Design gap that will require significant rework when encountered. Acceptable for an MVP but must be addressed before any production use.
- **Low**: Conceptual imprecision or missing specification that should be documented even if not immediately implemented.

---

## 1. Single-Process Message Passing: Ceremony Without Benefit

**Severity: Medium**

### The Claim

> "Communication between components follows a strict message-passing pattern through Axis. No component directly calls another." (Section 4.2)

### The Reality

Meridian is a single Node.js process. "Message passing through Axis" is a function call to a router that dispatches to other in-process functions. The `AxisMessage` type with its `from`, `to`, `type`, and HMAC-SHA256 `signature` field (Section 9.1) is an in-process data structure being signed and verified within the same trust boundary.

Let me be precise about what this buys versus what it costs:

**What it buys:**
- Observability: Every interaction can be logged centrally. This is genuinely useful.
- Testability: Components can be mocked by replacing their message handler. Also useful.
- Future extensibility: If Meridian ever goes multi-process, the abstraction is in place.

**What it costs:**
- Performance: HMAC-SHA256 signing and verification on every in-process message is pure overhead. In a single process, the "from" field cannot be spoofed because there is no untrusted sender. The signing key is in the same memory space as every component.
- Complexity: Every interaction requires serialization, routing, deserialization. Direct function calls with TypeScript's type system would provide the same type safety with zero overhead.
- Debuggability: Stack traces through a message router are worse than direct call stacks. When Scout calls Journal for context retrieval, a direct function call gives you a clean stack trace. A message-passing indirection gives you a stack trace that bottlenecks through the Axis router, making it harder to follow the actual logical flow.
- False security model: HMAC signing of in-process messages creates the illusion of a trust boundary that does not exist. If any component is compromised (e.g., a malicious Gear escapes its sandbox), it has access to the signing key because it is in the same process. The signature provides zero additional security.

### The Nuance

The one place where message signing has value is Gear. Gear runs in separate processes or containers (Section 5.6.3). Messages between the main process and a sandboxed Gear process do cross a trust boundary, and signing those messages is legitimate. But the architecture applies the same signing ceremony to Scout-to-Axis, Sentinel-to-Axis, and Journal-to-Axis communication, where it is meaningless.

### Recommendation

Separate the internal component API (direct function calls with typed interfaces) from the Gear communication protocol (which legitimately needs message signing across process boundaries). Do not pretend that in-process components are distributed actors. They are not. The TypeScript type system and dependency injection are sufficient for the internal boundaries.

---

## 2. Job State Machine: Undefined Transitions and Concurrent Mutation

**Severity: High**

### The State Machine

The job lifecycle defines 8 states (Section 5.1.2):

```
pending -> planning -> validating -> awaiting_approval -> executing -> completed | failed | cancelled
```

### Missing Transition Definitions

The architecture document never defines the complete transition table. From reading the flow diagrams, I can infer the following transitions, but several are ambiguous:

| From | To | Trigger | Documented? |
|------|----|---------|-------------|
| `pending` | `planning` | Worker picks up job | Implied |
| `planning` | `validating` | Scout produces plan (full path) | Yes |
| `planning` | `completed` | Scout responds directly (fast path) | Implied |
| `validating` | `awaiting_approval` | Sentinel says NEEDS_USER_APPROVAL | Yes |
| `validating` | `executing` | Sentinel approves | Yes |
| `validating` | `planning` | Sentinel says NEEDS_REVISION | Yes, but problematic |
| `awaiting_approval` | `executing` | User approves | Yes |
| `awaiting_approval` | `cancelled` | User rejects | Yes |
| `executing` | `completed` | Gear succeeds | Yes |
| `executing` | `failed` | Gear fails, max retries exceeded | Yes |
| `executing` | `planning` | Step fails, Scout replans | Implied (Section 4.5, step 9) |
| Any | `cancelled` | User cancels | Implied |

### Problem 1: The `validating -> planning` Loop

When Sentinel returns `NEEDS_REVISION`, Scout revises the plan (max 3 iterations per Section 5.3.4). This means the job transitions `planning -> validating -> planning -> validating` in a loop. But the state machine has no counter. How does Axis know this is revision iteration 2 of 3? Is this tracked in the free-form `[key: string]: unknown` catch-all? If so, it is invisible to any system that inspects the job's required fields -- including any future monitoring, alerting, or administrative tooling.

More critically: what happens if Scout's revision produces a plan that Sentinel rejects outright (not `NEEDS_REVISION` but `REJECTED`) on iteration 2? The flow diagram (Section 5.3.4) shows `REJECTED` going to "Job fails with explanation." But the revision context -- why Sentinel rejected, what Scout tried -- lives in the free-form fields that Axis is explicitly designed not to inspect.

### Problem 2: The `executing -> planning` Transition

Section 4.5 step 9 says: "If a step fails, Axis routes back to Scout for replanning using a potentially different approach or Gear." This implies `executing -> planning`. But this transition is never explicitly defined, and it creates a dangerous pattern: a job can oscillate between `planning`, `validating`, and `executing` indefinitely if Scout keeps replanning and individual steps keep failing.

What bounds this? The document mentions `maxAttempts` on steps (Section 5.1.5) but not on the plan-validate-execute cycle as a whole. A job could theoretically produce 3 plans, each with 3 step retries, going through Sentinel each time -- that is 9 Sentinel LLM calls and 9 Gear executions for a single user message. With no global bound.

### Problem 3: Concurrent State Updates

SQLite in WAL mode allows concurrent reads and a single writer (Section 8.1). But Axis has configurable worker pools with 2-8 concurrent workers (Section 5.1.3). When two workers attempt to update the same job's status simultaneously -- for example, one completing a step while another times it out -- what happens?

SQLite's single-writer model means one will block. But the architecture does not specify:
- Whether status updates use transactions
- Whether there is optimistic concurrency control (e.g., `UPDATE jobs SET status = 'completed' WHERE id = ? AND status = 'executing'`)
- What happens when a status update fails because the job is already in a terminal state
- Whether step-level parallelism (Section 5.1.3) can cause two step results to arrive simultaneously for the same job

This is not a theoretical concern. With parallel steps, two Gear processes can complete near-simultaneously and both attempt to update the job. Without explicit concurrency control, the second update either silently overwrites the first (data loss) or creates an inconsistent state.

### Recommendation

Define the complete state transition table as a first-class artifact. Include transition guards (preconditions), transition effects, and maximum cycle counts. Implement state transitions as atomic compare-and-swap operations in SQLite: `UPDATE jobs SET status = ? WHERE id = ? AND status = ?`. If the affected row count is 0, the transition was invalid and must be handled explicitly.

---

## 3. Queue Durability: The Gap Between Dequeue and Commit

**Severity: Critical**

### The Claim

> "Job Queue: In-process priority queue backed by SQLite for persistence. Jobs survive restarts." (Section 5.1.3)

### The Problem

There are two possible implementations of this, and both have failure modes that the architecture does not address:

**Implementation A: SQLite is the queue.**
Workers query SQLite directly: `SELECT * FROM jobs WHERE status = 'pending' ORDER BY priority, created_at LIMIT 1`. This is simple but has the thundering herd problem -- with 4 workers polling, they can all select the same job. The fix is `UPDATE jobs SET status = 'planning', worker_id = ? WHERE id = ? AND status = 'pending'` in a single atomic statement. The document does not specify this.

**Implementation B: In-memory queue backed by SQLite.**
Jobs are loaded into an in-memory priority queue at startup and persisted to SQLite on changes. This is faster but creates a consistency window: if the process crashes after dequeueing from the in-memory queue but before persisting the status change to SQLite, the job is in an undefined state. On restart, SQLite shows `pending` but the job may have already been partially processed.

Neither implementation is specified. The phrase "in-process priority queue backed by SQLite" implies implementation B, which has the worse failure mode.

### The Delivery Guarantee Question

What delivery guarantee does the job queue provide?

- **At-most-once**: Job is removed from the queue before processing. If the process crashes during processing, the job is lost.
- **At-least-once**: Job remains in the queue during processing and is only removed on successful completion. If the process crashes, the job is retried, but this means idempotent processing is required (see Section 11).
- **Exactly-once**: Not achievable without distributed transactions, which SQLite does not support.

The architecture implicitly assumes at-least-once delivery (Section 5.1.5: "Jobs that were `executing` at crash time are reset to `pending` for retry"). But it never reckons with the consequence: at-least-once delivery requires idempotent processing, which is not addressed (see Section 11).

### Failure Scenario

1. User sends "Send an email to alice@example.com saying the report is ready."
2. Job enters queue as `pending`.
3. Worker picks it up, transitions to `planning`, then `validating`, then `executing`.
4. Gear sends the email successfully.
5. Process crashes before the job status is updated to `completed`.
6. On restart, the job is found in `executing` status and reset to `pending` (per Section 5.1.5).
7. The entire pipeline runs again. Alice receives the email twice.

This is not a pathological scenario. LLM API calls introduce latency windows of 5-30 seconds where a crash (OOM kill, uncaught exception, power failure on a Raspberry Pi) is plausible. The longer the processing takes, the wider the window for this failure.

### Recommendation

Explicitly define the delivery guarantee as at-least-once and design the Gear execution model around it. This means: (a) every Gear execution should record its completion in a durable store before reporting success, (b) Gear that performs non-idempotent operations (email, purchases, mutations) needs an idempotency key that is checked before re-execution, and (c) the architecture must include guidance for Gear authors on how to make their operations safe for retry. See Section 11 for more on idempotency.

---

## 4. Crash Recovery: Retrying Side Effects

**Severity: Critical**

### The Claim

> "Crash recovery: On restart, Axis loads persisted queue state. Jobs that were `executing` at crash time are reset to `pending` for retry." (Section 5.1.5)

### Why This Is Dangerous

This is the single most dangerous line in the architecture document. Resetting `executing` jobs to `pending` means the entire job pipeline -- planning, validation, execution -- runs again. This includes all side effects.

The document lists built-in Gear that include (Section 5.6.5):
- `file-manager`: Write and organize files (overwriting is usually safe, but delete-then-write is not)
- `shell`: Execute shell commands (many shell commands are not idempotent)
- `notification`: Send notifications (duplicate notifications are user-visible)
- `scheduler`: Create scheduled jobs (duplicate scheduled jobs will fire duplicate actions)

And this is just the built-in Gear. User-installed and Journal-generated Gear can do anything within their declared permissions: send emails, make API calls, post to social media, make purchases (within financial limits), modify databases.

### The Partial-Execution Problem

A multi-step plan may have completed steps 1-3 and crashed during step 4. Resetting to `pending` reruns the entire plan, including steps 1-3, which already executed successfully and had side effects. The architecture does not mention:

- Step-level checkpointing (recording which steps completed before a crash)
- Step-level idempotency keys
- Rollback procedures for completed steps when a later step fails
- Any mechanism for Gear to report "I already did this"

The `rollback` field mentioned in Section 5.2.2 is explicitly in the free-form `[key: string]: unknown` -- Scout can include it "when relevant" but it is not enforced, and Axis is designed to ignore free-form fields. So even if Scout includes rollback instructions, there is no guarantee they execute after a crash.

### Failure Scenario: The Cascading Duplicate

1. User: "Create a GitHub repo called 'my-project', initialize it with a README, and push it."
2. Scout plans 3 steps: (a) create repo via GitHub API, (b) initialize locally, (c) push.
3. Steps (a) and (b) complete. Process crashes during step (c).
4. On restart, job resets to `pending`. Full pipeline reruns.
5. Step (a) retries: GitHub API returns "repository already exists" error.
6. Scout replans, possibly with a different approach.
7. Depending on how Scout handles the error, the user may end up with a corrupted repo state, a duplicate repo with a suffix, or a confused error message.

This scenario is recoverable. Now consider:

1. User: "Email the quarterly report to the board distribution list."
2. Execution completes. Process crashes before status update.
3. On restart, the email is sent again to the entire board. There is no undo for sent emails.

### Recommendation

Implement step-level checkpointing. Each completed step should be durably recorded in the job's record in SQLite before the next step begins. On crash recovery, `executing` jobs should resume from the last completed step, not restart from scratch. For non-idempotent steps, require an idempotency token that the Gear runtime checks before re-execution. This is not optional for a system that sends emails and executes shell commands.

---

## 5. Circuit Breaker: Underspecified Reset Logic

**Severity: Medium**

### The Claim

> "Circuit breaker: If a Gear repeatedly fails (3 consecutive failures within 5 minutes), Axis temporarily disables it and notifies the user." (Section 5.1.5)

### What Is Missing

A circuit breaker has three states: closed (normal), open (failing, requests rejected), and half-open (testing if the failure has resolved). The architecture specifies the closed-to-open transition (3 failures in 5 minutes) but nothing else:

1. **How long does the circuit stay open?** There is no specified timeout. Does it stay open until the user manually re-enables the Gear? Until the next job that needs it? Until a configurable duration elapses?

2. **Is there a half-open state?** Standard circuit breaker design transitions to half-open after a timeout, allowing a single request through to test recovery. If it succeeds, the circuit closes. If it fails, it reopens with a longer timeout (exponential backoff). None of this is specified.

3. **What counts as a "failure"?** Does a timeout count? Does a Sentinel rejection count? Does a Gear returning an error result (vs. crashing) count? The distinction matters: a Gear that returns `{ error: "invalid API key" }` is not experiencing a transient failure and will not recover from a circuit breaker reset.

4. **What happens to jobs that need a disabled Gear?** Do they wait? Fail immediately? Get replanned by Scout with an alternative Gear? The architecture says "notifies the user" but does not specify the job-level impact.

5. **Per-Gear or per-action?** If `file-manager.write` fails 3 times, is `file-manager.read` also disabled? The circuit breaker appears to be per-Gear, which is too coarse. A Gear with 10 actions should not be fully disabled because one action has a bug.

### The Flaky Gear Problem

Consider a web-fetch Gear that works 80% of the time but fails 20% of the time due to target site flakiness. With 3 consecutive failures as the trigger, the circuit will open roughly every 125 requests (0.2^3 probability of 3 consecutive failures = 0.8%, but concentrated during periods of target unavailability). This is too aggressive for Gear that interact with unreliable external services.

### Recommendation

Specify the full circuit breaker lifecycle: open duration (with exponential backoff), half-open testing, failure categorization (transient vs. permanent), and per-action granularity. Consider using a failure rate threshold (e.g., >50% failure rate over the last 10 requests) instead of consecutive failures, which is overly sensitive to burst errors.

---

## 6. Event Bus: Specified in Name Only

**Severity: Medium**

### The Claim

> "Event-driven: Jobs triggered by external events (webhooks, file system changes, system events). Axis exposes a lightweight event bus that Gear can publish to." (Section 5.1.4)

### What Is Missing

The event bus is mentioned exactly once in the entire architecture document and is never specified. The following questions are completely unanswered:

1. **Delivery guarantee**: Is event delivery at-most-once (fire and forget) or at-least-once (persisted, retried)? If a handler crashes mid-processing, is the event redelivered?

2. **Ordering**: Are events delivered in order? If Gear A publishes event 1 and then event 2, do handlers see them in that order? What about events from different publishers?

3. **Handler failure**: If an event handler throws an exception, what happens? Is the event lost? Retried? Dead-lettered? Does the failure propagate to the publisher?

4. **Backpressure**: If events are published faster than they can be consumed, do they queue? Drop? Block the publisher?

5. **Persistence**: Are events persisted to survive restarts? If so, where? The database layout (Section 8.2) has no events table.

6. **Subscription model**: Is it pub/sub? Topic-based? Pattern-based? Can Gear subscribe to events from other Gear? Can they subscribe to internal Axis events (job completed, job failed)?

7. **Event schema**: What does an event look like? Is there a required format, or is it free-form like everything else?

8. **Security**: Can any Gear publish any event? Can a malicious Gear flood the event bus to cause a denial-of-service? Are events signed?

This is not a minor omission. Event-driven job triggering is listed as one of three core scheduling modes (Section 5.1.4). File system change detection, webhook handling, and system event monitoring all depend on this event bus existing and working correctly. Yet it receives less specification than any other feature in the document.

### Recommendation

Either specify the event bus fully (delivery guarantees, ordering, failure handling, persistence, subscription model, security) or remove it from v1 and implement it as a future addition. An under-specified event bus will be a source of subtle bugs that are nearly impossible to reproduce.

---

## 7. Concurrency Control: SQLite is Not a Concurrent Queue

**Severity: High**

### The Setup

Axis uses a configurable worker pool (2-8 workers per Section 5.1.3) pulling jobs from a SQLite-backed queue. SQLite in WAL mode allows concurrent reads but only a single writer at a time (Section 8.1).

### Problem 1: Job Assignment Atomicity

When multiple workers try to claim the next available job, they need an atomic "claim" operation. In PostgreSQL, this is `SELECT ... FOR UPDATE SKIP LOCKED`. In Redis, it is `BRPOPLPUSH`. SQLite has neither.

The typical SQLite pattern is:

```sql
UPDATE jobs SET status = 'planning', worker_id = ?
WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY priority, created_at LIMIT 1);
```

This works but requires careful implementation. The subquery and update must be in the same transaction, and SQLite's `BUSY` timeout must be configured correctly to handle write contention from multiple workers. With `better-sqlite3` (which the architecture specifies), all operations are synchronous, which means a worker waiting on a SQLite write lock blocks its entire event loop -- including health checks, WebSocket messages, and timer callbacks.

The architecture does not address this. It describes "in-process priority queue backed by SQLite" which suggests the actual queue is in-memory with SQLite as persistence, but this creates the consistency gap described in Section 3.

### Problem 2: Step-Level Parallelism

Section 5.1.3 states: "Within a job, Scout can mark steps as parallelizable. Axis dispatches parallel steps concurrently, respecting the overall worker limit."

This means multiple Gear processes can be executing steps of the same job simultaneously, and their results need to be collected and assembled. The questions:

- How are parallel step results coordinated? Is there a barrier (wait for all parallel steps to complete before proceeding)?
- What happens if one parallel step fails? Are sibling steps cancelled? Allowed to complete?
- If two parallel steps both write to the same file (different content), what happens?
- How does the job's `result_json` field get assembled from parallel step results without race conditions?

### Problem 3: `better-sqlite3` is Synchronous

The choice of `better-sqlite3` (Section 14.1) is deliberate -- it provides synchronous, fast access to SQLite. But this means every database operation blocks the Node.js event loop. With concurrent workers, parallel step execution, event handling, and WebSocket streaming all sharing the same event loop, database contention becomes a bottleneck.

The watchdog (Section 5.1.5) monitors for event loop blocks >10 seconds. A single slow SQLite write (e.g., writing a large `result_json` blob while another transaction holds the write lock) could trigger the watchdog. The watchdog's response is to "log a warning and trigger a diagnostic dump," which involves... more I/O on the already-blocked event loop.

### Recommendation

Define the concurrency control strategy explicitly. For job assignment, use SQLite's atomic UPDATE-with-subquery pattern and handle BUSY errors with retry and jitter. For step-level parallelism, define a coordination protocol (barrier, cancellation policy, result assembly). Consider whether `better-sqlite3`'s synchronous nature is compatible with the concurrency model, or whether database operations should be offloaded to a worker thread.

---

## 8. Timeout Handling: Three Layers of Timeouts, Zero Specification of Interaction

**Severity: High**

### The Timeouts Described

The architecture mentions multiple timeout layers:
- Job-level timeout: `timeout_ms` field, default 300,000 ms / 5 minutes (Section 8.3)
- Step-level timeout: Gear `resources.timeoutMs`, default 300,000 ms (Section 5.6.2)
- Graceful shutdown timeout: 30 seconds (Section 5.1.5)
- LLM API retries: exponential backoff at 30s, 1m, 5m, 15m (Section 4.4)
- Scheduler evaluation interval: 60 seconds (Section 5.1.4)
- Watchdog: 10-second event loop block detection (Section 5.1.5)

### Problem 1: Timeout Hierarchy

If a job has a 5-minute timeout and contains 3 sequential steps, each with a 5-minute step timeout, the job timeout will fire during step 2 while step 2 thinks it still has 3 minutes left. What happens?

Does the job timeout kill all running steps? Does it wait for the current step to finish? Does it set a flag that the step checks periodically? The architecture does not specify timeout hierarchy or precedence.

### Problem 2: LLM Call Timeouts

LLM API calls are the most latency-sensitive operations in the system. A single Anthropic API call can take 5-60 seconds depending on output length, server load, and network conditions. The architecture mentions exponential backoff for unreachable APIs (Section 4.4) but not:

- What is the per-call timeout for an LLM API request? (Not the same as the step timeout.)
- What happens when an LLM call hangs indefinitely (TCP connection established, no data received)? Node.js `fetch` does not have a default socket timeout.
- How does streaming interact with timeouts? A streaming response that sends one token per 10 seconds is not "timed out" by most HTTP timeout mechanisms, but it is effectively stalled.
- What is the timeout for Sentinel validation specifically? If Sentinel's LLM provider is slow, every full-path job blocks.

### Problem 3: Timeout During Side Effects

What happens when a timeout fires while a Gear is mid-execution?

- If the Gear is writing a file, the file may be left in a partial state.
- If the Gear is mid-API-call (e.g., halfway through a multi-part upload), the remote state is unknown.
- If the Gear is a container, killing the container is clean. If the Gear is a process (the Raspberry Pi default), SIGKILL may not clean up resources.

The architecture says Gear runs in sandboxes, but it does not specify how timeouts interact with sandbox cleanup. A killed Gear process may leave:
- Temporary files in the workspace
- Open network connections
- Partial writes to any resource it had permission to access
- An unknown state on the remote end of any API call it was making

### Problem 4: Graceful Shutdown Races

The graceful shutdown process (Section 5.1.5): "stops accepting new jobs, waits for running jobs to complete (with a 30-second timeout), persists queue state, then exits."

If a running job is waiting for an LLM response that takes 45 seconds, the graceful shutdown timeout will kill it at 30 seconds. The job is then in `executing` state when the process exits. On restart, it gets reset to `pending` and re-executed (with all the side-effect duplication issues from Section 4).

The 30-second shutdown timeout and the 5-minute job timeout are in tension. The shutdown timeout is too short for any meaningful LLM-dependent job to complete.

### Recommendation

Define a timeout hierarchy: job timeout > step timeout > API call timeout. Implement cooperative cancellation: when a job timeout fires, signal the running step to cancel (not kill), give it a grace period (e.g., 5 seconds) to clean up, then force-kill. For graceful shutdown, record which steps were in progress and their last known state, so crash recovery can make an informed decision about retry vs. skip. Specify per-call timeouts for LLM API requests (separate from step timeouts) and handle streaming stalls explicitly.

---

## 9. Backpressure: No Path from LLM Rate Limits to User Feedback

**Severity: Medium**

### The Claim

> "Backpressure: When the queue exceeds capacity, new jobs are accepted but deprioritized. Bridge informs the user of queue depth." (Section 5.1.3)

### The Real Bottleneck

The queue depth is not the bottleneck. The bottleneck is the LLM API. Specifically:

1. **Rate limits**: Anthropic, OpenAI, and Google all have rate limits (requests per minute, tokens per minute). A burst of user messages can exhaust the rate limit within seconds.

2. **Latency**: A single LLM call takes 2-30 seconds. With 2 workers on a Raspberry Pi and a full-path task requiring 2 LLM calls (Scout + Sentinel), the throughput is roughly 2 tasks per minute at best.

3. **Cost limits**: The architecture has a daily spending cap (Section 10.4, `daily_cost_limit_usd = 5.00`). At Anthropic's pricing, $5 buys roughly 50-100 full-path tasks. That is the system's daily capacity.

The architecture's backpressure mechanism operates at the queue level, but the actual constraint propagates from the LLM provider backward:

```
LLM rate limit hit -> Scout call blocks/retries -> Worker blocks -> Queue grows -> ??? -> User
```

The missing link is between "worker blocks" and "user feedback." The architecture says Bridge shows queue depth, but it does not specify:

- How the user knows their specific job is blocked on a rate limit (vs. just queued)
- Whether Scout's retry-with-backoff (30s, 1m, 5m, 15m) is visible to the user or just silent
- What happens when the daily cost limit is hit mid-job (the job started under budget but exceeded it)
- Whether scheduled jobs (cron) respect rate limits or compete with interactive jobs for LLM capacity

### The Priority Inversion Problem

The queue uses priorities (Section 5.1.3). Scheduled background tasks presumably run at lower priority than interactive user requests. But both compete for the same LLM API capacity. A burst of 10 scheduled tasks can exhaust the rate limit right before a user sends an urgent interactive message. The interactive message is "high priority" in the queue but the LLM API does not know or care about Meridian's priorities.

### Recommendation

Implement backpressure that is aware of the LLM API constraint. This means: (a) separate rate limit tracking per LLM provider, (b) preemptive backpressure -- reject or defer new jobs when rate limits are approaching, not just when the queue is full, (c) priority-aware rate limit allocation -- reserve a portion of the rate limit budget for interactive requests, (d) real-time user feedback showing estimated wait time based on queue depth AND current rate limit utilization.

---

## 10. Ordering Guarantees: No Guarantee, No Documentation

**Severity: High**

### The Scenario

User sends two messages in quick succession:

1. "Create a file called report.txt with the header 'Q4 Report'"
2. "Add a summary section to report.txt"

These create two jobs. Both enter the queue as `pending` with the same priority. Both get routed to workers.

### The Problem

The architecture does not specify whether jobs respect insertion order within the same priority level. The SQL schema (Section 8.3) has `created_at` on the jobs table, and a priority queue presumably orders by `(priority, created_at)`. So in theory, job 1 runs before job 2.

But consider:

1. Job 1 enters `planning`. Scout takes 3 seconds to produce a plan.
2. Job 2 enters `planning` concurrently on a different worker. Scout takes 1 second (it is a simpler task).
3. Job 2 enters `validating` before job 1.
4. Job 2 reaches `executing` and tries to add a summary to a file that does not exist yet.

The architecture has parallel workers (Section 5.1.3) and no mechanism for expressing dependencies between jobs. The priority queue respects ordering at the dequeue point, but once two jobs are dequeued by different workers, they execute concurrently with no ordering guarantee.

### Compounding the Problem

The `parent_id` field in the jobs table (Section 8.3) suggests a parent-child relationship. But it is never described. Is it for sub-jobs created by `GearContext.createSubJob`? Can it express "job B depends on job A"? Is there any dependency resolution in the scheduler?

Scout produces plans with `order` and `parallelGroup` fields (Section 5.2.2), but these are within a single plan for a single job. There is no cross-job ordering mechanism.

### Real-World Impact

This will surface immediately in practice. Users naturally compose tasks by sending sequential messages. "Deploy the new version" followed by "Check if the deployment succeeded" is a dependency chain. The user expects these to execute in order because they sent them in order. But with concurrent workers, order is not guaranteed.

### Recommendation

Implement at minimum: (a) FIFO ordering guarantee within the same priority level (dequeue in `created_at` order and do not start job N+1 until job N has left `pending`), or (b) an explicit dependency mechanism where Scout can detect that a new job references artifacts from a pending job and chain them, or (c) a serial execution mode for the same conversation (jobs from the same conversation ID execute sequentially, different conversations execute in parallel). Option (c) is the simplest and covers the most common case.

---

## 11. Idempotency: The Elephant in the Room

**Severity: Critical**

### The Core Issue

The architecture has at-least-once delivery semantics (Section 5.1.5, crash recovery resets executing jobs). It has no idempotency mechanism.

At-least-once delivery without idempotency means duplicate side effects. This is not a theoretical concern -- it is a mathematical certainty over a long enough timeline on a system that runs 24/7 on consumer hardware (Raspberry Pi) where power failures, OOM kills, and SD card I/O stalls are routine.

### What Idempotency Requires

For each Gear execution, the system needs:

1. **An idempotency key**: A unique identifier for the execution attempt that is stable across retries. This is typically derived from the job ID + step ID.

2. **A durable record of completed executions**: Before executing a step, check whether it has already been executed (by this key). If so, return the cached result.

3. **Atomic execution recording**: The execution must be recorded as complete in the same transaction as (or before) the side effect. If the side effect happens before the recording, a crash between the two means the effect is duplicated.

### Why the Architecture Cannot Retrofit This

The Gear API (Section 9.3) has no concept of idempotency. `GearContext` provides `params`, `getSecret`, `readFile`, `writeFile`, `fetch`, `log`, `progress`, and `createSubJob`. There is no:
- `executionId` or `idempotencyKey` in the context
- `hasAlreadyExecuted()` check
- Transactional wrapper around the execution

Gear authors write code that calls `fetch()` to send an email. There is no framework-level mechanism to prevent that `fetch()` from executing twice on retry. Every Gear author would need to implement their own idempotency logic, and most will not.

### What This Means in Practice

For a self-hosted assistant that runs autonomously:
- Duplicate emails sent to contacts
- Duplicate Slack/Discord messages
- Duplicate file creations (overwriting is safe; appending is not)
- Duplicate API calls to external services (billing implications)
- Duplicate shell commands (if the command is `rm -rf`, the second invocation is harmless; if it is `echo "line" >> file`, the file grows)
- Duplicate scheduled job creations (creating exponentially more duplicates)

### Recommendation

Add an `executionId` to the `GearContext`. Implement an execution log in SQLite that records `(executionId, gearId, action, status, result)`. Before dispatching a Gear action, check the execution log. If a completed record exists, return the cached result without re-executing. This is not a nice-to-have. For a system that sends emails and runs shell commands, this is a correctness requirement.

---

## 12. Sentinel as a Throughput Bottleneck

**Severity: Medium**

### The Design

Every full-path task goes through Sentinel for validation (Section 5.3). Sentinel makes an LLM API call. LLM API calls take 2-30 seconds.

### The Throughput Math

Assume:
- 2 workers (Raspberry Pi default)
- Full-path task requires Scout (5s) + Sentinel (5s) + Gear (variable)
- Sentinel uses a single LLM call per validation

With 2 workers:
- Worker 1 validates job A via Sentinel
- Worker 2 validates job B via Sentinel
- Both LLM calls execute concurrently (assuming no rate limit)

This works. But:
- Sentinel revision loops (up to 3 iterations) multiply the latency: 5s * 3 = 15s per validation in the worst case
- Sentinel Memory lookup (Section 5.3.8) must happen before the LLM call, adding database query latency
- If both workers hit the same LLM provider's rate limit, they block each other

### The Serialization Question

The architecture does not specify whether Sentinel calls are serialized (one at a time) or parallelized. If Sentinel maintains internal state (like a connection pool to its LLM provider, or an in-memory cache of recent decisions), concurrent calls may conflict. If Sentinel's LLM provider has a per-key rate limit of 10 requests/minute, and each validation takes 2 calls (initial + one revision), 5 concurrent jobs would exhaust the limit in the first minute.

### The Sentinel Memory Optimization

Section 5.3.8 describes Sentinel Memory as a bypass: previously approved action patterns are auto-approved without an LLM call. This is a good optimization for throughput. But it introduces its own problem: Sentinel Memory matching is done by `actionType` and `scope` pattern matching. The matching logic is not specified. Is `scope: "/tmp/*"` a glob? A regex? An exact prefix? Does `scope: "git push origin*"` match `git push origin main` and also `git push origin/malicious-branch --force`?

If the matching is too loose, it becomes a security bypass. If it is too strict, it provides no throughput benefit.

### Recommendation

Specify Sentinel's concurrency model (can multiple validations run in parallel?). Implement the Sentinel Memory matching algorithm precisely, with unit tests for edge cases. Consider batching: if 5 jobs are queued, extract all their plans and send them to Sentinel in a single LLM call with instructions to validate each one. This reduces 5 API calls to 1, at the cost of slightly more input tokens.

---

## 13. Missing Infrastructure: The Things That Are Not There

### 13.1 Dead Letter Queue

**Severity: Medium**

The architecture specifies that jobs fail after `maxAttempts` retries (default: 3). Failed jobs are marked with `status: 'failed'` in the jobs table. But there is no dead letter queue concept -- no separate holding area for jobs that have failed permanently, no mechanism for inspecting why they failed (beyond the `error_json` blob), no automated alerting on failure patterns, and no ability to retry dead-lettered jobs after fixing the underlying issue.

In practice, a failed job just sits in the `jobs` table forever. Over months, the table accumulates failed jobs that nobody looks at. The architecture mentions audit logging, but the audit log records actions, not failure analysis. There is no "show me all jobs that failed due to LLM timeouts in the last week" query exposed anywhere.

**Recommendation**: Implement a dead letter classification system. When a job exhausts its retries, classify the failure (transient vs. permanent, infrastructure vs. Gear bug vs. user error). Surface failure patterns in Bridge. Allow one-click retry of dead-lettered jobs.

### 13.2 Exactly-Once Semantics

**Severity: Low (for documentation)**

No system achieves exactly-once semantics without end-to-end cooperation (the publisher, the queue, and the consumer must all participate). The architecture should explicitly acknowledge this limitation and state that Meridian provides at-least-once delivery with idempotency as the mitigation strategy. Currently, the delivery guarantee is never stated, leaving implementers to guess.

### 13.3 Request Deduplication

**Severity: Medium**

If the user double-clicks the send button, or if Bridge's WebSocket reconnects and retransmits, two identical jobs can be created. There is no deduplication at the ingestion layer.

Bridge normalizes input (Section 4.5, step 2) but does not deduplicate. Two identical messages sent within 1 second should probably be collapsed into one job, but there is no mechanism for this.

**Recommendation**: Add a deduplication window at the Bridge -> Axis boundary. Hash the normalized message content + user ID + timestamp (rounded to the nearest N seconds). Reject duplicates within the window.

### 13.4 Graceful Queue Draining

**Severity: Medium**

The graceful shutdown procedure (Section 5.1.5) waits for running jobs to complete (30-second timeout), then exits. But what about `pending` jobs in the queue? They are persisted in SQLite and will be picked up on restart. This is fine for immediate jobs. But scheduled jobs that trigger during shutdown are more complex:

- A cron job fires at 09:00. The system is shutting down at 09:00:01.
- The job enters the queue as `pending`.
- Shutdown completes. The job is persisted.
- The system restarts at 09:05.
- The job runs at 09:05. Is this acceptable? For "check my email every 30 minutes," yes. For "join my 9 AM meeting," no.

The architecture does not address time-sensitive job handling during shutdown/restart gaps.

### 13.5 Observability of the Queue Itself

**Severity: Low**

The health check (Section 12.3) shows `queue_depth: 3`. The Prometheus metrics (Section 12.2) show `meridian_jobs_total{status}`. But there is no metric for:
- Queue wait time (how long jobs sit in `pending` before being picked up)
- Per-priority queue depth
- Worker utilization (what percentage of workers are busy vs. idle)
- LLM API latency percentiles (p50, p95, p99) -- critical for understanding why jobs are slow

Without these metrics, diagnosing throughput issues requires reading logs, which is not scalable even for a single-user system.

---

## 14. The Loose Schema: Freedom or Footgun?

**Severity: Medium**

This is a cross-cutting concern, not a specific systems issue, but it has significant systems implications.

### The Design

Throughout the architecture, interfaces use `[key: string]: unknown` for free-form fields. Axis only inspects required fields. Everything else passes through opaquely.

### The Systems Problem

This design makes it impossible to reason about message sizes, serialization costs, or storage requirements. A Scout model that includes verbose `reasoning` fields in every plan increases the size of every `AxisMessage`, every SQLite `plan_json` blob, every audit log entry, and every WebSocket message -- and none of these systems can predict or limit this because they explicitly do not inspect free-form fields.

Specific failure modes:
- **SQLite row size**: A plan with extensive reasoning can produce a `plan_json` blob that is megabytes. SQLite handles this, but it degrades read performance for table scans and increases backup size.
- **WebSocket message size**: Bridge streams plans to the UI via WebSocket. A 5 MB plan blob will stall the WebSocket for noticeable duration on a Raspberry Pi's limited bandwidth.
- **Audit log growth**: If audit entries include free-form details, the audit log grows unpredictably. The rotation policy (100 MB per file) could be exhausted rapidly.
- **Memory pressure**: In-memory message routing means every message is fully materialized in the Node.js heap. Large free-form payloads increase GC pressure.

### Recommendation

Implement size limits on free-form fields. Axis does not need to inspect them, but it should enforce a maximum message size (e.g., 1 MB). This prevents unbounded growth while preserving flexibility. Log a warning when messages exceed 100 KB to catch verbose models early.

---

## 15. SQLite as the Universal Answer: Where It Breaks Down

**Severity: Medium**

### What SQLite Does Well Here

For a single-user, single-process system on low-power hardware, SQLite is an excellent choice. No daemon, zero configuration, portable, well-tested. The architecture's rationale (Section 8.1) is sound.

### Where It Creates Tension

**Concurrent writes under WAL mode**: WAL mode allows concurrent readers with a single writer. With 2-8 workers attempting concurrent status updates, this means write serialization. Each status update acquires the write lock, and `better-sqlite3`'s synchronous nature means the acquiring thread blocks. With 8 workers on a VPS and a busy LLM, write contention is real.

**Multiple databases**: The architecture uses 5+ separate SQLite databases (Section 8.2). Each has its own WAL, its own write lock, and its own journal. Cross-database transactions are not atomic (SQLite does not support distributed transactions across databases). If Axis needs to update a job's status in `meridian.db` AND write an audit entry to `audit.db`, these are two separate transactions. A crash between them leaves the databases inconsistent.

**Vector search performance**: `sqlite-vec` is a relatively new extension. For semantic search over thousands of memory entries with embedding comparison, the performance characteristics on a Raspberry Pi (ARM64, limited memory) are not well-established. The architecture assumes this will work within acceptable latency but provides no benchmarks or fallback.

**WAL file growth**: Under sustained write load (active job processing, audit logging, memory updates), WAL files can grow large before checkpointing. On an SD card with limited write endurance (Raspberry Pi), this accelerates wear. The architecture mentions disk monitoring but not WAL management.

### Recommendation

Implement WAL checkpoint management (periodic forced checkpoints during idle periods). For cross-database consistency, implement a two-phase approach: write the primary record first, then the audit entry, and handle the case where the audit write fails (retry on next startup). Benchmark `sqlite-vec` on Raspberry Pi hardware with realistic data volumes (1000+ memories, 768-dimension embeddings) and document the results.

---

## Summary of Findings

| # | Issue | Severity | Effort to Fix |
|---|-------|----------|---------------|
| 1 | In-process message signing is security theater | Medium | Low -- remove signing for internal, keep for Gear |
| 2 | Undefined state transitions, unbounded revision loops | High | Medium -- formal state machine + cycle limits |
| 3 | Queue delivery guarantee unstated, gap between dequeue and commit | Critical | Medium -- define guarantee, implement atomic claim |
| 4 | Crash recovery retries side effects (duplicate emails, commands) | Critical | High -- step-level checkpointing + idempotency |
| 5 | Circuit breaker has no reset logic | Medium | Low -- specify full lifecycle |
| 6 | Event bus is unspecified | Medium | Medium -- full specification or deferral |
| 7 | Concurrent job assignment and step result collection unspecified | High | Medium -- atomic operations + coordination protocol |
| 8 | Timeout hierarchy undefined, timeout during side effects unhandled | High | Medium -- specify hierarchy + cooperative cancellation |
| 9 | Backpressure is queue-level, not LLM-rate-limit-level | Medium | Medium -- rate-limit-aware scheduling |
| 10 | No ordering guarantee for sequential user messages | High | Medium -- per-conversation serialization |
| 11 | No idempotency mechanism for non-idempotent Gear operations | Critical | High -- execution log + idempotency keys |
| 12 | Sentinel throughput under concurrent load | Medium | Low -- specify concurrency model, consider batching |
| 13 | Missing: DLQ, deduplication, graceful draining, queue observability | Medium | Medium -- incremental additions |
| 14 | Loose schema enables unbounded message sizes | Medium | Low -- size limits |
| 15 | SQLite cross-database transaction non-atomicity | Medium | Medium -- two-phase audit writes, WAL management |

### The Three Things That Must Be Fixed Before Any Production Use

1. **Idempotency** (Sections 3, 4, 11): The combination of at-least-once delivery and non-idempotent Gear execution is a correctness bug. A system that autonomously sends emails, executes shell commands, and makes API calls MUST have a mechanism to prevent duplicate execution on retry. This is not optional.

2. **Step-level checkpointing** (Section 4): Resetting multi-step jobs to `pending` on crash recovery, causing all completed steps to re-execute, is unacceptable for any Gear with side effects. This must be fixed before the system is used for anything beyond read-only operations.

3. **Job ordering within a conversation** (Section 10): Users will send sequential, dependent messages. Without ordering guarantees, the system will attempt to edit files that do not exist, check on tasks that have not started, and generally behave as if it has no short-term memory. This will be the most user-visible bug.

### A Final Note on Architectural Honesty

The architecture document uses the language of distributed systems -- message passing, event buses, circuit breakers, backpressure, crash recovery -- which suggests a level of rigor that the specifications do not deliver. Many of these concepts are named but not specified to the depth required for correct implementation.

This is not unusual for a pre-code architecture document. But it is important to be honest about what has been designed versus what has been named. "We have a circuit breaker" and "we have a mechanism that disables Gear after 3 failures" are very different statements. The former implies a well-understood pattern with closed/open/half-open states, exponential backoff, and health probing. The latter is what is actually specified.

My recommendation: for each pattern named in the document, either specify it fully (all states, all transitions, all failure modes) or call it what it is -- a simple heuristic. Simple heuristics are fine for v1. Mislabeled heuristics create false confidence and lead to bugs when implementers assume the full pattern is intended.

The architecture has genuinely good ideas -- the Sentinel information barrier, the Gear sandbox model, the three-origin Gear lifecycle. The systems infrastructure needs to be specified with the same care that the security architecture received.
