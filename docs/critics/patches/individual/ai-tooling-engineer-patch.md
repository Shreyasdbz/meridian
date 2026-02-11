# Architecture Patches: AI Tooling Engineer Review

> **Source**: `docs/critics/ai-tooling-engineer.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium) then by section number.

---

## Patch 1: MCP-First Gear Architecture

**Severity**: Critical
**Review Finding**: #1 — MCP Compatibility Gap
**Target Sections**: 5.6 (Gear — Plugin System), 9.3 (Gear API), 9.4 (MCP Compatibility)

### Rationale

The reviewer argues that MCP has already emerged as the standard tool protocol for LLM-tool integration. By the time Meridian ships, the MCP ecosystem will have hundreds of production servers covering most tool integrations Meridian would need. Building a custom Gear execution protocol that overlaps with MCP duplicates work and limits the ecosystem. The Gear manifest (permissions, sandbox, secrets, audit) provides genuine value that MCP does not — but the tool invocation path should use MCP rather than competing with it. This gives Meridian the entire MCP ecosystem on day one, with Meridian's security layer on top.

### Changes

**9.4 — Replace the entire MCP section with a new section promoting MCP to core:**

```markdown
#### 9.4 MCP as Core Tool Protocol

Anthropic's Model Context Protocol (MCP) is the standard for LLM-tool integration. Rather than
building a parallel custom tool protocol, Meridian uses MCP as its primary tool invocation layer,
with Gear providing the security, permission, and audit layer on top.

**Architecture:**

```
Scout ──(MCP tool calls)──► Axis ──(permission check)──► Gear Wrapper ──(MCP transport)──► MCP Server
                                                              │
                                                    Enforces: permissions, sandbox,
                                                    secrets, resource limits, audit
```

**How Gear wraps MCP servers:**

- Each Gear is a Meridian security manifest wrapping an MCP server. The `GearManifest` declares
  permissions, resource limits, secrets, and provenance — none of which MCP provides.
- The MCP server handles tool discovery and execution. Meridian handles the trust boundary.
- Scout's tool calls use MCP's native tool-use format. The `LLMProvider` adapter (Section 5.2.4)
  translates between provider-specific tool-call formats and MCP's tool schema.
- Axis intercepts MCP tool calls, validates them against the Gear manifest, injects secrets,
  enforces resource limits, logs to the audit trail, and then forwards to the MCP server.

**MCP transport modes:**

| Gear Type | MCP Transport | Lifecycle |
|-----------|--------------|-----------|
| Built-in Gear | In-process stdio | Started with Axis, persistent |
| User-installed Gear (JS/TS) | stdio or SSE | Started on first use, kept alive for session |
| User-installed Gear (any language) | stdio or SSE | Started on first use, kept alive for session |
| Container Gear (Docker) | SSE over container network | Container created per-session, destroyed on idle |

**What Gear adds over raw MCP:**

MCP defines a transport and tool schema protocol. Gear adds:
- Permission manifests with declared filesystem, network, secret, and shell access
- Sandbox enforcement (process isolation or container isolation)
- Secret injection (MCP servers never see the vault directly)
- Resource limits (memory, CPU, timeout, network bytes)
- Audit logging of every tool invocation
- Provenance tracking (`origin: builtin | user | journal`)
- Signature verification and checksum validation
- Draft status for Journal-generated Gear

**Existing MCP servers as Gear:**

Any existing MCP server can be wrapped as Gear by providing a `GearManifest` alongside it.
Meridian provides a `meridian gear wrap <mcp-server>` command that:
1. Discovers the MCP server's tools via the MCP `tools/list` method
2. Generates a draft `GearManifest` with permissions inferred from the tool descriptions
3. Presents the manifest for user review and adjustment
4. Registers the wrapped MCP server as available Gear

This gives Meridian access to the growing MCP ecosystem immediately while maintaining the
full security model.

**Journal Gear Synthesizer and MCP:**

The Gear Synthesizer (Section 5.4.3) generates MCP servers rather than custom Gear code. In v1,
synthesized Gear produces MCP servers that compose existing tool calls — the synthesized server's
tools internally call other MCP servers via Axis, inheriting their permission checks. The
manifest is auto-generated from the union of constituent Gear permissions.
```

**5.6.2 — Amend the GearManifest interface, adding an MCP field:**

Add after the `origin` field:
```typescript
  // MCP server configuration
  mcp: {
    command: string;               // Command to start the MCP server
    args?: string[];               // Arguments
    transport: 'stdio' | 'sse';   // MCP transport mode
    env?: Record<string, string>; // Environment variables (non-secret)
  };
```

**9.3 — Amend the GearContext section:**

Add a note at the top:
```markdown
The `GearContext` API described below is the interface available to built-in Gear implemented
as in-process TypeScript modules. For Gear implemented as external MCP servers (the primary
model for user-installed and Journal-generated Gear), the MCP server receives tool calls via
standard MCP transport, and Meridian enforces the GearContext constraints (filesystem, network,
secrets, resource limits) at the Axis interception layer rather than within the Gear process
itself.
```

---

## Patch 2: Tool Use Translation Layer

**Severity**: Critical
**Review Finding**: #2 — Tool Use Format: The Missing Translation Layer
**Target Section**: 5.2.4 (LLM Provider Abstraction) — add new subsection 5.2.4.1

### Rationale

Every LLM provider has a different tool-use/function-calling format (Anthropic's `tool_use` content blocks, OpenAI's `tool_calls` with stringified JSON arguments, Google's `functionCall`, and Ollama's variable support). The architecture describes Scout producing `ExecutionPlan` objects but does not specify how different providers are coerced into producing a consistent structure. This is not trivial and needs explicit specification.

### Changes

**5.2.4 — Add subsection after the provider list:**

```markdown
#### 5.2.4.1 Tool Use Translation Layer

Each `LLMProvider` adapter includes a tool-use translation layer that handles the bidirectional
conversion between Meridian's plan format and the provider's native tool-calling format.

**Outbound (Meridian → Provider):**

When Scout needs to produce an execution plan, Axis presents the available Gear catalog as
provider-native tool schemas:

| Provider | Tool Schema Format | Translation |
|----------|-------------------|-------------|
| Anthropic | `tools[]` with `input_schema` (JSON Schema) | Direct mapping from `GearAction.parameters` |
| OpenAI | `tools[]` with `function.parameters` (JSON Schema) | Direct mapping, arguments returned as JSON string (must be parsed) |
| Google | `functionDeclarations[]` with `parameters` (OpenAPI subset) | JSON Schema → OpenAPI parameter conversion |
| Ollama | Model-dependent; some support tool calling, others need prompt-based | Feature-detect: use native tool calling if available, fall back to structured-output prompting |

**Inbound (Provider → Meridian):**

When the LLM responds with tool calls, the adapter parses the provider-specific format into
normalized `ExecutionStep` objects:

1. Extract tool name → map to `gear` and `action` fields via the Gear catalog.
2. Extract arguments → parse into `parameters` (handling OpenAI's stringified JSON, Google's
   nested format, etc.).
3. Validate parameters against the Gear action's declared JSON Schema.
4. If validation fails, retry the LLM call with the validation error as feedback (up to 2
   retries per step).

**Fallback: Structured output prompting:**

For providers or models that do not support native tool calling, the adapter falls back to
prompt-based structured output:
- Scout's system prompt includes the Gear catalog formatted as a schema description.
- Scout is instructed to output JSON matching the `ExecutionPlan` schema.
- The adapter parses the raw JSON response, validates it, and retries on parse failure.
- This fallback is clearly documented as lower-reliability than native tool calling. Users
  are warned during setup if their chosen model lacks tool-use support.

**Adapter testing:**

Each provider adapter is independently tested against a conformance suite that verifies:
- Tool schema generation from a fixed Gear catalog
- Response parsing for each provider's tool-call format
- Error handling for malformed responses
- Fallback behavior when tool calling is unavailable
```

---

## Patch 3: Explicit Plan Dependencies

**Severity**: Critical
**Review Finding**: #3 — Multi-Step Plan Execution
**Target Section**: 5.2.2 (Execution Plan Format), 5.1.3 (Concurrency Model)

### Rationale

The `ExecutionPlan` is a flat `steps: ExecutionStep[]` with `parallelGroup` and `order` as optional free-form fields. Real plans need explicit dependency tracking — step 3 may need the output of step 1, step 4 may need outputs from both step 2 and step 3. This is a DAG, not a list. The reviewer notes that projects starting with flat step lists always end up bolting on DAG execution later. Making `dependencies` a required field enables Axis to compute maximal parallelism deterministically.

### Changes

**5.2.2 — Amend the `ExecutionStep` interface, adding `dependencies` as a required field:**

```typescript
interface ExecutionStep {
  // --- Required (Axis needs these to dispatch to Gear) ---
  id: string;
  gear: string;                 // Gear identifier
  action: string;               // Specific action within the Gear
  parameters: Record<string, unknown>;

  // --- Required (Sentinel needs these for validation) ---
  riskLevel: 'low' | 'medium' | 'high' | 'critical';

  // --- Required (Axis needs these for execution ordering) ---
  dependencies: string[];       // IDs of steps that must complete before this one.
                                // Empty array means the step can run immediately.

  // --- Free-form (Scout fills in whatever is useful) ---
  [key: string]: unknown;       // description, rollback, outputKey, etc.
}
```

**5.1.3 — Amend the "Step Parallelism" bullet:**

Current:
> **Step Parallelism**: Within a job, Scout can mark steps as parallelizable. Axis dispatches parallel steps concurrently, respecting the overall worker limit.

Proposed:
> **Step Parallelism**: Within a job, each step declares its `dependencies` — the IDs of steps that must complete before it can run. Axis computes the execution DAG from these dependencies and dispatches steps in maximal parallelism: any step whose dependencies are all satisfied is eligible for immediate dispatch, subject to the overall worker limit. Steps with an empty `dependencies` array are eligible from the start. Axis detects cycles in the dependency graph during pre-validation (Section 4.5 step 6) and rejects plans with circular dependencies.

**5.2.2 — Add after the `ExecutionStep` interface:**

```markdown
**Data flow between steps:** When a step produces output that a downstream step needs, Scout
includes an `outputKey` field (free-form) on the producing step. Axis stores the step's result
under this key in the job context. The downstream step can reference the upstream output via
a `$ref:step:<stepId>` placeholder in its `parameters`, which Axis resolves at dispatch time.
This keeps the plan statically analyzable while enabling data flow between steps.

**Conditional logic and dynamic steps:** The base plan format supports static DAGs. For
conditional branching ("if file exists, update; otherwise create") and dynamic step generation
("for each search result, fetch the page"), Scout uses the `createSubJob` mechanism in
GearContext, which delegates through the full Scout → Sentinel pipeline. This preserves the
security model — every dynamically generated sub-plan gets Sentinel validation — at the cost
of additional latency. For v1, this tradeoff is intentional.
```

---

## Patch 4: Reliability Consolidation

**Severity**: Critical
**Review Finding**: #12 — Real-World Agent Failures
**Target Section**: New Section 5.7 (cross-cutting), amendments to 4.5 and 5.1.1

### Rationale

The reviewer identifies that the architecture addresses reliability across many scattered sections (4.3, 4.4, 5.1.5, 5.2.2, 5.3.4, 5.3.8, 5.4.4) but lacks a consolidated reliability model. Specific gaps include: no output validation beyond schema, no plan quality heuristics before Sentinel, no cost-aware planning, no completion verification, and no progress monitoring for multi-step plans. The reviewer provides a ranked list of production agent failure modes (tool selection errors, parameter hallucination, context loss, infinite elaboration, premature completion, cascading failures, resource waste loops) and notes which are addressed and which are not.

### Changes

**Add Section 5.7 after Section 5.6:**

```markdown
### 5.7 Reliability Engineering

This section consolidates Meridian's approach to operational reliability. Individual mechanisms
are described in their component sections; this section provides the end-to-end view and fills
gaps not covered elsewhere.

#### 5.7.1 Reliability Mechanisms by Component

| Mechanism | Section | What It Handles |
|-----------|---------|-----------------|
| Fast path vs. full path | 4.3 | Efficient routing reduces unnecessary complexity |
| Graceful degradation | 4.4 | External dependency failures |
| Plan pre-validation | 4.5 step 6 | Hallucinated Gear/actions, parameter schema mismatches |
| Crash recovery, circuit breaker, watchdog | 5.1.5 | Infrastructure-level failures |
| Structured plan format | 5.2.2 | Plans are machine-parseable and validatable |
| LLM output failure handling | 5.2.7 | Malformed JSON, refusals, truncation, loops |
| Sentinel validation | 5.3 | Unsafe, unethical, or policy-violating plans |
| Sentinel Memory | 5.3.8 | Progressive autonomy, avoiding repetitive approval |
| Gear Improvement Loop | 5.4.4 | Learning from task failures |
| Sandbox enforcement | 5.6.3 | Gear cannot exceed declared permissions |

#### 5.7.2 Output Validation

Beyond schema validation (Section 6.2, LLM05), Axis performs semantic output checks after
Gear execution:

- **Null/empty result detection**: If a Gear returns a structurally valid but substantively
  empty result (e.g., `{ success: true, data: null }`, empty string, empty array), Axis flags
  it as a potential functional failure and routes to Scout for assessment before presenting to
  the user.
- **Error-in-success detection**: If a Gear returns `success: true` but the result content
  contains error patterns (HTTP error codes, exception messages, "not found" language), Axis
  flags the result for Scout review.
- **Type conformance**: Gear outputs are validated against the action's declared `returns`
  JSON Schema. Non-conforming outputs are treated as Gear errors.

#### 5.7.3 Cost-Aware Planning

Scout's planning context includes the remaining daily budget (from Section 11.1 cost tracking):

```
Remaining daily budget: $3.42 of $5.00
Estimated cost per LLM call: ~$0.03 (secondary), ~$0.15 (primary)
```

Scout is instructed to consider cost when choosing between approaches: if the remaining budget
is low, prefer plans that use fewer LLM calls and simpler Gear. If the remaining budget cannot
support the estimated plan cost, Scout informs the user rather than starting a plan that will
be interrupted by the cost limit.

#### 5.7.4 Completion Verification

After execution completes and before the response is sent to the user, Axis routes the result
through a lightweight completion check:

- **For single-step tasks**: The Gear's output is the result. No additional verification.
- **For multi-step tasks**: Scout (using the secondary model) compares the aggregated results
  against the original user request and produces a brief assessment: `complete`, `partial`
  (with explanation of what is missing), or `failed` (with explanation). This assessment is
  included in the response to the user and logged for Journal reflection.

This verification is a single secondary-model call, not a full replanning cycle. It catches
premature completion ("task done" when only 2 of 5 steps succeeded) and cascading failures
(each step "succeeded" but the aggregate result is wrong).

#### 5.7.5 Progress Monitoring for Multi-Step Plans

For plans with more than 3 steps, Axis monitors execution progress:

- **Step completion tracking**: Bridge displays a step-by-step progress indicator showing
  completed, running, and pending steps (leveraging the dependency DAG from Section 5.2.2).
- **Stall detection**: If no step completes within a configurable window (default: 2x the
  expected step duration or 5 minutes, whichever is greater), Axis logs a warning and notifies
  the user via Bridge. The user can choose to continue waiting, cancel, or ask Scout to replan.
- **Partial result surfacing**: When steps complete incrementally, their results are streamed
  to Bridge so the user can see progress in real time, not just a final result.
```

**4.5 — Amend step 9 (Result Collection):**

Current:
> 9. **Result Collection**: Gear returns results to Axis. If a step fails, Axis routes back to Scout for replanning using a potentially different approach or Gear.

Proposed:
> 9. **Result Collection**: Gear returns results to Axis. Axis validates outputs (Section 5.7.2) and stores step results in the job context. If a step fails, Axis routes back to Scout for replanning (see Section 5.7.6 for replanning context). If all steps complete, Axis performs completion verification (Section 5.7.4) for multi-step tasks.

**5.1.1 — Add to Axis responsibilities:**

```markdown
- Validate Gear outputs against declared return schemas and semantic checks (Section 5.7.2)
- Provide remaining cost budget to Scout during planning (Section 5.7.3)
- Monitor multi-step plan progress and detect stalls (Section 5.7.5)
```

---

## Patch 5: Replanning Context and Convergence

**Severity**: High
**Review Finding**: #4 — Replanning Loops and #7 — Error Handling in Plans
**Target Sections**: 5.3.4 (Approval Flow), 4.5 (Data Flow — step 9)

### Rationale

Two related findings are combined here. The reviewer identifies that (1) there is no mechanism to ensure Plan N+1 is better than Plan N during Sentinel revision loops, (2) Scout's revision context is unspecified, and (3) the replanning context after step failures is described in a single sentence ("routes back to Scout for replanning") without specifying what information Scout receives. These are the hardest problems in multi-step agent execution and need explicit specification.

### Changes

**5.3.4 — Add after the approval flow diagram:**

```markdown
**Revision context:** When Sentinel returns `NEEDS_REVISION`, Axis assembles the following
context for Scout's revision attempt:

1. The rejected plan (full structure)
2. Sentinel's specific feedback (which steps were problematic and why)
3. All previously rejected plans in this revision cycle (to prevent repetition)
4. The available Gear catalog (Scout may need to choose different Gear)

Scout does NOT receive the user's original message again during revision — it works from
the original plan and Sentinel's feedback. This is intentional: the revision is about making
the plan safe, not re-interpreting the user's request.

**Convergence detection:** Axis tracks plan similarity across revision iterations using a
structural comparison of step sequences (Gear + action + parameter keys). If a revised plan
is >90% structurally similar to any previously rejected plan in the same cycle, Axis skips
the Sentinel call and applies the most relevant previous rejection feedback to Scout's next
attempt. After 2 consecutive similar-plan detections, Axis breaks the revision loop.

**Escalation strategy:** The revision loop uses progressive escalation:
- **Iteration 1**: Scout makes targeted modifications to the flagged steps.
- **Iteration 2**: Scout attempts a fundamentally different approach (prompted to consider
  alternative Gear or decomposition).
- **Iteration 3** (final): Instead of producing another plan, Scout formulates a question
  for the user explaining the constraint and asking for guidance. This is routed through
  Bridge as a clarification request, not a failure.

**Post-exhaustion behavior:** If the revision loop is exhausted without an approved plan, the
job status is set to `failed` with a user-readable explanation that includes:
- What the user originally asked for
- Why the plan could not be made safe (Sentinel's last rejection reason)
- Suggested ways to rephrase or decompose the request
```

**Add new subsection 5.7.6 (within Section 5.7 from Patch 4):**

```markdown
#### 5.7.6 Replanning After Step Failure

When a step fails during execution, Axis assembles a replanning context for Scout:

1. **Original user request**: The message that initiated the job.
2. **Original plan**: The full execution plan as approved by Sentinel.
3. **Step results**: A `StepResult` for each completed step:
   ```typescript
   interface StepResult {
     stepId: string;
     status: 'completed' | 'failed' | 'skipped';
     result?: unknown;              // Output data if completed
     error?: {                      // Error details if failed
       code: string;                // Error code or HTTP status
       message: string;             // Human-readable error message
       stderr?: string;             // Stderr output if applicable
     };
     durationMs: number;
     sideEffects?: string[];        // Files created, API calls made, etc.
   }
   ```
4. **World state after partial execution**: List of observable side effects from completed
   steps (files created/modified, API calls made). Axis tracks these from Gear execution
   logs.
5. **Available Gear**: The current Gear catalog (Scout may choose different Gear for the
   revised plan).
6. **Failure count**: How many times this job has been replanned (Axis enforces a maximum
   of 2 replanning attempts per job).

**Compensation over rollback:** The architecture uses a compensation model rather than
automatic rollback. When replanning, Scout must account for the side effects of
already-executed steps in its new plan. For example, if Step 1 created a file and Step 2
failed, the revised plan should not re-create the file. The `sideEffects` field in
`StepResult` gives Scout visibility into what has already happened.

The `rollback` free-form field on `ExecutionStep` is guidance for Scout during replanning —
it is not automatically executed by Axis. If a step includes rollback guidance and that step's
downstream steps fail, Scout can incorporate the rollback actions into the revised plan.
Rollback actions go through Sentinel validation as part of the revised plan.
```

---

## Patch 6: GearContext API Expansion

**Severity**: High
**Review Finding**: #5 — GearContext Capabilities
**Target Section**: 9.3 (Gear API)

### Rationale

The current GearContext has 9 methods. The reviewer identifies real-world automation capabilities that are missing: delays for rate limiting, structured event emission, ephemeral state between steps, and controlled command execution (distinct from the `shell` Gear). The architecture has good building blocks (secrets + fetch for auth, Sentinel Memory for progressive shell autonomy) but is missing primitives that would make Gear authoring practical.

### Changes

**9.3 — Expand the GearContext interface:**

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

  // Communicate back to the user and Axis
  log(message: string): void;    // Append to execution log
  progress(percent: number, message?: string): void; // Update progress
  emit(event: string, data?: Record<string, unknown>): void; // Structured event to Axis

  // Controlled delay (for rate limiting between API calls)
  sleep(ms: number): Promise<void>;  // Capped at the Gear's remaining timeout

  // Ephemeral state scoped to the current job
  getState(key: string): Promise<unknown | undefined>;
  setState(key: string, value: unknown): Promise<void>;

  // Execute a declared command (must be in manifest's `commands` allowlist)
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  // Spawn sub-tasks (goes through Axis -> Scout -> Sentinel)
  createSubJob(description: string): Promise<JobResult>;
}
```

**9.3 — Add after the GearContext interface:**

```markdown
**New methods explained:**

- **`emit(event, data)`**: Emits a structured event to Axis's event bus. This enables
  Gear to trigger event-driven jobs (Section 5.1.4) and provide richer progress reporting
  than `log()`. Events are recorded in the audit trail.

- **`sleep(ms)`**: Pauses execution for the specified duration. Essential for rate-limited
  API calls. The actual sleep duration is capped at the Gear's remaining timeout — a Gear
  cannot use `sleep()` to exceed its declared timeout. Calls to `sleep()` also serve as
  implicit heartbeats (see Section 5.7.5).

- **`getState(key)` / `setState(key, value)`**: An ephemeral key-value store scoped to the
  current job execution. Data is held in memory by Axis and discarded when the job completes.
  This allows multi-step Gear to pass intermediate results between actions without writing
  to the filesystem. State values must be JSON-serializable.

- **`exec(command, args)`**: Executes a command from the Gear's declared `commands` allowlist
  (see manifest addition below). Unlike the `shell` Gear, this does not require a separate
  sub-job through the full Scout → Sentinel pipeline. The command must be explicitly declared
  in the manifest, and only those declared commands can be invoked. Arguments are passed as
  an array (no shell interpolation). stdout and stderr are captured and returned.
```

**5.6.2 — Add to the GearManifest `permissions` block:**

```typescript
    commands?: {
      allowed: string[];           // Executable names this Gear can invoke (e.g., ["git", "ffmpeg"])
      disallowedArgs?: string[];   // Argument patterns that are always blocked
    };
```

---

## Patch 7: Multi-Language Gear via MCP

**Severity**: High
**Review Finding**: #6 — Gear Language Support
**Target Section**: 5.6.3 (Sandboxing Model)

### Rationale

Level 1 sandboxing (process isolation with `isolated-vm`) is JavaScript-only. Many valuable automations are better expressed in Python (data analysis, ML/AI, scraping) or other languages. With MCP as the core tool protocol (Patch 1), multi-language Gear becomes natural — any MCP server in any language can be wrapped as Gear. This patch formalizes the multi-language development path.

### Changes

**5.6.3 — Add after the two sandbox level descriptions:**

```markdown
#### 5.6.3.1 Multi-Language Gear

With MCP as the core tool protocol (Section 9.4), Gear can be implemented in any language
that can run an MCP server. The sandbox model adapts based on the Gear's runtime:

| Language | Sandbox Model | MCP Transport |
|----------|--------------|---------------|
| TypeScript/JavaScript | Level 1 (process isolation) or Level 2 (container) | stdio |
| Python | Level 2 (container) with provided base image | stdio |
| Shell scripts | Level 2 (container) with minimal base image | stdio |
| Go / Rust / other compiled | Level 2 (container) with scratch or distroless base | stdio or SSE |

**Meridian provides base container images for common runtimes:**

- `meridian/gear-node:20` — Node.js 20 with MCP SDK pre-installed
- `meridian/gear-python:3.12` — Python 3.12 with MCP SDK and common data libraries
- `meridian/gear-shell:alpine` — Alpine Linux with common CLI tools

Each base image includes:
- The MCP server SDK for the respective language
- A pre-configured entrypoint that speaks MCP over stdio
- Read-only root filesystem
- No network access by default (granted via manifest declarations)

**Python Gear example:**

A Python MCP server that uses `pandas` to analyze CSV files would be packaged as:

```
my-csv-gear/
  gear-manifest.json        # Meridian permission manifest
  server.py                 # MCP server implementation
  requirements.txt          # Python dependencies
  Dockerfile                # FROM meridian/gear-python:3.12
```

The `GearManifest` declares `filesystem.read` for the data directory, and the Dockerfile
installs the Python dependencies into the container. Meridian builds the container image
on Gear installation and caches it for reuse.

**For Raspberry Pi deployments without Docker:** Multi-language Gear is not available under
Level 1 (process isolation). Users are informed during setup that Python and other non-JS
Gear require Docker. JavaScript/TypeScript Gear works without Docker.
```

---

## Patch 8: Heartbeat and Long-Running Task Support

**Severity**: Medium
**Review Finding**: #8 — Streaming and Long-Running Tasks
**Target Sections**: 5.6.2 (Gear Manifest — resources), 5.1.5 (Fault Tolerance)

### Rationale

The default 5-minute Gear timeout is configurable but many real tasks take much longer (builds, large downloads, video processing). The reviewer identifies that there is no mechanism for Axis to distinguish "still working" from "stuck" — no heartbeat mechanism, no dynamic timeout extension, and no differentiation between long-running and short-lived tasks in the worker pool.

### Changes

**5.6.2 — Amend the `resources` block in GearManifest:**

```typescript
  resources?: {
    maxMemoryMb?: number;          // Memory limit (default: 256 MB)
    maxCpuPercent?: number;        // CPU limit (default: 50%)
    timeoutMs?: number;            // Execution timeout (default: 300000 — 5 min)
    maxNetworkBytesPerCall?: number; // Network transfer limit
    heartbeatIntervalMs?: number;  // Max interval between heartbeats (default: 60000 — 1 min)
    longRunning?: boolean;         // If true, job uses the long-running worker pool
  };
```

**5.1.5 — Add after the "Watchdog" bullet:**

```markdown
- **Gear heartbeat monitoring**: Gear must emit a heartbeat at least once per
  `heartbeatIntervalMs` (declared in manifest, default: 60 seconds). Calls to `progress()`,
  `log()`, `emit()`, or `sleep()` in GearContext serve as implicit heartbeats. If a Gear
  misses 2 consecutive heartbeat windows:
  1. Axis logs a warning.
  2. Axis notifies the user via Bridge with the Gear's last known status.
  3. The user can choose to continue waiting, extend the timeout, or kill the Gear.
  Axis does not automatically kill a Gear on missed heartbeats — it defers to the user,
  since the Gear may be doing legitimate long-running work (e.g., a large download).
  Automatic termination only occurs when the Gear's declared `timeoutMs` is exceeded.
```

**5.1.3 — Add after the "Backpressure" bullet:**

```markdown
- **Long-running job separation**: Gear that declares `longRunning: true` in its manifest
  is dispatched to a separate long-running worker pool (default: 1 worker on Raspberry Pi,
  2 on Mac Mini/VPS). This prevents long tasks from starving the regular job queue. Short
  tasks always have at least 1 dedicated worker available.
```

---

## Patch 9: Gear Developer Kit

**Severity**: Medium
**Review Finding**: #9 — Testing Gear: Developer Experience
**Target Section**: 13 (Testing Strategy) — add new subsection 13.6, and 5.6.4 (Gear Lifecycle)

### Rationale

The testing strategy covers testing Meridian's sandbox but not testing Gear themselves. Gear authors need a development kit (types, mock context, local test harness, manifest validator) and Journal-generated Gear needs automated validation before being presented to the user. If the Gear ecosystem does not have a good developer experience, the ecosystem will not grow.

### Changes

**Add Section 13.6 after 13.5 (or after 13.4 if Patch 2 from the AI researcher review has not been applied):**

```markdown
### 13.6 Gear Testing and Developer Tools

#### 13.6.1 Gear Development Kit (GDK)

Meridian ships a Gear Development Kit for Gear authors:

- **`@meridian/gear-sdk`**: TypeScript package providing:
  - Type definitions for `GearManifest`, `GearContext`, `GearAction`, and all related types.
  - `MockGearContext`: A test implementation of `GearContext` with injectable responses
    (mock filesystem, mock fetch with recorded responses, mock secrets, mock state store).
  - Factory functions for test fixtures (`createTestManifest()`, `createTestContext()`,
    `createTestParams()`).

- **`meridian gear init <name>`**: CLI scaffolding command that generates a new Gear project
  with manifest template, entry point, test file, and (if Container Gear) a Dockerfile.

- **`meridian gear validate <path>`**: Validates a Gear manifest for correctness:
  - All required fields present
  - Permission declarations are well-formed (valid glob patterns, valid domain names)
  - Action parameter schemas are valid JSON Schema
  - Checksum matches package contents
  - Warns about overly broad permissions (e.g., `filesystem.read: ["**/*"]`)

- **`meridian gear test <path>`**: Runs a Gear's tests in a sandbox environment that mimics
  production constraints. Tests that pass locally but would fail in production due to
  undeclared permissions are caught here.

#### 13.6.2 Journal-Generated Gear Validation

Before Journal-generated Gear is presented to the user for review, it goes through automated
validation:

1. **Manifest validation**: Same checks as `meridian gear validate`.
2. **Smoke test execution**: The Synthesizer generates at least one smoke test per action.
   These tests run in the sandbox. A Gear that fails its smoke tests is not surfaced to
   the user.
3. **Permission minimality check**: Verify that the generated manifest does not request
   permissions beyond what the constituent Gear (in composition Gear) already have.
4. **Iteration on failure**: If validation fails, the Synthesizer gets one retry with the
   error details. If the retry also fails, the Gear is recorded as a failed synthesis
   attempt in Journal (for future reflection) and is not presented to the user.

Users reviewing Journal-generated Gear in Bridge see: the manifest (permissions summary in
plain language), the test results (pass/fail with output), and a "view source" option for
users who want to inspect the code.
```

---

## Patch 10: Expand Built-in Gear Set

**Severity**: Medium
**Review Finding**: #10 — The Built-in Gear Set
**Target Section**: 5.6.5 (Built-in Gear)

### Rationale

The current 6 built-in Gear (file-manager, web-search, web-fetch, shell, scheduler, notification) cover basic primitives but leave gaps for common automation tasks. The bootstrap strategy via `shell` Gear + Sentinel Memory progressive autonomy is viable but creates a poor first-run experience. Adding 3 more Gear covering core automation primitives improves the out-of-box experience while staying true to the "thin platform" principle. The reviewer notes that domain-specific integrations (calendar, email, smart home) are correctly left to user-installed or Journal-generated Gear.

### Changes

**5.6.5 — Amend the built-in Gear table:**

| Gear | Purpose | Risk Level |
|------|---------|------------|
| `file-manager` | Read, write, list, and organize files in the workspace | Medium |
| `web-search` | Search the web using a privacy-respecting engine (SearXNG or similar) | Low |
| `web-fetch` | Fetch and parse web page content | Low |
| `http-api` | Make authenticated REST/GraphQL API calls with retry, pagination, and structured error handling. Uses secret injection for auth tokens. | Medium |
| `code-runner` | Execute JavaScript/TypeScript code snippets in an isolated V8 sandbox. Distinct from `shell` — runs in a controlled environment, not the host shell. | Medium |
| `data-transform` | Parse, filter, transform, and aggregate structured data (CSV, JSON, XML). Includes basic statistical operations. | Low |
| `shell` | Execute shell commands (requires explicit user approval per-command) | Critical |
| `scheduler` | Create, update, and delete scheduled jobs | Medium |
| `notification` | Send notifications through Bridge | Low |

**5.6.5 — Amend the paragraph after the table:**

Current:
> This small set provides the primitive capabilities from which Journal can build more complex Gear. For example, Journal might combine `web-fetch` + `file-manager` into an `rss-digest` Gear that fetches feeds, filters articles, and saves summaries.

Proposed:
> This set provides the primitive capabilities from which Journal can build more complex Gear. For example, Journal might combine `web-fetch` + `data-transform` + `file-manager` into an `rss-digest` Gear that fetches feeds, filters articles, and saves summaries. The three additions over the minimal set (`http-api`, `code-runner`, `data-transform`) were chosen because they are automation primitives that appear in nearly every workflow — API integration, data processing, and computation. Domain-specific integrations (calendar, email, smart home, git) are left to user-installed or Journal-generated Gear.

---

## Patch 11: Gear Dependency Management

**Severity**: Medium
**Review Finding**: #11 — Gear Dependency Management
**Target Section**: 5.6 (Gear) — add new subsection 5.6.7

### Rationale

The reviewer identifies that Gear dependency management is mentioned in passing (OWASP section mentions "dependency lockfiles") but is never specified. Key open questions: how are npm dependencies installed, shared vs isolated node_modules, vulnerability tracking responsibility, Journal-generated Gear dependencies, transitive dependency attacks, and size constraints on resource-limited devices.

### Changes

**Add Section 5.6.7 after 5.6.6:**

```markdown
#### 5.6.7 Gear Dependency Management

**Bundling as the default model:**

Gear is distributed as a single-file bundle with all dependencies inlined. At build time
(during `meridian gear build` or as part of Gear installation from a registry), Gear code
and its dependencies are bundled using `esbuild` into a single JavaScript file. This
eliminates the `node_modules` problem entirely:

- No shared vs. isolated dependency conflicts
- No disk bloat from duplicated node_modules across Gear
- No transitive dependency attack surface at runtime (vulnerable dependency code is
  inlined and audited at build time, not resolved at runtime)
- Predictable disk usage: a bundled Gear is typically 100KB–5MB, vs. 50–500MB for a
  node_modules tree

**For Container Gear (Python, etc.):** Dependencies are installed during Docker image build
and cached in the image layer. Each Gear has an isolated dependency set inside its container.
`pip freeze` output (or equivalent) is stored as a lockfile in the Gear package for
reproducibility and auditing.

**Dependency declaration:**

Gear authors declare dependencies in a `dependencies` field in the manifest (not a separate
package.json). Meridian's build tooling resolves and bundles these at build time:

```typescript
  // In GearManifest
  dependencies?: {
    npm?: Record<string, string>;     // e.g., { "cheerio": "^1.0.0" }
    python?: Record<string, string>;  // e.g., { "pandas": ">=2.0" } (Container Gear only)
  };
```

**Vulnerability scanning:**

- At Gear installation time, Meridian runs `npm audit` (or the equivalent for other
  languages) against the declared dependencies and alerts the user about known
  vulnerabilities before activation.
- Meridian periodically (weekly, configurable) re-audits installed Gear dependencies
  and notifies the user via Bridge if new CVEs are discovered.
- Gear from the official registry must pass automated vulnerability scanning as part
  of the submission process.

**Journal-generated Gear dependency policy:**

In v1, Journal-generated Gear is restricted to:
- Node.js built-in APIs (`fs`, `path`, `url`, `crypto`, etc.)
- Libraries already available in the sandbox runtime (the MCP SDK, JSON schema
  validation)
- Tool calls to other existing Gear via MCP (the composition model from Section 5.4.3.1)

No dynamic dependency installation. This restriction ensures Journal-generated Gear cannot
introduce unvetted supply chain dependencies. The restriction will be relaxed in future
versions with a curated dependency allowlist.

**Size constraints:**

On resource-constrained devices (Raspberry Pi with 32GB storage), Meridian tracks total
Gear disk usage and warns when it exceeds 2GB. The bundled-file model makes this manageable
— typical usage of 20-30 active Gear consumes 200-400MB of disk.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | MCP-first Gear architecture | Critical | 5.6.2, 9.3, 9.4 |
| 2 | Tool use translation layer | Critical | 5.2.4 (new 5.2.4.1) |
| 3 | Explicit plan dependencies (DAG) | Critical | 5.2.2, 5.1.3 |
| 4 | Reliability consolidation | Critical | New 5.7, 4.5, 5.1.1 |
| 5 | Replanning context and convergence | High | 5.3.4, new 5.7.6 |
| 6 | GearContext API expansion | High | 9.3, 5.6.2 |
| 7 | Multi-language Gear via MCP | High | 5.6.3 (new 5.6.3.1) |
| 8 | Heartbeat and long-running tasks | Medium | 5.6.2, 5.1.3, 5.1.5 |
| 9 | Gear Developer Kit | Medium | New 13.6, 5.6.4 |
| 10 | Expand built-in Gear set | Medium | 5.6.5 |
| 11 | Gear dependency management | Medium | New 5.6.7 |

### Cross-References with AI Researcher Patches

Several patches from this review interact with patches from the `ai-researcher-patch.md`:

| This Patch | AI Researcher Patch | Interaction |
|-----------|-------------------|-------------|
| #1 (MCP-first) | #1 (Gear Synthesizer scope) | Compatible. Synthesizer generates MCP servers instead of custom code. The composition-only restriction from the researcher patch applies to MCP server generation. |
| #4 (Reliability) | #11 (Plan pre-validation) | Overlapping. Both add plan pre-validation. This patch's Section 5.7 subsumes the researcher's Patch 11. Apply one or the other. |
| #6 (GearContext expansion) | #1 (Gear Synthesizer scope) | Compatible. New GearContext methods are available to all Gear but do not affect the Synthesizer's v1 composition-only restriction. |
| #9 (Gear Developer Kit) | #1 (Gear Synthesizer scope) | Compatible. The GDK's validation pipeline is referenced in both the researcher's Synthesizer smoke testing and this patch's Section 13.6.2. |
| #2 (Tool use translation) | #10 (Provider capabilities) | Complementary. The researcher's provider capability declarations inform the translation layer's adapter selection. Apply both. |
