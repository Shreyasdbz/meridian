# Architecture Patches: Senior Software Architect Review

> **Source**: `docs/critics/software-architect.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-09

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > Major > Minor) then by section number.

---

## Patch 1: Specify Message Bus Semantics

**Severity**: Critical
**Review Finding**: #1.1 — The Message Bus Is the Architecture, and It Does Not Exist Yet
**Target Section**: 4.2 (Component Interaction Model), 9.1 (Internal API)

### Rationale

The entire architecture rests on Axis as a message router, but the document never specifies how routing actually works, how replies are correlated, how components register, or what the delivery guarantees are. Without concrete semantics, each component will make incompatible assumptions about inter-component communication. The reviewer correctly identifies that the core components share a single Node.js process and a typed function dispatch with middleware would be simpler, more honest, and sufficient.

### Changes

**4.2 — Add a new subsection after the existing interaction diagram:**

```markdown
#### 4.2.1 Message Bus Implementation

Meridian's "message passing through Axis" has two distinct implementations reflecting the
two-tier process model (see 4.2.2):

**Core component communication (in-process):** Scout, Sentinel, Journal, and Bridge run
within the same Node.js process as Axis. Their communication is implemented as typed
function dispatch with a middleware chain, not a literal message queue:

1. Each core component registers a message handler with Axis at startup.
2. When Axis needs to route a message, it calls the handler directly as an async function.
3. A middleware chain wraps every dispatch, providing: message signing/verification, audit
   logging, error handling, and latency tracking.
4. Replies use a request-reply pattern with correlation IDs. When Axis dispatches a message
   to Scout and needs the plan back, Scout's handler returns the plan as a resolved Promise.
   Axis assigns a `correlationId` to each dispatch and includes it in the response.
5. Timeouts are enforced per-dispatch via `AbortSignal`. If a component does not respond
   within the configured timeout (default: 30 seconds for Sentinel validation, 120 seconds
   for Scout planning), the dispatch fails with a timeout error.

This is architecturally equivalent to message passing — every interaction is logged, every
handler is replaceable with a mock, and the middleware chain provides the same cross-cutting
concerns. But it avoids the complexity of an in-process message queue where none is needed.

**Gear communication (cross-process):** Gear runs in separate child processes or Docker
containers (see 5.6.3). Gear communication uses actual IPC:

1. Axis spawns the Gear process and communicates via structured JSON messages over stdin/
   stdout (child process) or a Unix domain socket (container).
2. Messages follow the `AxisMessage` format with full signing and verification, because the
   process boundary is a real trust boundary.
3. Delivery is at-most-once. If the Gear process crashes, Axis detects the exit and marks
   the step as failed. Retries are managed by Axis at the job level, not the message level.

**Ordering guarantees:** For core components, message ordering is trivially guaranteed by
the synchronous dispatch within the event loop. For Gear, messages to a single Gear process
are ordered (serial writes to the IPC channel), but messages to different Gear processes may
be interleaved.

**Component registration:** Core components register their handlers during the startup
sequence (see 10.6). Gear "registers" implicitly when Axis reads the Gear registry table
and loads manifest metadata. Axis does not discover components dynamically — the set of
core components is fixed.
```

**9.1 — Amend the AxisMessage interface and surrounding text:**

Current:
> Components communicate through Axis using typed messages:

Proposed:
> Core components communicate through Axis using typed function dispatch with middleware
> (see 4.2.1). Gear communicates through IPC using the following message format. The
> `AxisMessage` type is also used as the internal representation for audit logging and
> observability of core component interactions, even though core dispatch is function-based:

Add `correlationId` and `timestamp` to required fields:

```typescript
interface AxisMessage {
  // --- Required (Axis needs these for routing and verification) ---
  id: string;                    // UUID v7 (unique, time-sortable)
  correlationId?: string;        // UUID v7 — set by Axis on request, echoed on reply
  timestamp: string;             // ISO 8601 — included in signed content
  from: ComponentId;             // Sender
  to: ComponentId;               // Recipient
  type: string;                  // Message type (e.g., 'plan.request', 'plan.response',
                                 //   'validate.request', 'validate.response', 'gear.execute',
                                 //   'gear.result', 'error')
  signature: string;             // Ed25519 signature (see 6.3)

  // --- Free-form (components include whatever is relevant) ---
  [key: string]: unknown;       // payload, replyTo, metadata, etc.
}
```

---

## Patch 2: Scope Down Gear Synthesizer for V1

**Severity**: Critical
**Review Finding**: #2.1 — Gear Synthesizer: Ambitious to the Point of Fantasy
**Target Section**: 5.4.3 (Reflection & Gear Building Pipeline), 5.4.4 (The Gear Improvement Loop)

### Rationale

The Gear Synthesizer proposes that Journal autonomously writes working plugin code with correct manifests, dependencies, error handling, and sandbox compliance — from a reflection on a failed task. This is a research problem, not an implementation detail. The document gives it roughly the same specification depth as backup rotation. The reviewer recommends scoping v1 to a "suggested Gear template" system and deferring autonomous code generation.

### Changes

**5.4.3 — Retitle and replace the Gear Synthesizer box in the diagram:**

Current title: "Reflection & Gear Building Pipeline"

Proposed title: "Reflection & Gear Suggestion Pipeline"

Replace the Gear Synthesizer box in the ASCII diagram:

Current:
```
┌─────────────────┐
│  Gear Synthesizer│
│                  │ Evaluates whether to:
│  - Create new Gear
│  - Refine existing Gear
│  - Do nothing (one-off task)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Gear lands in    │
│ workspace/gear/  │
│ as draft, flagged│
│ for user review  │
└─────────────────┘
```

Proposed:
```
┌──────────────────┐
│  Gear Suggester   │
│                   │  Evaluates whether to:
│  - Suggest a new Gear (template + manifest)
│  - Suggest improvements to existing Gear
│  - Do nothing (one-off task)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Suggestion lands  │
│ in workspace/gear/│
│ suggestions/ as a │
│ structured brief  │
│ for user review   │
└──────────────────┘
```

**5.4.3 — Replace "When does Journal create a Gear?" with:**

```markdown
**V1: Gear Suggestion (not autonomous creation)**

In v1, Journal does not autonomously write Gear code. Instead, the Gear Suggester produces
a **structured Gear brief** — a description of what a Gear should do, along with a skeleton
manifest and pseudocode:

- **Gear brief**: A structured document describing: the problem observed, the proposed
  solution, example inputs/outputs, and a suggested manifest with permissions.
- **Skeleton manifest**: A valid `GearManifest` with declared actions, parameters (JSON
  Schema), permissions, and resource limits — but no executable code.
- **Pseudocode**: A human-readable description of the Gear's logic, referencing the
  `GearContext` API, suitable for a developer (or a dedicated code-generation workflow) to
  implement.

The brief is stored in `workspace/gear/suggestions/` and the user is notified via Bridge.
The user can then:
- Implement the Gear manually using the brief as a specification.
- Use a separate code-generation tool/workflow to write the Gear from the brief.
- Dismiss the suggestion (Journal records the dismissal to avoid re-suggesting).

**Why not autonomous code generation in v1?**

Autonomous Gear creation requires solving several unsolved-at-scale problems:
1. Knowing which npm packages are available and safe to use.
2. Testing synthesized code (the document specifies no testing mechanism for generated Gear).
3. Handling Gear that passes sandbox validation but produces incorrect results.
4. Learning from user rejections to improve future synthesis.
5. Managing dependencies and cross-platform compatibility (especially ARM64).

These are solvable problems but they are research-grade, not implementation details. V1
ships the suggestion pipeline, which captures 80% of the value (identifying patterns and
specifying Gear) without the risk of generating broken or subtly wrong code.

**V2+: Autonomous Gear Creation**

Once the system has real-world data on what Gear users actually need, and the suggestion
pipeline has been validated, the Gear Suggester can be upgraded to a full Gear Synthesizer
that generates executable code. Prerequisites for this upgrade:
- An automated test harness for synthesized Gear (sandbox execution with known inputs).
- A feedback loop from user rejections/edits that influences future synthesis.
- A curated allowlist of safe npm dependencies.
- Demonstrated reliability of the suggestion pipeline (>70% of suggestions are useful).
```

**5.4.3 — Replace "When does Journal NOT create a Gear?" with:**

```markdown
**When does Journal suggest a Gear?**

- A task required multi-step manual orchestration that could be automated (e.g., "fetch RSS
  feed, filter articles, summarize top 5" -> suggest an `rss-digest` Gear).
- A task failed because no existing Gear could handle it, but Journal can see a pattern for
  how to solve it.
- The user explicitly says "remember how to do this" or "make this a recurring capability."
- An existing Gear failed repeatedly and Journal can identify the fix (suggests a patch).

**When does Journal NOT suggest a Gear?**

- One-off tasks unlikely to recur.
- Tasks already well-handled by existing Gear.
- Simple information retrieval (web search, file listing, etc.).
```

**5.4.4 — Amend the improvement loop diagram:**

Replace the Journal reflection branch for success:

Current:
```
       ├── Update procedural memory
       └── Optionally improve Gear (efficiency, edge cases)
```

Proposed:
```
       ├── Update procedural memory
       └── Optionally suggest Gear improvement (v1: structured brief only)
```

Replace the Journal reflection branch for failure:

Current:
```
       ├── Can the Gear be fixed?
       ├── Should a new Gear be created?
```

Proposed:
```
       ├── Can the Gear be fixed? (v1: suggest fix, not auto-fix)
       ├── Should a new Gear be suggested?
```

**Throughout 5.4.3–5.4.4 and 5.6 — Rename references:**

Replace "Gear Synthesizer" with "Gear Suggester" throughout these sections. Update the
component diagram in 4.1 similarly (the box labeled "Gear Synthesizer" becomes "Gear
Suggester").

---

## Patch 3: Acknowledge Hybrid Process Model

**Severity**: Major
**Review Finding**: #1.2 — Hybrid Process Model Is Under-Acknowledged
**Target Section**: 4.2 (Component Interaction Model)

### Rationale

The architecture describes components as if they are all separate services communicating through signed messages, but core components share a single Node.js process while only Gear runs in separate processes/containers. This distinction affects the value of signing (within a process, the signing key is shared and provides no protection against a compromised component), fault isolation (an unhandled exception in Scout crashes Sentinel too), and testability (achievable with DI, not requiring a message bus).

### Changes

**4.2 — Add a new subsection:**

```markdown
#### 4.2.2 Process Model

Meridian has a two-tier process model:

**Tier 1: Core process (single Node.js process)**

Axis, Scout, Sentinel, Journal, and Bridge's API server all run within a single Node.js
process. This means:

- **Shared memory**: All core components share the same V8 heap. There is no memory
  isolation between them.
- **Shared failure domain**: An unhandled exception in any core component's code path
  will crash the entire process. Error boundaries (try/catch at handler boundaries) mitigate
  this, but do not eliminate the risk. Process-level monitoring (Section 5.1.5 — Watchdog)
  detects and restarts after crashes.
- **Message signing within the process**: The Ed25519 signing of messages between core
  components (see 6.3) provides authenticity verification for audit logging and protocol
  correctness, but does not provide security isolation — if an attacker achieves code
  execution in the main process, they have access to all signing keys. The signing is
  meaningful for the Gear boundary (Tier 2).

This model is appropriate for a single-user, resource-constrained deployment. Splitting
core components into separate processes would multiply memory usage (each Node.js process
consumes ~50-80 MB baseline) and add IPC latency — unacceptable on a Raspberry Pi with
4 GB RAM.

**Tier 2: Gear processes (separate child processes or containers)**

Each Gear execution runs in a separate child process or Docker container (see 5.6.3). This
is a real security boundary:

- **Memory isolation**: Gear cannot read the core process's memory.
- **Privilege isolation**: Gear processes run with dropped privileges, restricted syscalls,
  and limited filesystem/network access.
- **Crash isolation**: A Gear crash does not affect the core process or other Gear.
- **Message signing is meaningful**: Gear does not hold the core components' signing keys.
  A compromised Gear cannot forge messages from Scout, Sentinel, or any other core component.

**Future consideration**: If Meridian scales to multi-user (Section 16.1) or higher-
throughput deployments, the core process can be split along existing component boundaries.
The typed function dispatch layer (see 4.2.1) can be replaced with IPC or HTTP without
changing component logic, because all inter-component communication already flows through
Axis's dispatch interface.
```

**4.2 — Amend the third guarantee in the existing list:**

Current:
> 3. **Testability**: Any component can be replaced with a mock.

Proposed:
> 3. **Testability**: Any component can be replaced with a mock via dependency injection
>    at the Axis dispatch layer.

---

## Patch 4: Narrow Sentinel's Documented Validation Scope

**Severity**: Major
**Review Finding**: #1.3 — Sentinel Information Barrier Under Stress
**Target Section**: 5.3.2 (Validation Categories)

### Rationale

The Sentinel information barrier prevents Sentinel from seeing the user's original message. This means Sentinel cannot evaluate the ethical or legal context of most plans — file deletion is file deletion; the ethical dimension comes from *why*. The document should be honest that Sentinel is primarily a *technical safety* validator.

### Changes

**5.3.2 — Replace the validation categories list:**

Current:
> 1. **Security**: Does this step create attack vectors? ...
> 2. **Privacy**: Does this step access or transmit personal data? ...
> 3. **Financial**: Does this step incur costs? ...
> 4. **Ethical**: Does this step involve deception, manipulation, or harm? ...
> 5. **Legal**: Does this step potentially violate laws? ...

Proposed:
```markdown
Sentinel evaluates each plan step against the following categories. These are ordered by
Sentinel's ability to assess them given the information barrier:

**Categories Sentinel can fully assess (no original message context needed):**

1. **Security**: Does this step create attack vectors? Does it expose credentials? Does it
   grant excessive permissions? Does it access resources beyond declared Gear permissions?
2. **Privacy**: Does this step access or transmit personal data? Is the data handling
   proportionate to the declared action? Does it send data to undeclared external services?
3. **Financial**: Does this step incur costs (API calls, purchases, subscriptions)? Is the
   cost proportionate? Does it exceed configured limits?
4. **Policy compliance**: Does this step violate any of the user's configured policies
   (Section 5.3.5 — Default Risk Policies)?
5. **Composite risk**: Do the steps in combination create risks that individual steps do
   not? (e.g., "read credentials file" + "make external network request" = potential
   exfiltration.)

**Categories Sentinel can partially assess (limited by information barrier):**

6. **Ethical**: Sentinel can detect structurally unethical patterns (bulk data deletion,
   mass messaging, accessing another person's private data) but **cannot** assess the user's
   intent or emotional context. A file deletion is evaluated on its technical properties
   (path, scope, reversibility), not on whether the user's motivation is appropriate.
   Full ethical review would require context that the information barrier deliberately
   withholds.
7. **Legal**: Sentinel can flag patterns that commonly have legal implications (accessing
   systems without declared authorization, bulk downloading copyrighted content, sending
   unsolicited messages at scale) but **cannot** determine whether the user has authorization
   or legal standing for a specific action. Legal compliance ultimately rests with the user.

**Acknowledged limitation:** The information barrier is a deliberate tradeoff. It protects
against prompt injection propagation (see 5.3.1) at the cost of reducing Sentinel's ability
to evaluate context-dependent risks. This is the correct tradeoff — a Sentinel that can be
manipulated by a prompt-injected Scout is worse than a Sentinel with limited ethical
reasoning.
```

---

## Patch 5: Specify Gear Dependency Management

**Severity**: Major
**Review Finding**: #2.3 — Under-Specified: Gear Dependency Management
**Target Section**: 5.6.2 (Gear Manifest), 5.6.4 (Gear Lifecycle)

### Rationale

The `GearManifest` declares permissions and resources but says nothing about code dependencies. Real plugins need npm packages, and on ARM64 (Raspberry Pi), native module compilation is notoriously painful. The document must specify how Gear declares, installs, and isolates dependencies.

### Changes

**5.6.2 — Add a `dependencies` section to `GearManifest`:**

After the `resources` field in the interface:

```typescript
  // Dependencies
  dependencies?: {
    npm?: Record<string, string>;     // Package name -> semver range (e.g., {"sharp": "^0.33"})
    native?: boolean;                  // true if any dependency requires native compilation
    platforms?: string[];              // Supported platforms (e.g., ["linux-arm64", "darwin-arm64",
                                       //   "linux-x64", "darwin-x64"]). If omitted, assumed
                                       //   platform-independent (pure JS).
  };
```

**5.6.4 — Add dependency installation to the Gear lifecycle:**

After "Check manifest / Verify signature / Scan for known vulnerabilities":

```markdown
**Dependency installation:**

1. Gear declares its npm dependencies in the manifest's `dependencies.npm` field.
2. At install time, Axis creates an isolated `node_modules` directory for the Gear (at
   `data/gear/<gear-id>/node_modules/`). Dependencies are installed into this directory
   using `npm install --production --ignore-scripts` (install scripts are blocked by
   default to prevent supply chain attacks).
3. If the Gear declares `dependencies.native: true`, Axis verifies that the current platform
   matches one of the declared `platforms`. If not, installation fails with a clear error
   message (e.g., "Gear 'image-resizer' requires native modules for linux-arm64 but this
   system is darwin-arm64").
4. Native dependencies that require install scripts must be explicitly allowlisted in the
   Gear manifest. Axis prompts the user for approval before running any install scripts,
   displaying the exact scripts that will execute.
5. The sandbox mounts the Gear's `node_modules` directory as read-only. Gear code can
   `require()` its declared dependencies but cannot modify them.
6. Dependency conflicts between Gear are impossible because each Gear has its own isolated
   `node_modules`.
7. Dependencies are audited at install time using `npm audit`. Known vulnerabilities are
   reported to the user with severity levels. Critical vulnerabilities block installation
   by default (configurable).
```

---

## Patch 6: Add Conversation Threading Model

**Severity**: Major
**Review Finding**: #2.4 — Conversation Threading and Multi-Turn Context
**Target Section**: 8.3 (Schema Overview — Core Database)

### Rationale

The architecture never defines what a "conversation" is. Messages are linked to individual jobs, but multi-turn conversations span multiple jobs. When the user says "do that again but with the other file," Scout needs conversation context. When a background job completes and the user has moved on, the notification needs to reference the originating conversation.

### Changes

**8.3 — Add a `conversations` table to the Core Database schema:**

Before the `messages` table:

```sql
-- Conversations (logical sessions grouping messages and jobs)
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,             -- UUID v7
  title TEXT,                      -- Auto-generated or user-set title
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'archived'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

**8.3 — Amend the `messages` table:**

Add a `conversation_id` column:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  job_id TEXT REFERENCES jobs(id),
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  modality TEXT DEFAULT 'text',
  attachments_json TEXT,
  created_at TEXT NOT NULL
);
```

**8.3 — Amend the `jobs` table:**

Add a `conversation_id` column:

```sql
  conversation_id TEXT REFERENCES conversations(id),
```

(Add after `parent_id TEXT REFERENCES jobs(id),`)

**5.2.3 — Add clarifying text about conversation context:**

After "Last N messages from the current conversation (configurable, default: 20)":

```markdown
A **conversation** is a logical session (see data model, Section 8.3). Conversations group
related messages and jobs. A new conversation starts when:

- The user explicitly starts a new conversation in Bridge.
- The previous conversation has been inactive for a configurable period (default: 30
  minutes).

Jobs are linked to their originating conversation. When a background job completes, the
result notification is delivered in the context of the originating conversation, even if the
user has started a new one. Bridge displays a link to the original conversation context.

Multi-turn context within a conversation (anaphoric references like "do that again,"
"use the other file") is resolved by Scout using the conversation's recent message history.
Scout's context window includes the last N messages from the current conversation, providing
the continuity needed for natural multi-turn interaction.
```

---

## Patch 7: Refine Loose Schema to Typed Interfaces with Metadata Bag

**Severity**: Major
**Review Finding**: #3.1 — `[key: string]: unknown` Will Cause Debugging Nightmares
**Target Section**: 5.1.2 (Job Model), 5.2.2 (Execution Plan Format), 5.3.3 (Validation Response), 5.3.8 (Sentinel Decision), 5.4.5 (Memory Query/Result), throughout

### Rationale

The loose schema pattern (`[key: string]: unknown` on every interface) destroys TypeScript's type safety, autocompletion, and refactoring support. The reviewer's recommended approach: define concrete interfaces with optional fields for all *known* properties, and use a single `metadata: Record<string, unknown>` field for genuinely ad-hoc content. This preserves extensibility while recovering 90% of type safety.

### Changes

**5.2.2 — Replace the ExecutionPlan and ExecutionStep interfaces:**

Current:
```typescript
interface ExecutionPlan {
  id: string;
  jobId: string;
  steps: ExecutionStep[];
  [key: string]: unknown;
}

interface ExecutionStep {
  id: string;
  gear: string;
  action: string;
  parameters: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  [key: string]: unknown;
}
```

Proposed:
```typescript
interface ExecutionPlan {
  // --- Required (Axis needs these to route and execute) ---
  id: string;
  jobId: string;
  steps: ExecutionStep[];

  // --- Typed optional (Scout fills these when relevant) ---
  reasoning?: string;                // Scout's explanation of its planning logic
  estimatedDuration?: number;        // Estimated execution time in ms
  estimatedTokenCost?: number;       // Estimated total token usage
  journalSkip?: boolean;             // Skip Journal reflection after execution
  context?: string;                  // Summary of context Scout used for planning

  // --- Free-form (for genuinely ad-hoc LLM additions) ---
  metadata?: Record<string, unknown>;
}

interface ExecutionStep {
  // --- Required (Axis needs these to dispatch to Gear) ---
  id: string;
  gear: string;                      // Gear identifier
  action: string;                    // Specific action within the Gear
  parameters: Record<string, unknown>;

  // --- Required (Sentinel needs these for validation) ---
  riskLevel: 'low' | 'medium' | 'high' | 'critical';

  // --- Typed optional (Scout fills these when relevant) ---
  description?: string;              // Human-readable step description
  order?: number;                    // Execution order (steps with same order run in parallel)
  parallelGroup?: string;            // Group ID for parallel execution
  dependsOn?: string[];              // Step IDs that must complete before this step
  rollback?: string;                 // Description of how to undo this step
  condition?: string;                // Condition for conditional execution

  // --- Free-form (for genuinely ad-hoc LLM additions) ---
  metadata?: Record<string, unknown>;
}
```

**5.2.2 — Replace the paragraph about Scout's freedom:**

Current:
> Scout is instructed to include fields like `reasoning`, `description`, `parallelGroup`,
> `order`, and `rollback` when relevant, but these are not enforced by the schema. This
> allows Scout's output format to evolve without requiring schema migrations...

Proposed:
> Scout's commonly-used fields (`reasoning`, `description`, `parallelGroup`, `order`,
> `rollback`, etc.) are defined as typed optional properties, giving developers autocomplete,
> type checking, and refactoring safety. The `metadata` field on each interface provides an
> escape hatch for genuinely ad-hoc content that has not yet been promoted to a typed field.
>
> **Schema evolution**: When a `metadata` field proves consistently useful, it is promoted
> to a typed optional field in the next version. This gives the system the flexibility of
> free-form output with the long-term maintainability of typed interfaces.

**5.1.2 — Replace the Job interface:**

Current:
```typescript
interface Job {
  id: string;
  status: 'pending' | 'planning' | ...;
  createdAt: string;
  [key: string]: unknown;
}
```

Proposed:
```typescript
interface Job {
  // --- Required (Axis needs these for lifecycle management) ---
  id: string;                        // UUID v7 (time-sortable)
  conversationId: string;            // Owning conversation
  status: JobStatus;                 // See job state machine (5.1.2.1)
  createdAt: string;                 // ISO 8601
  updatedAt: string;                 // ISO 8601

  // --- Typed optional (populated over the job's lifecycle) ---
  parentId?: string;                 // Parent job ID for sub-jobs
  priority?: 'low' | 'normal' | 'high' | 'critical';
  sourceType?: string;               // 'user' | 'scheduled' | 'event' | 'sub-job'
  sourceMessageId?: string;          // Originating message ID
  plan?: ExecutionPlan;              // Scout's plan (set during 'planning')
  validation?: ValidationResult;     // Sentinel's result (set during 'validating')
  result?: Record<string, unknown>;  // Execution result (set on completion)
  error?: JobError;                  // Error details (set on failure)
  attempts?: number;                 // Execution attempt count
  maxAttempts?: number;              // Max retries (default: 3)
  timeoutMs?: number;                // Job-level timeout (default: 300000)
  completedAt?: string;              // ISO 8601

  // --- Free-form (for ad-hoc extensions) ---
  metadata?: Record<string, unknown>;
}

type JobStatus = 'pending' | 'planning' | 'validating' | 'awaiting_approval'
               | 'executing' | 'completed' | 'failed' | 'cancelled';
```

**5.3.3 — Apply the same pattern to ValidationResult and StepValidation:**

```typescript
interface ValidationResult {
  // --- Required ---
  id: string;
  planId: string;
  verdict: 'approved' | 'rejected' | 'needs_user_approval' | 'needs_revision';
  stepResults: StepValidation[];

  // --- Typed optional ---
  overallRisk?: 'low' | 'medium' | 'high' | 'critical';
  reasoning?: string;
  suggestedRevisions?: string[];
  compositeRiskAnalysis?: string;    // Analysis of combined step effects

  // --- Free-form ---
  metadata?: Record<string, unknown>;
}

interface StepValidation {
  // --- Required ---
  stepId: string;
  verdict: 'approved' | 'rejected' | 'needs_user_approval';

  // --- Typed optional ---
  category?: string;                 // Which validation category triggered the verdict
  risk?: 'low' | 'medium' | 'high' | 'critical';
  reasoning?: string;

  // --- Free-form ---
  metadata?: Record<string, unknown>;
}
```

**5.3.8 — Apply the same pattern to SentinelDecision:**

```typescript
interface SentinelDecision {
  // --- Required ---
  id: string;
  actionType: string;
  scope: string;
  verdict: 'allow' | 'deny';

  // --- Typed optional ---
  timestamp?: string;
  conditions?: string;
  expiresAt?: string;
  notes?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';

  // --- Free-form ---
  metadata?: Record<string, unknown>;
}
```

**5.4.5 — Apply the same pattern to MemoryQuery and MemoryResult:**

```typescript
interface MemoryQuery {
  // --- Required ---
  text: string;

  // --- Typed optional ---
  types?: ('episodic' | 'semantic' | 'procedural')[];
  maxResults?: number;
  minRelevance?: number;
  timeRange?: { from?: string; to?: string };

  // --- Free-form ---
  metadata?: Record<string, unknown>;
}

interface MemoryResult {
  // --- Required ---
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  content: string;
  relevanceScore: number;

  // --- Typed optional ---
  createdAt?: string;
  updatedAt?: string;
  source?: string;
  linkedGearId?: string;

  // --- Free-form ---
  metadata?: Record<string, unknown>;
}
```

**Architecture Patterns section (CLAUDE.md) — Update the loose schema description:**

Current:
> **Loose schema principle**: Interfaces have a small set of required fields for
> routing/execution, plus `[key: string]: unknown` for free-form LLM-generated content.

Proposed:
> **Typed-with-metadata principle**: Interfaces have required fields for routing/execution,
> typed optional fields for commonly-used properties, and a `metadata?: Record<string,
> unknown>` field for genuinely ad-hoc LLM content. This preserves extensibility while
> providing type safety, autocomplete, and refactoring support for 90% of fields.

---

## Patch 8: Type WSMessage as Discriminated Union

**Severity**: Major
**Review Finding**: #3.2 — WSMessage Is Dangerously Untyped
**Target Section**: 5.5.4 (Real-Time Streaming)

### Rationale

The `WSMessage` interface has only one required field (`type: string`). Every field access in the frontend will require type guards or unsafe casts. TypeScript's discriminated unions are purpose-built for this pattern.

### Changes

**5.5.4 — Replace the WSMessage interface:**

Current:
```typescript
interface WSMessage {
  type: string;
  jobId?: string;
  [key: string]: unknown;
}
```

Proposed:
```typescript
type WSMessage =
  | { type: 'chunk'; jobId: string; content: string; done: boolean }
  | { type: 'status'; jobId: string; status: JobStatus; message?: string }
  | { type: 'approval_required'; jobId: string; plan: ExecutionPlan;
      reason: string; stepResults: StepValidation[] }
  | { type: 'result'; jobId: string; result: Record<string, unknown> }
  | { type: 'error'; jobId: string; error: { code: string; message: string;
      details?: Record<string, unknown> } }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string;
      jobId?: string }
  | { type: 'progress'; jobId: string; stepId: string; percent: number;
      message?: string }
  | { type: 'connected'; sessionId: string }
  | { type: 'ping' }
  | { type: 'pong' };
```

**5.5.4 — Replace the explanatory paragraph:**

Current:
> WebSocket messages follow the same loose-schema principle. Only `type` is required;
> everything else is type-dependent free-form content.

Proposed:
> WebSocket messages use a TypeScript discriminated union. Each message type has a fully
> typed payload, giving the frontend compile-time guarantees about available fields. New
> message types can be added to the union as the system evolves. The frontend's message
> handler can use a `switch` on `message.type` with exhaustiveness checking to ensure all
> message types are handled.

---

## Patch 9: Recommend Single Package for V1

**Severity**: Major
**Review Finding**: #4.1 — Seven Packages Is Premature for a Single-Developer Project
**Target Section**: 15.1 (Code Organization)

### Rationale

Seven packages means seven `package.json`, seven `tsconfig.json`, seven build configs, cross-package dependency resolution with npm workspaces (finicky), and slower builds. The componentization is architecturally sound but package boundaries are an implementation concern. Clean boundaries can be enforced with import rules within a single package.

### Changes

**15.1 — Replace the directory structure and introductory text:**

Current:
> Monorepo structure using npm workspaces. Each package is independently buildable and
> testable.

Proposed:
```markdown
**V1: Single-package structure with module boundaries**

For v1, Meridian uses a single TypeScript package with directory-based module boundaries.
This avoids the overhead of multi-package workspace management while maintaining clean
component separation:

```
meridian/
├── src/
│   ├── axis/                # Runtime & scheduler
│   │   ├── index.ts         # Public API (only file other modules import from)
│   │   ├── job-scheduler.ts
│   │   ├── message-router.ts
│   │   └── ...
│   ├── scout/               # Planner LLM
│   │   ├── index.ts
│   │   └── ...
│   ├── sentinel/            # Safety validator
│   │   ├── index.ts
│   │   └── ...
│   ├── journal/             # Memory system
│   │   ├── index.ts
│   │   └── ...
│   ├── bridge/              # User interface
│   │   ├── api/             # Backend API (Fastify)
│   │   ├── ui/              # Frontend SPA (React, separate Vite build)
│   │   └── index.ts
│   ├── gear/                # Plugin runtime
│   │   ├── builtin/         # Built-in Gear
│   │   └── index.ts
│   └── shared/              # Shared types and utilities
│       └── index.ts
├── tests/
│   ├── integration/
│   ├── security/
│   └── e2e/
├── docs/
├── scripts/
└── docker/
```

**Module boundary enforcement:** Component boundaries are enforced by ESLint's
`no-restricted-imports` rule (or `dependency-cruiser`). The rules ensure:

- `sentinel/` does not import from `journal/` (information barrier)
- `axis/` does not import from LLM provider SDKs (no LLM dependency)
- No module imports from another module's internal files — only from its `index.ts`
- `shared/` does not import from any other module

Each module's `index.ts` serves as its public API, equivalent to a package's entry point.

**When to split into packages:** The codebase should be split into npm workspace packages
when a concrete need arises:

- Publishing `@meridian/gear` as a standalone SDK for plugin authors.
- Publishing `@meridian/shared` as a types package for external consumers.
- Independent deployment of Bridge frontend vs. backend.
- Build times exceeding 30 seconds (incremental package builds become worthwhile).

The directory structure and import patterns are designed to make this split straightforward
when needed — each module is already self-contained with a defined public API.
```

---

## Patch 10: Minimize Shared Module Scope

**Severity**: Major
**Review Finding**: #4.2 — Hidden Coupling Through Shared Types
**Target Section**: 15.1 (Code Organization, in the context of shared/)

### Rationale

If every cross-cutting type lives in `shared/`, it becomes a God module where any change triggers a rebuild of everything. Types like `ExecutionPlan` embed domain knowledge that originated in Scout but are consumed by multiple components.

### Changes

**15.1 — Add after the module boundary enforcement rules:**

```markdown
**Shared module scope:**

The `shared/` module contains only truly universal primitives:

- ID types and generators (UUID v7)
- Date/time utilities
- Error base classes and the `Result<T, E>` type
- The `ComponentId` type
- The `AxisMessage` interface (the universal message envelope)
- Common constants (status enums, risk levels)
- JSON Schema validation utilities

Domain-specific types are defined by their **producer** and consumed by others:

| Type | Defined in | Consumed by |
|------|-----------|-------------|
| `ExecutionPlan`, `ExecutionStep` | `scout/` | `axis/`, `sentinel/`, `bridge/` |
| `ValidationResult`, `StepValidation` | `sentinel/` | `axis/`, `bridge/` |
| `GearManifest`, `GearAction`, `GearContext` | `gear/` | `axis/`, `scout/`, `bridge/` |
| `MemoryQuery`, `MemoryResult` | `journal/` | `scout/` |
| `Job`, `JobStatus` | `axis/` | `bridge/`, `scout/` |
| `SentinelDecision` | `sentinel/` | (internal only) |
| `AuditEntry` | `axis/` | `bridge/` (read-only) |

This keeps the dependency direction explicit: consumers depend on producers. When Scout
changes the `ExecutionPlan` format, the type change happens in `scout/types.ts`, and
TypeScript will flag every consumer that needs to update.
```

---

## Patch 11: Document SQLite Write Performance on Constrained Devices

**Severity**: Major
**Review Finding**: #5.1 — SQLite WAL Mode Is a Single-Writer Bottleneck
**Target Section**: 8.1 (Storage Technologies)

### Rationale

`better-sqlite3` is synchronous, so writes block the event loop. On a Raspberry Pi with an SD card (1-10ms per write), frequent writes could cause perceptible stalls under moderate load. The reviewer notes this is acceptable for v1 but should be monitored.

### Changes

**8.1 — Add after the "WAL mode" bullet:**

```markdown
- **Write performance on constrained devices**: `better-sqlite3` is a synchronous driver —
  every write operation blocks the Node.js event loop until the disk I/O completes. On a
  Raspberry Pi with an SD card (random write latency: 1-10ms), frequent writes to
  `meridian.db` (job status updates, message inserts) could cause perceptible event loop
  stalls under moderate load (3-4 concurrent jobs). Mitigations for v1:
  - Monitor event loop latency as a key performance metric (see Section 12.2).
  - Batch job status updates where possible (accumulate status changes and flush every
    100ms rather than writing on every state transition).
  - Recommend SSD over SD card for production Raspberry Pi deployments.
  - If event loop stalls exceed 50ms consistently, the write path can be offloaded to a
    worker thread using Node.js `worker_threads` in a future version.
- **Multiple databases mitigate contention**: By splitting data across `meridian.db`,
  `journal.db`, `sentinel.db`, and `audit.db`, writes are distributed across separate files
  with separate WAL journals, reducing the per-database write frequency.
```

---

## Patch 12: Complete the Job State Machine

**Severity**: Major
**Review Finding**: #6.1 — The Job State Machine Has Missing Transitions
**Target Section**: 5.1.2 (Job Model)

### Rationale

The documented state machine is missing several transitions: `planning` -> `failed` (Scout API down), `validating` -> `failed` (Sentinel API down), `executing` -> `planning` (replan after Gear failure), `awaiting_approval` -> `planning` (user requests alternative approach), and `cancelled` from all states.

### Changes

**5.1.2 — Add a new subsection after the Job interface:**

```markdown
#### 5.1.2.1 Job State Machine

```
                                         ┌──────────────────────┐
                                         │                      │
                              ┌──────────┴──┐                   │
                    ┌────────►│  cancelled   │◄──────────────────┤
                    │         └─────────────┘                   │
                    │ cancel                          cancel    │
                    │                                           │
              ┌─────┴──┐   start   ┌──────────┐   plan ok  ┌───┴───────┐
  ─────────►  │ pending ├─────────►│ planning  ├───────────►│ validating│
              └─────┬──┘          └────┬───┬──┘            └───┬──┬────┘
                    │                  │   │                    │  │
                    │          fail/   │   │ replan      fail/  │  │
                    │          timeout │   │             timeout │  │
                    │                  ▼   │                    ▼  │
                    │         ┌────────┐   │           ┌────────┐  │
                    │         │ failed │   │           │ failed │  │
                    │         └────────┘   │           └────────┘  │
                    │                      │                       │
                    │                      │ replan (max 3)        │ approved
                    │                      │                       │
                    │              ┌───────┴───────┐               │
                    │              │  executing    │◄──────────────┘
                    │              └───┬───┬───┬───┘
                    │                  │   │   │
                    │         success  │   │   │ step fails
                    │                  │   │   │ (replan, max 3)
                    │                  ▼   │   │
                    │         ┌──────────┐ │   │     needs_user_approval
                    │         │completed │ │   │            │
                    │         └──────────┘ │   └────────────┼─────────────┐
                    │                      │                │             │
                    │              fail/   │   ┌────────────▼──────────┐  │
                    │              timeout │   │  awaiting_approval    │  │
                    │                      ▼   └───────┬──────┬───────┘  │
                    │                 ┌────────┐       │      │          │
                    │                 │ failed │  approve  reject/       │
                    │                 └────────┘       │   revise        │
                    │                                  │      │          │
                    │                                  │      └──► (back to planning
                    │                                  │           for revision, or
                    │                                  │           cancelled if rejected)
                    │                                  │
                    │                                  └──► (back to executing)
                    │
                    └──► cancel from any active state
```

**Valid transitions:**

| From | To | Trigger |
|------|----|---------|
| `pending` | `planning` | Worker picks up the job |
| `pending` | `cancelled` | User cancels before processing starts |
| `planning` | `validating` | Scout produces a valid plan |
| `planning` | `failed` | Scout API unreachable after retries, or max planning timeout |
| `planning` | `cancelled` | User cancels |
| `validating` | `executing` | Sentinel approves (no user approval needed) |
| `validating` | `awaiting_approval` | Sentinel returns `needs_user_approval` |
| `validating` | `planning` | Sentinel returns `needs_revision` (max 3 revision cycles) |
| `validating` | `failed` | Sentinel rejects, or Sentinel API unreachable after retries |
| `validating` | `cancelled` | User cancels |
| `awaiting_approval` | `executing` | User approves |
| `awaiting_approval` | `planning` | User requests revision ("try a different approach") |
| `awaiting_approval` | `cancelled` | User rejects / cancels |
| `executing` | `completed` | All steps complete successfully |
| `executing` | `failed` | Step fails and max replans (3) exceeded, or job timeout |
| `executing` | `planning` | Step fails, Scout replans (max 3 replans per job) |
| `executing` | `cancelled` | User cancels (running steps are aborted) |

**Bounds:** The revision cycle (validating -> planning -> validating) is capped at 3
iterations. The replan cycle (executing -> planning -> ... -> executing) is capped at 3
iterations. These are independent counters. A single job can have at most 3 revisions + 3
replans = 6 total re-planning events before it must either complete or fail.
```

---

## Patch 13: Bound the Gear Failure Replan Loop

**Severity**: Major
**Review Finding**: #6.2 — Replan Loop Has Unbounded Potential
**Target Section**: 4.5 (Data Flow — step 9)

### Rationale

The Sentinel revision loop is capped at 3 iterations, but the Gear failure replan loop has no stated limit. Without a cap, this loop burns API tokens indefinitely.

### Changes

**4.5 — Amend step 9:**

Current:
> 9. **Result Collection**: Gear returns results to Axis. If a step fails, Axis routes back
> to Scout for replanning using a potentially different approach or Gear.

Proposed:
> 9. **Result Collection**: Gear returns results to Axis. If a step fails, Axis routes back
> to Scout for replanning using a potentially different approach or Gear. **Replan limit**:
> A single job may be replanned at most 3 times after Gear execution failures (independent
> of the 3-iteration Sentinel revision cap). After the maximum, the job fails with a
> "maximum replan attempts exceeded" error. The full history of attempts (plans, failures,
> replans) is preserved in the job record for debugging. Each replan attempt is logged in
> the audit trail.

---

## Patch 14: Define Error Propagation Protocol

**Severity**: Major
**Review Finding**: #6.3 — Error Propagation Across the Message Bus
**Target Section**: 9.1 (Internal API), 5.1 (Axis)

### Rationale

When a component fails while processing a message, the error propagation model is unspecified. There is no error message format, no universal error handler, and no defined behavior for cascading failures.

### Changes

**9.1 — Add after the AxisMessage interface:**

```markdown
#### 9.1.1 Error Propagation

Every component catches errors at its message handler boundary and returns a structured
error:

```typescript
interface ComponentError {
  code: string;                      // Machine-readable error code (e.g., 'SCOUT_PLAN_FAILED',
                                     //   'SENTINEL_API_TIMEOUT', 'GEAR_EXECUTION_FAILED')
  message: string;                   // Human-readable description
  component: ComponentId;            // Which component failed
  jobId?: string;                    // Associated job
  retryable: boolean;                // Whether Axis should retry the operation
  details?: Record<string, unknown>; // Additional context (sanitized — no secrets)
}
```

**Error handling flow:**

1. A component's message handler throws or returns an error.
2. The Axis dispatch middleware catches the error and wraps it in a `ComponentError`.
3. Axis updates the job's status based on the error:
   - If `retryable: true` and the job has remaining retry budget: re-queue the job.
   - If `retryable: false` or retry budget exhausted: set job to `failed`.
4. Axis logs the error in the audit trail (sensitive details redacted).
5. Axis sends an error notification to Bridge for the user.
6. If the error handler itself fails (e.g., database write error while updating job status):
   log to stderr as a last resort and set the job to `failed` on the next successful
   database write (crash recovery handles this case, see 5.1.5).

**Cascading failure prevention:** If a component fails repeatedly (5 errors in 60 seconds),
Axis enters a degraded mode for that component: new jobs that require the failing component
are queued (not dispatched) and the user is notified. The component is retried every 30
seconds until it recovers.
```

---

## Patch 15: Coordinate LLM Rate Limits Between Scout and Sentinel

**Severity**: Major
**Review Finding**: #7.2 — Sentinel Can Be Starved
**Target Section**: 5.3.7 (Cost Implications), 11.1 (LLM API Optimization)

### Rationale

If Scout and Sentinel use the same LLM provider, Scout traffic can exhaust the rate limit, preventing Sentinel from validating plans. This creates a denial-of-service condition where tasks queue indefinitely.

### Changes

**5.3.7 — Add after the "Local Sentinel" bullet:**

```markdown
- **Rate limit coordination**: When Scout and Sentinel share an LLM provider, Axis manages
  a shared rate limiter that reserves a portion of the rate limit budget for Sentinel. The
  default reservation is 30% of the provider's rate limit for Sentinel, ensuring that high
  Scout traffic cannot starve plan validation. If Sentinel's reserved capacity is unused,
  Scout can borrow it (but Sentinel can always preempt). This coordination is managed
  centrally by Axis — Scout and Sentinel do not call the LLM API directly but submit
  requests through Axis's rate-limited dispatch.
```

**5.3.6 — Amend the configuration recommendations:**

Current:
> - **High security**: Use a different provider entirely (e.g., Scout uses Anthropic,
>   Sentinel uses OpenAI).

Proposed:
> - **Recommended**: Use a different provider entirely (e.g., Scout uses Anthropic, Sentinel
>   uses OpenAI). This eliminates rate limit contention between Scout and Sentinel and
>   ensures that a single provider compromise does not affect both components.
> - **Same-provider warning**: If the same provider is configured for both Scout and
>   Sentinel, Bridge displays a persistent notice explaining the reduced security posture
>   and the rate limit contention risk. Axis automatically enables rate limit reservation
>   for Sentinel (see 5.3.7).

---

## Patch 16: Specify Sentinel Memory Scope Matching Semantics

**Severity**: Major
**Review Finding**: #7.3 — Sentinel Memory Scope Matching Is Under-Specified
**Target Section**: 5.3.8 (Sentinel Memory)

### Rationale

The scope matching logic — how Sentinel determines that a new action matches a stored decision — is not specified. Imprecise matching is a security vulnerability. An overly broad match could auto-approve unintended actions.

### Changes

**5.3.8 — Add after the "How Sentinel uses this memory" section:**

```markdown
**Scope matching semantics:**

Sentinel Memory uses a structured matching system, not arbitrary pattern matching:

1. **Action type matching**: Exact string match on `actionType` (e.g., `"file.delete"`
   matches `"file.delete"`, not `"file.delete.recursive"`).

2. **Scope matching by action category**:

   | Action Category | Scope Format | Matching Rule |
   |----------------|--------------|---------------|
   | File operations | Absolute path or path prefix ending in `/*` | Path is canonicalized (resolve `..`, normalize separators) before comparison. Prefix match only on directory boundaries (not partial filenames). `/tmp/*` matches `/tmp/foo.txt` and `/tmp/sub/bar.txt` but NOT `/tmp-evil/file`. |
   | Network operations | Domain name | Exact domain match. `api.example.com` matches `api.example.com` but NOT `evil-api.example.com` or `api.example.com.evil.com`. No subdomain wildcards. |
   | Message operations | Email pattern `*@domain.com` | Exact domain match after `@`. `*@company.com` matches `alice@company.com` but NOT `alice@company.com.evil.com`. |
   | Financial operations | Currency amount | Numeric comparison. `<50USD` matches any amount under $50 USD. |

3. **No regex or glob patterns** for scope matching. The matching is deliberately simple
   and restrictive to minimize the risk of overly broad matches.

4. **Path canonicalization**: Before any path comparison, paths are canonicalized:
   - Resolve all `..` sequences.
   - Normalize path separators to `/`.
   - Remove trailing slashes.
   - Reject paths containing null bytes.
   - The comparison is performed on the canonicalized form. A stored decision for
     `/tmp/*` will NOT match an attempt to access `/tmp/../../etc/passwd` because
     canonicalization resolves this to `/etc/passwd`, which does not match `/tmp/*`.

5. **Compound command rejection**: For shell-like commands (if shell Gear auto-approval
   were ever considered — see 5.6.5 for why it is excluded), scope matching is NOT
   supported. Shell commands are too complex to match safely via string patterns.
```

---

## Patch 17: Add Startup and Lifecycle Sequence

**Severity**: Major
**Review Finding**: #8.1 — No Process Model for Startup and Lifecycle
**Target Section**: 10 (Deployment Architecture), add new subsection 10.6

### Rationale

The document never describes how Meridian starts up — component initialization order, database migration timing, readiness gating, or the distinction between cold start and warm restart.

### Changes

**Add Section 10.6 after 10.5:**

```markdown
### 10.6 Startup Sequence

Meridian follows an ordered startup sequence with dependency relationships:

1. **Process initialization**: Load configuration (config file -> environment variables ->
   defaults). Initialize structured logging.
2. **Database initialization**: Open all SQLite databases. Run pending migrations if schema
   version is behind (forward-only, with automatic pre-migration backup). Verify database
   integrity (`PRAGMA integrity_check`) on first run after update.
3. **Axis startup**: Initialize the job queue, load persisted queue state. Register the
   dispatch middleware chain (signing, logging, error handling). Start the scheduler tick
   (evaluates cron schedules every 60 seconds). Start the watchdog health check loop.
4. **Core component registration**: Initialize Scout, Sentinel, Journal, and Gear runtime.
   Each component registers its message handlers with Axis. Components that require LLM API
   access (Scout, Sentinel, Journal's Reflector) perform a lightweight connectivity check
   (not a full API call — just DNS resolution and TCP connect). Failures are logged as
   warnings, not errors; the system can start without API connectivity.
5. **Crash recovery**: Axis scans for jobs that were `executing` or `planning` at the time
   of the previous shutdown. These are reset to `pending` for retry (see 5.1.5).
6. **Bridge startup**: Start the Fastify HTTP server and WebSocket endpoint. Bridge does
   not accept connections until all core components have registered (readiness gate).
7. **Ready**: Axis logs "Meridian ready" with startup duration. Bridge begins accepting
   connections. If this is the first run, Bridge serves the setup wizard instead of the
   normal UI.

**Startup time expectations:**

| Environment | Cold Start | Warm Restart |
|-------------|-----------|--------------|
| Raspberry Pi (SD card) | 5-15 seconds (dominated by SQLite migration check) | 2-5 seconds |
| Mac Mini (SSD) | 1-3 seconds | <1 second |
| VPS (SSD) | 1-3 seconds | <1 second |

**Health probes:**

- **Liveness probe** (`GET /api/health/live`): Returns 200 if the process is running and
  the event loop is responsive. Available immediately after step 1.
- **Readiness probe** (`GET /api/health/ready`): Returns 200 only after step 6 completes
  (all components registered, Bridge accepting connections). Returns 503 during startup.
  This is the probe that load balancers and Docker health checks should use.

**Graceful shutdown:**

On SIGTERM or SIGINT:
1. Bridge stops accepting new connections. Existing WebSocket connections receive a
   "shutting down" message.
2. Axis stops accepting new jobs. The scheduler stops ticking.
3. Axis waits for running jobs to complete (30-second timeout).
4. Running Gear processes are sent SIGTERM, then SIGKILL after 10 seconds.
5. All pending job state is persisted to SQLite.
6. Database connections are closed.
7. Process exits with code 0.
```

---

## Patch 18: Add Gear API Versioning

**Severity**: Major
**Review Finding**: #8.2 — No Versioning or Compatibility Strategy for Gear API
**Target Section**: 5.6.2 (Gear Manifest)

### Rationale

The `GearContext` API is the public contract with plugin authors. Without an `apiVersion` field, there is no way to manage backwards compatibility when the API evolves.

### Changes

**5.6.2 — Add `apiVersion` to `GearManifest`, after the `version` field:**

```typescript
  apiVersion: number;              // Meridian Gear API version this Gear targets (e.g., 1)
```

**5.6.2 — Add after the GearManifest interface:**

```markdown
**API versioning:** The `apiVersion` field declares which version of the `GearContext` API
the Gear expects. Meridian maintains backwards compatibility within a major API version:

- **API version 1**: The initial Gear API. Supported for the lifetime of Meridian 1.x.
- **Breaking changes**: Only introduced in a new API version (e.g., API version 2). Meridian
  will support the previous API version for at least one major release cycle, giving Gear
  authors time to migrate.
- **Additive changes**: New methods added to `GearContext` are backwards-compatible. Gear
  targeting an older API version will simply not use the new methods.
- **At install time**: If a Gear declares an `apiVersion` higher than the running Meridian
  supports, installation fails with a clear error message ("Gear requires API version 2,
  but this Meridian installation supports API version 1. Please update Meridian.").
```

---

## Patch 19: Document Long-Running Task Limitations

**Severity**: Major
**Review Finding**: #8.3 — No Strategy for Long-Running Tasks
**Target Section**: 5.1.2 (Job Model), 4.5 (Data Flow)

### Rationale

The default job timeout is 5 minutes, but the idea document describes tasks that could take hours (building software projects, complex data analysis). The architecture has no model for long-running tasks — no progress reporting, no checkpoint/resume, no user interaction during execution.

### Changes

**5.1.2 — Add after the Job interface:**

```markdown
**V1 task duration limitations:**

V1 is designed for tasks that complete within minutes, not hours. The default job timeout
is 300,000ms (5 minutes), configurable up to 3,600,000ms (1 hour) per job. This limitation
exists because:

1. The Gear sandbox model assumes short-lived executions. Long-running container-based Gear
   accumulates resource usage that cannot be reclaimed until the container is destroyed.
2. There is no checkpoint/resume mechanism. If Meridian restarts mid-task, the task starts
   over.
3. Concurrent job slots are limited (default: 2-4 workers). A long-running task blocks a
   slot for its entire duration.

**Progress reporting within the v1 model:** Gear can report progress to the user via the
`GearContext.progress()` method, which sends `progress` WebSocket messages to Bridge.
Multi-step plans provide natural progress granularity — each completed step is a progress
update.

**V2+: Workflow support:** Long-running tasks will be modeled as **workflows** — first-class
entities with:
- Multi-phase execution with checkpoints after each phase.
- Checkpoint persistence to SQLite, enabling resume after restart.
- User interaction mid-workflow (provide additional input, redirect, abort).
- Independent timeout per phase rather than per workflow.
- Lower-priority scheduling that yields to immediate tasks.

This is deferred to v2 because it requires significant Axis infrastructure (checkpoint
storage, workflow state machine, phase-level scheduling) that is not needed for the core
value proposition.
```

---

## Patch 20: Add Alternatives Considered Sections

**Severity**: Major
**Review Finding**: #10.1 — The Document Is a Specification, Not an Architecture
**Target Section**: 14 (Technology Stack), add new Section 14.4

### Rationale

The document describes *what* was chosen but not *why this over alternatives*. Future contributors need to understand what was rejected and why, to avoid re-litigating settled decisions.

### Changes

**Add Section 14.4 after 14.3:**

```markdown
### 14.4 Alternatives Considered

#### Database: SQLite vs. PostgreSQL vs. DuckDB

| Option | Considered for | Rejected because |
|--------|---------------|------------------|
| **SQLite** (chosen) | All structured storage | Chosen for: zero-config, no daemon process, single-file portability, minimal resource usage, sufficient for single-user workloads. |
| PostgreSQL | Primary database | Requires a separate daemon consuming ~30-100 MB RAM — unacceptable on a 4 GB Raspberry Pi. Adds operational complexity (user management, connection pooling, backups). Benefits (concurrent writes, advanced queries) are unnecessary for a single-user system. |
| DuckDB | Analytics/vector queries | Excellent for analytical workloads but has a less mature Node.js ecosystem than SQLite. `better-sqlite3` is battle-tested with extensive community support. DuckDB also lacks SQLite's ubiquity for operational data patterns (WAL, FTS5). |

#### HTTP Server: Fastify vs. Hono vs. Express

| Option | Considered for | Rejected because |
|--------|---------------|------------------|
| **Fastify** (chosen) | Bridge API server | Chosen for: built-in JSON Schema validation (reduces manual validation code), plugin architecture, high performance, mature WebSocket support via `@fastify/websocket`. |
| Hono | Bridge API server | Excellent for edge/serverless but less mature plugin ecosystem for server-side use. No built-in schema validation. WebSocket support via adapters rather than first-class. |
| Express | Bridge API server | Slower than Fastify (matters on constrained devices), no built-in schema validation, middleware-based architecture is less structured than Fastify's plugin model. |

#### State Management: Zustand vs. Redux vs. Jotai

| Option | Considered for | Rejected because |
|--------|---------------|------------------|
| **Zustand** (chosen) | Bridge frontend state | Chosen for: minimal boilerplate, simple mental model, small bundle size (<2 KB), no context providers needed. Appropriate for a single-user UI with moderate state complexity. |
| Redux (Toolkit) | Bridge frontend state | Significantly more boilerplate (slices, reducers, actions) for the relatively simple state needs of a single-user chat interface. RTK Query adds bundle size and complexity. |
| Jotai | Bridge frontend state | Atomic model is elegant but less intuitive for developers coming from other state management libraries. Zustand's store model maps more naturally to the "sidebar state + conversation state + settings state" pattern. |

#### Dual-LLM vs. Single-LLM Architecture

| Option | Considered for | Rejected because |
|--------|---------------|------------------|
| **Dual-LLM** (chosen) | Safety validation | Chosen for: independent validation, prompt injection chain-breaking, configurable trust model (different providers for Scout and Sentinel). |
| Single-LLM with self-validation | Safety validation | Self-evaluation bias (same model approves its own work), prompt injection propagation (compromised planner = compromised validator), no information barrier possible. OpenClaw's security failures (Section 3) directly result from this model. |
| Rules engine for common patterns + LLM for novel situations | Safety validation | Considered as a cost optimization. Rejected for v1 because the rule set would be incomplete at launch, and determining whether a situation is "novel" is itself a judgment call. Could be added as a Sentinel optimization in v2 (pre-screen plans against known-safe patterns before invoking the LLM). |

#### Package Structure: Monorepo Workspaces vs. Single Package

| Option | Considered for | Rejected because |
|--------|---------------|------------------|
| **Single package with module boundaries** (chosen for v1) | Code organization | Chosen for: faster builds, simpler dependency management, no cross-package resolution issues. ESLint rules enforce the same boundaries that package separation would. |
| npm workspaces (7 packages) | Code organization | Premature for a project with one developer and zero lines of code. Adds 7x config overhead (package.json, tsconfig.json per package) without a concrete consumer for independently-published packages. Can be adopted later when a specific need arises (e.g., publishing `@meridian/gear` SDK). |
```

---

## Patch 21: Make Fast-Path Selection Structural

**Severity**: Minor
**Review Finding**: #7.1 — Fast Path as a Trust Inversion
**Target Section**: 4.3 (Fast Path vs. Full Path)

### Rationale

The document says "Scout determines which path to use" which reads as a trust inversion. The reviewer's analysis (and the security-expert review) confirm that the fast path is structurally safe — fast-path responses produce text only, no Gear execution. But the mechanism should be specified as structural in Axis, not a flag from Scout.

### Changes

**4.3 — Amend the last paragraph of the Fast Path section:**

Current:
> Scout determines which path to use based on the user's message. If Scout is uncertain,
> it defaults to the full path (fail-safe).

Proposed:
> **Path selection is structural, not flag-based.** Axis determines the path based on what
> Scout returns, not based on a declared flag:
>
> - If Scout returns a plain text response (no `ExecutionPlan` structure): **fast path**.
>   Axis delivers the response to Bridge without Sentinel validation.
> - If Scout returns an `ExecutionPlan`: **full path**. Axis routes the plan through
>   Sentinel regardless of any other signal from Scout.
>
> This means Scout cannot "choose" the fast path while also producing an execution plan.
> The path is determined by the *shape* of Scout's output, which Axis verifies structurally.
> If Scout is uncertain whether a task requires action, it should produce a plan (which
> triggers the full path) rather than a text response.

---

## Patch 22: Defer Adaptive Model Selection

**Severity**: Minor
**Review Finding**: #2.2 — Adaptive Model Selection Is Premature Optimization
**Target Section**: 5.2.5 (Adaptive Model Selection)

### Rationale

Adaptive model selection requires Scout to assess task complexity before performing the task — itself a complex reasoning problem. At launch there is no data on task patterns to tune the heuristic. The reviewer recommends shipping with a single model per role.

### Changes

**5.2.5 — Add a "V1 Implementation" note at the top of the section:**

```markdown
**V1 note:** For v1, Scout uses a single configured model for all operations. The
primary/secondary model roster described below is a v2 optimization that should be
implemented only after collecting real-world usage data on task complexity distribution.
The configuration fields (`scout.models.primary` and `scout.models.secondary`) are defined
in v1 but `secondary` is not used — all requests go to `primary`. This allows users to
pre-configure both models for a seamless upgrade to v2.
```

---

## Patch 23: Document sqlite-vec Scalability Ceiling

**Severity**: Minor
**Review Finding**: #5.2 — Vector Search Scalability with sqlite-vec
**Target Section**: 5.4.5 (Retrieval: Hybrid Search)

### Rationale

`sqlite-vec` uses brute-force linear scan (no ANN index). At high memory counts, searches become slow on constrained devices.

### Changes

**5.4.5 — Add after the MemoryResult interface:**

```markdown
**Scalability note:** `sqlite-vec` performs brute-force linear scan for vector similarity.
At 10,000 memories with 384-dimensional embeddings, each search scans ~15 MB of vector
data. On a Raspberry Pi, this may take 100ms+. Mitigations:

- Pre-filter by memory type and time range before vector search to reduce scan size.
- The hybrid search strategy (Section 5.4.5) uses keyword search (FTS5) as a first pass,
  which is fast, and only applies vector search to the top-k keyword results.
- If memory count exceeds ~50,000 entries and search latency becomes unacceptable, a future
  version can migrate to an ANN-indexed vector store while keeping the same query interface.
```

---

## Patch 24: Add Idempotency Keys to Message API

**Severity**: Minor
**Review Finding**: #8.4 — No Content Addressing or Idempotency
**Target Section**: 9.2 (External API)

### Rationale

If the user double-clicks send or a network retry occurs, the system creates two jobs. Client-generated idempotency keys prevent duplicate processing.

### Changes

**9.2 — Amend the `POST /api/messages` endpoint:**

Current:
> `POST /api/messages` — Send a message (creates a job)

Proposed:
> `POST /api/messages` — Send a message (creates a job). Accepts an optional
> `Idempotency-Key` header (client-generated UUID). If a message with the same idempotency
> key was received within the last 5 minutes, the existing job is returned instead of
> creating a new one. Bridge's frontend automatically generates idempotency keys for every
> message submission.

---

## Patch 25: Add LLM Decision Quality Observability

**Severity**: Minor
**Review Finding**: #8.5 — No Observability Into LLM Decision Quality
**Target Section**: 12.2 (Metrics)

### Rationale

The metrics section tracks operational metrics but nothing about LLM decision quality. Without quality metrics, the system can degrade silently.

### Changes

**12.2 — Add after the existing metrics list:**

```markdown
**Decision quality metrics** (aggregated in Journal, surfaced in Bridge):

- `sentinel_rejection_rate` — Percentage of plans rejected by Sentinel. Abnormally high
  rates suggest Scout is producing poor plans; abnormally low rates may indicate Sentinel
  is not validating effectively.
- `user_override_rate` — How often users approve plans that Sentinel flagged, or reject
  plans that Sentinel approved. High override rates suggest a calibration mismatch between
  Sentinel's policies and the user's actual preferences.
- `replan_rate` — How often Scout must replan after Gear failures. High replan rates
  suggest Scout is selecting incorrect Gear or producing bad parameters.
- `gear_suggestion_acceptance_rate` — What percentage of Journal's Gear suggestions are
  implemented or dismissed. Low acceptance rates suggest the suggestion quality needs
  improvement.

These metrics are not exported as Prometheus counters. They are computed from the audit
log, stored in Journal as aggregate facts, and displayed in a Bridge dashboard panel. They
are intended for the user's awareness, not external monitoring.
```

---

## Patch 26: Drop pkg Single-Binary Strategy for V1

**Severity**: Minor
**Review Finding**: #9.1 — The `pkg` Single Binary Strategy Is Fragile
**Target Section**: 10.2 (Installation)

### Rationale

`pkg` has compatibility issues with native modules (`better-sqlite3`), especially on ARM64, and has not been actively maintained since 2023. Distributing as a Node.js application or Docker image is more reliable.

### Changes

**10.2 — Amend the introductory text:**

Current:
> Meridian ships as a single binary (compiled TypeScript via `pkg` or distributed as a
> Node.js application):

Proposed:
> Meridian is distributed as a Node.js application or Docker image:

Remove "Option 1: Install script (downloads binary for your platform)" and renumber.

**10.2 — Add a note:**

```markdown
**Why not a single binary?** Tools like `pkg` and `@yao-pkg/pkg` compile Node.js
applications into standalone binaries, but they have known compatibility issues with
native modules (`better-sqlite3`, `isolated-vm`) and limited ARM64 support. For v1,
the npm and Docker distribution methods are more reliable. A single-binary distribution
can be explored in a future version once the application is stable and the native module
landscape improves (e.g., if `better-sqlite3` gains WASM support).
```

---

## Patch 27: Add Docker Master Key Lifecycle Documentation

**Severity**: Minor
**Review Finding**: #9.2 — Docker Compose Master Key Source File
**Target Section**: 10.3 (Container Strategy)

### Rationale

The `master_key.txt` file exists as plaintext on the host disk. While Docker's file-based secrets are more secure than environment variables, the host-side lifecycle should be documented.

### Changes

**10.3 — Add after the Docker Compose YAML:**

```markdown
**Master key lifecycle:** The `master_key.txt` file on the host is used only to initialize
the Docker secret. Inside the container, the secret is mounted via tmpfs at
`/run/secrets/master_key` and never touches the container's filesystem.

Host-side recommendations:
- Set `chmod 600 master_key.txt` to restrict access to the file owner.
- After the first `docker compose up`, the file can optionally be deleted — Docker caches
  the secret internally. However, it will be needed again if the secret is recreated.
- For high-security deployments, consider Docker Swarm's external secrets or a hardware
  security module.
- Do NOT use environment variables (`MERIDIAN_MASTER_KEY`) as a replacement — environment
  variables are visible via `docker inspect` and may leak in logs.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Specify message bus semantics (typed function dispatch + IPC) | Critical | 4.2, 9.1 |
| 2 | Scope Gear Synthesizer down to suggestion system for v1 | Critical | 5.4.3, 5.4.4 |
| 3 | Acknowledge hybrid process model (in-process core, out-of-process Gear) | Major | 4.2 |
| 4 | Narrow Sentinel's documented validation scope (limited ethical/legal) | Major | 5.3.2 |
| 5 | Specify Gear dependency management (npm, native modules, isolation) | Major | 5.6.2, 5.6.4 |
| 6 | Add conversation threading model (conversations table, multi-turn) | Major | 8.3, 5.2.3 |
| 7 | Refine loose schema to typed interfaces with metadata bag | Major | Throughout |
| 8 | Type WSMessage as discriminated union | Major | 5.5.4 |
| 9 | Recommend single package for v1 with module boundary enforcement | Major | 15.1 |
| 10 | Minimize shared module scope (types owned by producers) | Major | 15.1 |
| 11 | Document SQLite write performance on constrained devices | Major | 8.1 |
| 12 | Complete job state machine with all valid transitions | Major | 5.1.2 |
| 13 | Bound Gear failure replan loop (max 3 replans) | Major | 4.5 |
| 14 | Define error propagation protocol (ComponentError, cascading prevention) | Major | 9.1 |
| 15 | Coordinate LLM rate limits between Scout and Sentinel | Major | 5.3.7, 5.3.6 |
| 16 | Specify Sentinel Memory scope matching semantics (exact, canonical) | Major | 5.3.8 |
| 17 | Add startup sequence and lifecycle model | Major | 10.6 (new) |
| 18 | Add Gear API versioning (apiVersion field) | Major | 5.6.2 |
| 19 | Document long-running task v1 limitations and v2 workflow plan | Major | 5.1.2, 4.5 |
| 20 | Add Alternatives Considered section for major decisions | Major | 14.4 (new) |
| 21 | Make fast-path selection structural (Axis determines from output shape) | Minor | 4.3 |
| 22 | Defer adaptive model selection to v2 | Minor | 5.2.5 |
| 23 | Document sqlite-vec scalability ceiling | Minor | 5.4.5 |
| 24 | Add idempotency keys to message API | Minor | 9.2 |
| 25 | Add LLM decision quality observability metrics | Minor | 12.2 |
| 26 | Drop pkg single-binary strategy for v1 | Minor | 10.2 |
| 27 | Document Docker master key lifecycle | Minor | 10.3 |

### Findings Intentionally Not Patched

| Finding | Reason |
|---------|--------|
| **10.2**: Naming theme obscures code communication | Reviewer rates this as Minor. The naming theme is a deliberate branding decision documented in Section 1. The recommendation to use descriptive names in code and logs is reasonable but is an implementation convention, not an architecture document change. This should be captured in CLAUDE.md or a coding standards document instead. |
