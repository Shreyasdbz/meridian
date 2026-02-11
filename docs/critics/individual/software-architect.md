# Meridian Architecture Review: Senior Software Architect

> **Reviewer**: Senior Software Architect (20+ years distributed systems, microservices, platform engineering)
> **Document Reviewed**: `docs/architecture.md` v1.2 (2026-02-07)
> **Companion**: `docs/idea.md`
> **Review Date**: 2026-02-07

---

## Executive Assessment

This is one of the more thoughtful architecture documents I have seen for a project at this stage. The threat modeling, the dual-LLM trust boundary, the explicit lessons-from-competitors section, and the honest treatment of cost tradeoffs all show mature engineering thinking. The navigation naming theme is cohesive and the component responsibilities are articulated with unusual clarity.

That said, this document suffers from a common affliction of architecture documents written before any code exists: it confuses completeness of description with completeness of design. Several critical mechanisms are specified at the interface level but hand-waved at the implementation level. The system is simultaneously over-specified in areas that do not matter yet (Prometheus metrics format, TOTP support, accessibility compliance targets) and under-specified in areas that will block the first working prototype (message bus implementation, Gear sandbox bootstrapping, error propagation semantics).

What follows is an itemized critique. Severity ratings are:
- **Critical**: Will cause architectural rework or block delivery if not addressed before implementation begins.
- **Major**: Will cause significant pain during implementation or early operation. Should be addressed in v1 design.
- **Minor**: Worth noting, can be deferred, but should be tracked.

---

## 1. Architectural Coherence

### 1.1 The Message Bus Is the Architecture, and It Does Not Exist Yet

**Severity: Critical**

The entire architecture rests on Axis as a message router. Section 4.2 states: "No component directly calls another." Section 9.1 defines `AxisMessage` with a `from`, `to`, `type`, and `signature` field. But the document never specifies:

- How message routing actually works. Is this a publish-subscribe system? A request-reply system? A point-to-point queue? The answer matters enormously because it determines concurrency semantics, backpressure behavior, and error propagation.
- How a component *registers* with Axis. Is it a plugin system? Does Axis discover components? Are they hardcoded?
- How replies work. When Scout sends a plan to Sentinel and needs the validation result back, what is the mechanism? Synchronous call wrapped in a message? Correlation IDs? Callbacks? The `AxisMessage` interface has no `correlationId` or `replyTo` field in its required fields -- these are relegated to `[key: string]: unknown`.
- What happens to messages when a component is unavailable. Is there a dead-letter queue? Retry? Timeout?
- Message ordering guarantees. Can Axis deliver messages out of order? Does it matter?

This is not a minor detail. The message bus IS the architecture. Without a concrete specification of its semantics, every component team will make different assumptions about how inter-component communication works, and you will discover the incompatibilities at integration time.

**Recommendation**: Before writing any component code, specify the message bus contract completely. Define whether it is synchronous request-reply (which is what this system actually needs for core component communication) or asynchronous (which adds complexity you may not need). A reasonable implementation for core components would be a typed function dispatch with middleware for signing and logging, reserving true message-passing for the actual process boundary (Axis-to-Gear communication, where Gear runs as separate processes or containers per Section 5.6.3). Be honest about which boundaries are in-process and which are cross-process.

### 1.2 Hybrid Process Model Is Under-Acknowledged

**Severity: Major**

The architecture describes components communicating through signed messages as if they were all separate services, but in practice the system has two distinct process models that the document conflates:

- **Core components** (Axis, Scout, Sentinel, Journal, Bridge) likely share a single Node.js process (the deployment model in Section 10.2-10.3 shows a single container/application).
- **Gear** (plugins) explicitly runs in separate child processes or Docker containers (Section 5.6.3 describes two levels of process/container isolation).

This distinction matters because it affects the value of certain design decisions:

- HMAC-SHA256 signing of messages is meaningful for the Axis-to-Gear boundary, which is a real process boundary where a compromised Gear plugin genuinely cannot access the signing key. However, for communication between core components *within the same process*, signing adds CPU overhead without a meaningful security benefit -- if an attacker has code execution in the main process, they have the signing key.
- The "fault isolation" claim in Section 4.2 ("A crashed plugin doesn't take down Scout") is accurate as stated -- the architecture specifically says "plugin," and Gear does run in separate processes/containers. However, the document does not acknowledge the converse: for core components sharing a process, an unhandled exception in Scout's LLM response parsing, for example, would crash Sentinel and Journal as well.
- The "any component can be replaced with a mock" testability benefit is achievable with dependency injection. A message bus is not required for this.

**Recommendation**: Acknowledge the two-tier process model explicitly. Design the core component communication as typed function calls with a middleware chain (for logging, auditing, error handling). Keep the full message-passing abstraction for the actual process boundary: Axis-to-Gear communication. This makes the architecture honest about where real isolation exists. If the system ever needs to split core components into separate processes, the function dispatch layer can be replaced with a real message bus at that time.

### 1.3 Sentinel Information Barrier Under Stress

**Severity: Major**

The Sentinel information barrier (Section 5.3.1) is the crown jewel of this architecture and the primary differentiator from competing systems. But the barrier has a subtle leak: the `ExecutionPlan` itself.

Consider: Scout receives the user message "Delete all my ex-girlfriend's photos from the shared drive." Scout produces a plan with steps like `{ gear: "file-manager", action: "delete", parameters: { path: "/shared/photos/jessica/*" } }`. When Sentinel reviews this plan, it sees a file deletion targeting a specific path. But the *meaning* of this deletion -- the emotional and ethical context -- is invisible to Sentinel because Sentinel cannot see the original message.

The document's own Section 5.3.2 lists "Ethical: Does this step involve deception, manipulation, or harm?" as a validation category. But Sentinel literally cannot evaluate this for most plans because it lacks the context that would make an action ethically questionable. File deletion is file deletion; the ethical dimension comes from *why*.

This is not a flaw in the concept -- the information barrier serves a real purpose (breaking prompt injection chains). But the document should be honest that Sentinel is fundamentally a *technical safety* validator, not an *ethical* one, in most cases. Ethical validation requires context that the information barrier deliberately withholds.

**Recommendation**: Narrow Sentinel's documented scope to what it can actually validate: permission compliance, resource limits, credential exposure, known-dangerous patterns, and policy enforcement. Remove or heavily qualify the "ethical" and "legal" claims. If ethical review is truly needed, it requires a different mechanism (perhaps a Scout self-check *before* the information barrier, with the acknowledgment that this is a weaker guarantee).

---

## 2. Over-Engineering vs. Under-Engineering

### 2.1 Gear Synthesizer: Ambitious to the Point of Fantasy

**Severity: Critical**

The Gear Synthesizer (Sections 5.4.3-5.4.4) proposes that Journal will autonomously:
1. Analyze task failures.
2. Write working plugin code.
3. Generate correct permission manifests.
4. Create plugins that pass sandbox validation.
5. Do all of this reliably enough that users will trust and activate the results.

This is the single most ambitious feature in the document, and it gets roughly the same level of specification as the backup rotation policy. Having an LLM write sandboxed plugin code, with correct dependency management, proper error handling, valid JSON Schema for parameters, and a least-privilege permission manifest, all from a reflection on a failed task -- this is a research problem, not an implementation detail.

The architecture does include safety mitigations: Section 5.4.3 specifies that Journal-generated Gear goes through the same security pipeline as all other Gear (sandbox, manifest, Sentinel validation), is placed in draft status, flagged with `origin: "journal"`, and requires explicit user review before activation. Users can edit or delete any synthesized Gear through Bridge. These are meaningful guardrails for the *safety* of synthesized Gear.

However, the *quality and correctness* of synthesized Gear is a separate concern, and it is under-specified:
- How does the Gear Synthesizer know what npm packages are available or safe to use?
- How does it test the Gear it creates? The document says nothing about automated testing of synthesized Gear.
- How does it handle Gear that works in the sandbox but produces incorrect results?
- What is the feedback loop when a user rejects a synthesized Gear? (Section 5.6.4 mentions "Journal notes rejection" but does not specify how this influences future synthesis attempts.)
- What prevents the Gear Synthesizer from creating Gear that is technically safe (passes sandbox validation) but functionally useless or even harmful (corrupts data within its allowed permissions)?

**Recommendation**: For v1, strip the Gear Synthesizer down to a "suggested Gear template" system. Journal identifies patterns and produces a structured description of what a Gear *should* do, along with a skeleton manifest. A human (or a separate, dedicated code-generation workflow) actually writes the code. The full autonomous Gear creation can be a v2 feature once you have real-world data on what kinds of Gear users actually need.

### 2.2 Adaptive Model Selection Is Premature Optimization

**Severity: Minor**

Section 5.2.5 specifies a primary/secondary model roster for Scout. The rationale is cost savings. But this feature requires Scout to accurately assess task complexity *before* performing the task, which is itself a complex reasoning problem.

In practice, you will spend significant effort tuning the heuristic for model selection, handling edge cases where the secondary model fails and needs to be retried on the primary model, and debugging quality issues caused by the secondary model producing subtly wrong plans. The 30-50% cost savings estimate assumes a mature system with well-understood task patterns. At launch, you have no data on task patterns.

**Recommendation**: Ship v1 with a single configured model per role. Add model routing once you have usage data that justifies the complexity.

### 2.3 Under-Specified: Gear Dependency Management

**Severity: Major**

The `GearManifest` interface (Section 5.6.2) declares permissions, resources, and actions, but says nothing about *code dependencies*. Real plugins need npm packages, system binaries, and runtime dependencies. The document mentions "Dependency lockfiles: Gear dependencies are locked and audited" (Section 6.2, LLM03) but never specifies:

- How Gear declares its npm dependencies.
- How those dependencies are installed (at install time? At first execution? In the sandbox? In the host?).
- How dependency conflicts between Gear are handled.
- How dependencies are audited for vulnerabilities.
- Whether Gear can depend on native modules (and how that interacts with ARM64/x64 cross-platform support).

For a system that targets Raspberry Pi, this is critical. Native module compilation on ARM64 is notoriously painful. A Gear that depends on `sharp` (for image processing) requires `libvips`, which may or may not be available on the host.

**Recommendation**: Define the Gear dependency model explicitly. The cleanest option is probably: Gear declares dependencies in a `package.json`, dependencies are installed into an isolated `node_modules` at install time (not in the sandbox), and the sandbox gets a read-only mount of the resolved dependencies. Native modules should be explicitly flagged in the manifest with platform compatibility annotations.

### 2.4 Under-Specified: Conversation Threading and Multi-Turn Context

**Severity: Major**

Section 5.2.3 mentions "Last N messages from the current conversation" but never defines what a "conversation" is. The `messages` table (Section 8.3) has a `job_id` reference, but:

- Can multiple jobs belong to one conversation?
- How does a new conversation start? Is there an explicit "new conversation" action, or does it happen automatically?
- When the user says "do that again but with the other file," how does Scout resolve the anaphoric reference? It needs the previous conversation context, but the context window is limited to N messages.
- What happens when a long-running background job completes and the user has moved on to a new conversation? Where does the completion notification appear?

For a conversational AI assistant, conversation management is a core UX concern, not an afterthought. The current data model (messages linked to individual jobs) does not naturally support multi-turn conversations that span multiple jobs.

**Recommendation**: Add a `conversations` table that groups messages. A conversation is a logical session. Jobs are spawned from conversations but have their own lifecycle. Completion notifications reference the originating conversation. Define rules for when a new conversation starts (explicit action, timeout, or topic change detected by Scout).

---

## 3. The Loose Schema Pattern

### 3.1 `[key: string]: unknown` Will Cause Debugging Nightmares

**Severity: Major**

The loose schema principle is applied pervasively: `Job`, `ExecutionPlan`, `ExecutionStep`, `ValidationResult`, `MemoryQuery`, `MemoryResult`, `WSMessage`, `AxisMessage`, and `SentinelDecision` all have `[key: string]: unknown` index signatures.

The document positions this as a feature: "Scout can include whatever context, reasoning, or metadata it deems relevant without being constrained by a rigid schema." But the practical consequences are severe:

- **No autocomplete or type checking on 80% of the data.** When a developer writes code that reads `plan.reasoning`, TypeScript says the type is `unknown`. Every field access requires a type guard or a cast, both of which are bugs waiting to happen.
- **Incomplete documentation of actual usage.** Section 5.2.2 does document expected free-form fields: "Scout is instructed to include fields like `reasoning`, `description`, `parallelGroup`, `order`, and `rollback` when relevant." But these are described in prose, not in the type system. A new contributor reading the `ExecutionPlan` interface sees `[key: string]: unknown` and has no way to discover these conventions without reading the surrounding narrative. The type system and the documentation diverge.
- **No refactoring safety.** If Scout starts using `estimatedCost` and someone later renames it to `costEstimate`, no compiler error will catch this. The system will silently pass `undefined` instead of a cost.
- **Database storage as JSON blobs.** The `plan_json`, `validation_json`, and `result_json` columns in the `jobs` table are opaque JSON blobs. You cannot index them, query them efficiently, or validate them at the database level.
- **Silent data loss.** If Scout produces a plan with a misspelled field name (`parallelGruop` instead of `parallelGroup`), Axis will silently ignore it, and the steps will run sequentially. No error. No warning. Debugging this will require comparing the raw JSON against the (undocumented) expected schema.

The argument that "this allows format evolution without schema migrations" is technically true but practically dangerous. Schema migrations exist for a reason: they force you to think about backwards compatibility, they provide a record of what changed, and they give you confidence that old data can still be read.

**Recommendation**: Invert the pattern. Define concrete interfaces with optional fields for all known properties. Use a single `metadata: Record<string, unknown>` field for truly free-form content. This gives you type safety on the 90% of fields that are actually used, while preserving extensibility for genuinely ad-hoc data.

```typescript
// Instead of this:
interface ExecutionPlan {
  id: string;
  jobId: string;
  steps: ExecutionStep[];
  [key: string]: unknown;
}

// Do this:
interface ExecutionPlan {
  id: string;
  jobId: string;
  steps: ExecutionStep[];
  reasoning?: string;
  estimatedCost?: CostEstimate;
  context?: PlanContext;
  journalSkip?: boolean;
  metadata?: Record<string, unknown>; // For truly ad-hoc LLM additions
}
```

### 3.2 WSMessage Is Dangerously Untyped

**Severity: Major**

The `WSMessage` interface (Section 5.5.4) has only one required field: `type: string`. Everything else is `[key: string]: unknown`. This means the WebSocket protocol is entirely untyped. The frontend has no compile-time guarantees about what fields a message contains based on its type.

This will be especially painful because WebSocket messages are the primary real-time communication channel. Every message handler in the frontend will be a minefield of `if ('content' in msg)` guards and `as` casts.

**Recommendation**: Define a discriminated union of message types:

```typescript
type WSMessage =
  | { type: 'chunk'; jobId: string; content: string; done: boolean }
  | { type: 'status'; jobId: string; status: JobStatus }
  | { type: 'approval'; jobId: string; plan: ExecutionPlan; reason: string }
  | { type: 'error'; jobId: string; error: ErrorDetail }
  | { type: 'notification'; level: string; message: string };
```

This is TypeScript. Use it.

---

## 4. Dependency Graph and Package Structure

### 4.1 Seven Packages Is Premature for a Single-Developer Project

**Severity: Major**

The monorepo has seven packages: `axis`, `scout`, `sentinel`, `journal`, `bridge`, `gear`, `shared`. Each "independently buildable and testable." For a project with zero lines of code and likely one or two developers, this means:

- Seven `package.json` files to maintain.
- Seven `tsconfig.json` files.
- Seven build configurations.
- Cross-package dependency resolution (npm workspaces is famously finicky).
- Module resolution issues between packages during development.
- Circular dependency risks requiring careful management.
- Slower `npm install` and `npm run build` due to workspace overhead.

The componentization is architecturally sound, but package boundaries are an implementation concern, not an architectural one. You can have clean component boundaries within a single package using directory structure and import conventions. Many successful projects (including many at scale) start as a single package with internal module boundaries and split into packages only when there is a concrete need (independent deployment, different release cycles, external consumers).

**Recommendation**: Start with a single package and use directory structure to enforce component boundaries:

```
src/
  axis/
  scout/
  sentinel/
  journal/
  bridge/
  gear/
  shared/
```

Use ESLint's `no-restricted-imports` rule or a tool like `dependency-cruiser` to enforce that `sentinel/` does not import from `journal/`, etc. Split into packages when (and if) a concrete need arises -- for example, if you want to publish `@meridian/gear` as a standalone SDK for plugin authors.

### 4.2 Hidden Coupling Through Shared Types

**Severity: Major**

The `shared` package is described as containing "shared types and utilities." But the architecture document defines types that are inherently cross-cutting: `Job`, `ExecutionPlan`, `ExecutionStep`, `ValidationResult`, `AxisMessage`, `GearManifest`, `GearContext`, `AuditEntry`. All of these types will live in `shared`.

The problem: `shared` becomes a God package. Every component depends on it, so every type change in `shared` triggers a rebuild of everything. Types like `ExecutionPlan` embed domain knowledge that originated in Scout (`riskLevel`, `gear`, `action`), though multiple consumers legitimately need these types: Bridge displays plans for user approval (Section 5.5.1), Sentinel validates plans (Section 5.3), and Journal reflects on execution results (Section 5.4.3). Still, any change to how plans are structured will ripple through `shared` to every consumer, creating tight coupling.

This is the classic "shared kernel" anti-pattern in DDD. The shared types become a hidden coupling mechanism that defeats the purpose of the package separation.

**Recommendation**: Keep `shared` minimal -- truly shared primitives only (ID types, date utilities, error base classes, the `ComponentId` type). Let each component define its own types for its own domain objects. Where two components need to agree on a format (Scout produces plans, Sentinel consumes plans), define the contract type in the *consumer's* package and have the producer conform to it. This makes the dependency direction explicit.

---

## 5. Scalability and Performance

### 5.1 SQLite WAL Mode Is a Single-Writer Bottleneck

**Severity: Major**

The document correctly identifies SQLite WAL mode as enabling concurrent reads with a single writer (Section 8.1). But the architecture has multiple concurrent writers:

- Axis writes job state updates.
- Journal writes memories.
- Sentinel writes decisions.
- The audit log is written by every component.
- Gear execution results are written back by workers.

With multiple SQLite databases, the writes are distributed. Note that since the architecture uses `better-sqlite3` (a synchronous driver) in a single Node.js process, writes are naturally serialized by the event loop -- there is no true concurrent write contention in the traditional sense. However, this serialization means each synchronous SQLite write blocks the event loop. On a Raspberry Pi with an SD card (random write latency: 1-10ms per operation), frequent writes to `meridian.db` (job state updates, messages, scheduler) could introduce perceptible event loop stalls under moderate load (say, 3-4 concurrent jobs with frequent status updates).

**Recommendation**: This is acceptable for v1 given the single-user constraint and the fact that `better-sqlite3`'s synchronous nature prevents actual write contention. But monitor event loop latency as a key performance metric, since synchronous database operations are the primary source of main-thread blocking. When it becomes a problem, the solution is either write batching (accumulate status updates and flush periodically) or offloading writes to a worker thread.

### 5.2 Vector Search Scalability with sqlite-vec

**Severity: Minor**

`sqlite-vec` is a solid choice for small-scale vector search, but it uses brute-force linear scan (no ANN index). With thousands of memories, each vector search will scan every embedding. At 384 dimensions (typical for small embedding models), and 10,000 memories, each search involves reading ~15 MB of vector data and computing 10,000 dot products. On a Raspberry Pi, this could take 100ms+.

**Recommendation**: Fine for v1. Document that if memory count exceeds ~50,000 entries, an alternative vector store may be needed. Consider pre-filtering by memory type and time range before vector search to reduce the scan size.

### 5.3 No Connection Pooling Model for LLM APIs

**Severity: Minor**

Section 11.2 mentions "A single persistent connection per LLM provider, reused across requests." But LLM API calls are HTTP requests that typically use connection pooling at the HTTP client level, not persistent connections. More importantly, when Scout and Sentinel make concurrent API calls (which happens on every full-path request), you need to manage rate limits across both callers for the same provider.

If Scout and Sentinel use the same provider (the "Budget" configuration), they share the provider's rate limit. The document does not address how rate limiting is coordinated between components.

**Recommendation**: Centralize LLM API access through Axis (or a shared rate limiter). When Scout and Sentinel share a provider, their requests should go through a single rate-limited queue to avoid 429 errors.

---

## 6. Error Propagation and State Machine

### 6.1 The Job State Machine Has Missing Transitions

**Severity: Major**

The documented state machine (from CLAUDE.md):

```
pending -> planning -> validating -> awaiting_approval -> executing -> completed | failed | cancelled
```

Missing transitions:
- **`planning` -> `failed`**: What if Scout's LLM API is down? The job cannot progress to `validating` because there is no plan. It should go to `failed` (or a `retrying` state).
- **`validating` -> `failed`**: What if Sentinel's LLM API is down? The document's graceful degradation table (Section 4.4) says "Queue validation. Do not execute unvalidated plans." But there is no `queued_for_validation` state. Does the job stay in `validating` indefinitely?
- **`executing` -> `planning`**: When a Gear fails and Scout replans (Section 4.5, step 9), the job needs to go back to `planning`. This transition is not in the state machine.
- **`awaiting_approval` -> `planning`**: If the user rejects the plan at the approval step (rather than cancelling the job entirely), should Scout get a chance to replan? The approval flow diagram (Section 5.3.4) shows "Reject -> Job cancelled," but a user might want to say "no, don't do it that way, try a different approach."
- **`cancelled` from all states**: The user should be able to cancel a job at any point, but the state machine does not show cancellation transitions from `planning`, `validating`, or `executing`.

**Recommendation**: Draw the complete state machine diagram with *all* valid transitions, including error and cancellation transitions from every state. Pay special attention to the replan loop (executing -> planning -> validating -> ...) and ensure there is a maximum iteration count to prevent infinite loops.

### 6.2 Replan Loop Has Unbounded Potential

**Severity: Major**

The architecture describes two replan loops:
1. Sentinel rejects, Scout revises: max 3 iterations (Section 5.3.4).
2. Gear fails, Scout replans: no stated limit (Section 4.5, step 9).

The second loop has no documented bound. If Gear execution fails, Scout replans, but the new plan could also fail, triggering another replan, which could fail again. Without a cap, this loop will burn API tokens until the daily cost limit kicks in.

**Recommendation**: Define explicit bounds for all retry/replan loops. A reasonable default: max 3 replans per job, configurable. After the maximum, the job fails with a "maximum replan attempts exceeded" error and the full history of attempts is logged for debugging.

### 6.3 Error Propagation Across the Message Bus

**Severity: Major**

When a component fails while processing a message, the error propagation model is unspecified. Consider:

1. Scout receives a job message and begins planning.
2. The LLM API returns a malformed response (not valid JSON).
3. Scout's plan parser throws an error.

What happens next?
- Does Scout send an error message back through Axis?
- Does Axis notice the unhandled rejection and update the job status?
- Does the error message have a defined format?
- Is the error logged in the audit trail?
- Does the user get notified?
- What if the error happens *while sending the error message back* (e.g., Axis is busy)?

None of this is specified. In a real message-passing system, error handling is at least 50% of the protocol design. The happy path is the easy part.

**Recommendation**: Define an `ErrorMessage` type that is part of the message bus protocol. Every component must catch errors at its message handler boundary and produce an `ErrorMessage`. Axis must have a universal error handler that updates job status and notifies the user when it receives an `ErrorMessage`. Define what happens when the error handler itself fails (last resort: log to stderr and set job to `failed`).

---

## 7. Security Design

### 7.1 Scout Determines Fast Path -- Path Selection Semantics Need Clarity

**Severity: Minor**

Section 4.3 states: "Scout determines which path to use based on the user's message." On first read, this appears to be a trust inversion -- the potentially compromised component deciding whether safety validation is needed.

However, a close reading of Section 4.3 reveals that the fast path is structurally safe by design: "On the fast path, Scout generates a response directly **without producing an execution plan**. **No Gear is invoked**, no Sentinel validation is needed, and no approval is required." The fast path is text-in, text-out only. Scout cannot take any actions on the fast path -- no file operations, no network requests, no shell commands -- because those all require Gear execution, which is exclusively available on the full path.

A prompt injection that tricks Scout into classifying an action-requiring task as fast-path would result in Scout producing a text response *without actually performing the action*. The user might get a misleading reply ("Sure, I deleted the files!"), but no files would be deleted because no Gear was invoked. This is a usability/accuracy concern, not a security bypass.

The real risk is the inverse: Scout could be tricked into *claiming* it performed an action (fast-path text response) when it didn't, misleading the user about system state. This is worth documenting but is categorically different from a Sentinel bypass.

That said, the architecture should be more explicit about how Axis distinguishes the two paths. If path selection is purely structural (Scout returned plain text → fast path; Scout returned an execution plan → full path), then the "trust inversion" concern is moot because Scout cannot bypass Sentinel while also executing actions. The document should clarify this explicitly.

**Recommendation**: Make the path selection mechanism structural and document it clearly. Axis should determine the path based on what Scout *returns* (plain text vs. structured execution plan), not based on a declared flag from Scout. If Scout's response contains any `ExecutionPlan` structure, it is always full path regardless of any other signal. This may already be the intended design, but the current wording ("Scout determines which path") is ambiguous enough to cause confusion during implementation.

### 7.2 Sentinel Can Be Starved

**Severity: Major**

If Scout and Sentinel use the same LLM provider, an attacker who can trigger many Scout requests can exhaust the provider's rate limit, preventing Sentinel from validating plans. Since unvalidated plans cannot execute (Section 4.4: "Do not execute unvalidated plans"), this creates a denial-of-service condition where the system queues tasks indefinitely.

**Recommendation**: If Scout and Sentinel share a provider, reserve a portion of the rate limit budget for Sentinel. Alternatively, give Sentinel priority access. Document this as a configuration concern and recommend separate providers for production deployments.

### 7.3 Sentinel Memory Scope Matching Is Under-Specified

**Severity: Major**

Section 5.3.8 shows Sentinel Memory storing decisions like `{ actionType: "file.delete", scope: "/tmp/*", verdict: "allow" }`. But the matching logic -- how Sentinel determines that a new action matches a stored decision -- is not specified.

- Does `scope: "/tmp/*"` use glob matching? Regex?
- Does `scope: "git push origin*"` match `git push origin main`? What about `git push origin main && rm -rf /`?
- Does `scope: "*@company.com"` match `attacker@company.com.evil.com`?
- What about path traversal: does `scope: "/tmp/*"` match `/tmp/../../etc/passwd`?

Imprecise scope matching in Sentinel Memory is a direct security vulnerability. An overly broad match could auto-approve actions the user never intended. An overly narrow match defeats the purpose of remembering decisions.

**Recommendation**: Define the scope matching semantics precisely. Use a well-understood matching system (glob with explicit rules, not regex). Canonicalize paths before matching (resolve `..`, normalize slashes). For command patterns, match only the first token (the command itself), not the full argument string. Document the matching algorithm and include it in the security test suite.

---

## 8. Missing Architectural Decisions

### 8.1 No Process Model for Startup and Lifecycle

**Severity: Major**

The document never describes how Meridian starts up. The deployment section (Section 10) shows install commands and a Docker Compose file, but the actual startup sequence is missing:

- What order are components initialized?
- Does Axis start first and then bootstrap Scout/Sentinel/Journal/Bridge?
- What happens if the database needs migration on startup? Is Bridge available during migration?
- How long does startup take on a Raspberry Pi? (Relevant because the user is waiting for the UI to load.)
- What does a cold start look like vs. a warm restart?
- Is there a health check that gate-checks component readiness before accepting user requests?

**Recommendation**: Document the startup sequence as an ordered list with dependency relationships. Axis should start first (it owns the databases and needs to run migrations). Bridge should be the last to accept connections (after all internal components report ready). Define a readiness probe separate from the liveness probe.

### 8.2 No Versioning or Compatibility Strategy for Gear API

**Severity: Major**

The `GearContext` API (Section 9.3) will be the public contract with plugin authors. But there is no versioning strategy. When you need to add a method to `GearContext`, or change the behavior of `writeFile`, how do existing Gear handle it? The manifest has a `version` field for the Gear itself, but there is no `apiVersion` field that declares which version of the `GearContext` API the Gear expects.

**Recommendation**: Add an `apiVersion` field to `GearManifest`. Define a compatibility policy (e.g., `apiVersion: 1` Gear will work on Meridian v1.x but may break on v2.0). This is cheap to add now and extremely expensive to retrofit later.

### 8.3 No Strategy for Long-Running Tasks

**Severity: Major**

The default job timeout is 300,000ms (5 minutes). But several use cases described in the idea document (building entire software projects, automating workflows, data analysis) could take hours. The architecture has no model for long-running tasks:

- How does a multi-hour task report progress?
- What happens if Meridian restarts mid-task? Is the task recoverable or does it start over?
- How does the user interact with a running task (provide additional input, redirect, abort)?
- How does a long-running Gear execution interact with the sandbox timeout?

**Recommendation**: Distinguish between "simple tasks" (single Gear execution, minutes) and "workflows" (multi-step, potentially hours). Workflows should be first-class entities with checkpoint/resume semantics. For v1, it is acceptable to limit tasks to the 5-minute window, but document this limitation explicitly so users know what to expect.

### 8.4 No Content Addressing or Idempotency

**Severity: Minor**

The system uses UUID v7 for all entity IDs, which is good for time-sortability. But there is no content-addressing or idempotency mechanism. If the user accidentally sends the same message twice (double-click, network retry), the system will create two separate jobs and execute the task twice.

**Recommendation**: Add client-generated idempotency keys to the message API. If a message arrives with an idempotency key that matches a recent message, return the existing job instead of creating a new one.

### 8.5 No Observability Into LLM Decision Quality

**Severity: Minor**

The metrics section (Section 12.2) tracks operational metrics (latency, token count, job count) but nothing about LLM *decision quality*. Over time, the most important question for this system is: "Is Scout producing good plans? Is Sentinel making correct validation decisions?" Without quality metrics, the system can degrade silently.

**Recommendation**: Track and surface: Sentinel rejection rate (too high = Scout is producing bad plans, too low = Sentinel may be rubber-stamping), user override rate (how often users approve Sentinel rejections or reject Sentinel approvals), replan rate (how often Scout needs to replan after Gear failures), and user satisfaction signals (if the user corrects or complains about results). These do not need to be Prometheus metrics; they can be aggregated in the Journal and displayed in Bridge.

---

## 9. Build, Deploy, and Operations

### 9.1 The `pkg` Single Binary Strategy Is Fragile

**Severity: Minor**

Section 10.2 mentions distributing as a "single binary (compiled TypeScript via `pkg`)." The `pkg` tool (by Vercel) has a history of compatibility issues with native modules, and `better-sqlite3` is a native module that requires platform-specific compilation. On ARM64 (Raspberry Pi), this is especially problematic.

Additionally, `pkg` has not been actively maintained since 2023. The successor project `@yao-pkg/pkg` exists but has its own stability concerns.

**Recommendation**: Drop the single-binary aspiration for v1. Distribute as a standard Node.js application installed via `npm install -g`, or use Docker (which sidesteps native module issues entirely). A single-binary distribution is a nice-to-have that can be added once the application is stable.

### 9.2 Docker Compose Master Key Source File Should Be Documented

**Severity: Minor**

Section 10.3 shows `master_key.txt` as a Docker secret sourced from a file on disk. This is actually Docker's standard and recommended pattern for file-based secrets -- inside the container, the secret is mounted via tmpfs at `/run/secrets/master_key` and exists only in memory, never touching the container's filesystem. This is more secure than the common alternative of environment variables, which are visible via `docker inspect` and often leaked in logs or crash reports.

However, the source file (`master_key.txt`) does exist as plaintext on the host disk. Note that the "secrets are never stored in plaintext" principle from Section 6.4 applies to Meridian's own credential storage (API keys, passwords, tokens managed by the vault), not to the master key bootstrap problem -- every encryption system must have a root key that enters the system from somewhere.

**Recommendation**: Document the host-side lifecycle of `master_key.txt`: recommend restrictive file permissions (`chmod 600`), note that the file can optionally be deleted after the Docker secret is created (Docker caches it), and mention Docker Swarm's external secrets or hardware security modules as options for high-security deployments. Do not recommend environment variables as a replacement -- they are less secure than Docker's file-based secrets mechanism for this purpose.

---

## 10. Philosophical Concerns

### 10.1 The Document Is a Specification, Not an Architecture

**Severity: Major (meta-level)**

This document reads more like a product specification than an architecture document. It describes *what the system does* in great detail but often glosses over *how it does it* and *why this approach was chosen over alternatives*.

Examples of what is missing:
- **Decision records**: Why SQLite over DuckDB? Why Fastify over Hono? Why Zustand over Jotai? The rationale column in the tech stack table is too brief -- "broad ecosystem, strong tooling" applies to almost every popular framework.
- **Alternative designs considered and rejected**: Was a single-LLM architecture with self-validation considered? Why was it rejected? (Section 5.3.1 partially addresses this.) Was a PostgreSQL-based design considered for users with more powerful hardware?
- **Tradeoff analysis**: The dual-LLM approach doubles API costs. The document acknowledges this but treats it as an inevitable cost rather than a deliberate tradeoff with alternatives (e.g., running Sentinel only for high-risk actions, or using a rules engine for common patterns and LLM only for novel situations).

**Recommendation**: Add an "Alternatives Considered" section for each major architectural decision. Future contributors need to understand not just what was chosen, but what was rejected and why, so they do not re-litigate settled decisions.

### 10.2 The Naming Theme Obscures Communication

**Severity: Minor**

"Axis," "Scout," "Sentinel," "Journal," "Bridge," and "Gear" are evocative names for documentation. But in code, they obscure intent. When a developer sees `axisDispatch(message)`, they need to mentally translate "Axis" to "runtime/scheduler." When reading logs, `[SENTINEL] plan rejected` requires knowing the naming convention.

This is a minor tax on every developer, every day, forever. Projects like Kubernetes also use metaphorical names (Pods, Services, Deployments), but those names have become industry-standard through massive adoption. A single-developer project does not have that luxury.

**Recommendation**: Keep the theme for branding and user-facing UI. In code and logs, use descriptive names. The scheduler module should be called `scheduler`, not `axis`. The plan validator should be called `plan-validator`, not `sentinel`. Or at minimum, always use the descriptive name in logs: `[sentinel/plan-validator]`.

---

## Summary

### Critical Issues (Must Address Before Implementation)

| # | Issue | Section |
|---|-------|---------|
| 1.1 | Message bus semantics completely unspecified | 4.2, 9.1 |
| 2.1 | Gear Synthesizer is a research problem masquerading as a feature | 5.4.3-5.4.4 |

### Major Issues (Should Address in V1 Design)

| # | Issue | Section |
|---|-------|---------|
| 1.2 | Hybrid process model under-acknowledged (core in-process, Gear out-of-process) | 4.2, 5.6.3, 10.2 |
| 1.3 | Sentinel cannot perform ethical validation without context | 5.3.1-5.3.2 |
| 2.3 | Gear dependency management unspecified | 5.6.2 |
| 2.4 | Conversation threading model missing | 5.2.3, 8.3 |
| 3.1 | Loose schema pattern will cause maintenance nightmares | Throughout |
| 3.2 | WebSocket messages are dangerously untyped | 5.5.4 |
| 4.1 | Seven packages is premature | 15.1 |
| 4.2 | Shared types create hidden coupling | packages/shared |
| 5.1 | SQLite single-writer bottleneck on constrained devices | 8.1 |
| 6.1 | Job state machine has missing transitions | 5.1.2 |
| 6.2 | Replan loop has no bound for Gear failures | 4.5 |
| 6.3 | Error propagation across message bus unspecified | 9.1 |
| 7.2 | Sentinel can be starved via rate limit exhaustion | 5.3.6-5.3.7 |
| 7.3 | Sentinel Memory scope matching is a security surface | 5.3.8 |
| 8.1 | No startup/lifecycle model | 10 |
| 8.2 | No Gear API versioning | 9.3 |
| 8.3 | No strategy for long-running tasks | 5.1 |
| 10.1 | Document is specification, not architecture (missing tradeoff analysis) | Throughout |

### Minor Issues (Track for Later)

| # | Issue | Section |
|---|-------|---------|
| 7.1 | Fast-path selection semantics need explicit documentation | 4.3 |
| 2.2 | Adaptive model selection is premature | 5.2.5 |
| 5.2 | sqlite-vec brute-force scan scalability | 5.4.5 |
| 5.3 | LLM API rate limit coordination missing | 11.2 |
| 8.4 | No idempotency mechanism | 9.2 |
| 8.5 | No LLM decision quality observability | 12.2 |
| 9.1 | pkg single-binary strategy is fragile | 10.2 |
| 9.2 | Docker master key source file lifecycle should be documented | 10.3 |
| 10.2 | Naming theme obscures code communication | 1 |

---

## Final Verdict

This architecture is ambitious, thoughtful, and well on its way to being implementable. The security thinking is genuinely above average for this class of project. The dual-LLM trust boundary is a real innovation worth pursuing. The lessons-from-OpenClaw section demonstrates a mature approach to competitive analysis.

But the document needs a ruthless editing pass that separates "things we need for v1" from "things we think we will need eventually." The Gear Synthesizer, adaptive model selection, TOTP support, Prometheus metrics, WCAG compliance, agent-to-agent communication, and proactive behavior should all be explicitly deferred to post-v1 milestones.

The two critical issues -- message bus semantics and Gear Synthesizer scope -- should be resolved before any code is written. The fast-path concern (Section 7.1) is structurally mitigated by the architecture's design (fast path produces text only, no Gear execution), though the path selection mechanism should be documented more explicitly. Everything else can be addressed iteratively during implementation.

Build the simplest version that demonstrates the core value proposition: user sends message, Scout plans, Sentinel validates, Gear executes, user sees result. Get that loop working end to end. Then add the learning, the memory, the Gear synthesis, and the rest. The architecture supports incremental delivery -- lean into that.
