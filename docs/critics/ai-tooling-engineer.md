# Critical Review: Meridian Architecture Document

## Reviewer Profile

**Perspective**: Senior AI tooling engineer with production experience building LLM agent systems, tool-use frameworks, and plugin architectures (LangChain, AutoGPT, OpenDevin, custom enterprise agent platforms).

**Date**: 2026-02-07
**Document Reviewed**: `docs/architecture.md` v1.2

---

## Executive Summary

Meridian's architecture document is unusually thorough for a project that has zero lines of code. The security posture is genuinely best-in-class for the self-hosted agent space, and the Sentinel information barrier is a sound design that most projects never even attempt. The dual-LLM trust boundary is the strongest architectural decision in the document.

That said, the document has a pattern I have seen repeatedly in ambitious agent projects: it spends significant rigor on security and comparatively less on the operational mechanics of actually running an autonomous agent reliably. The architecture is well-defended against adversaries but could be more explicit about defending against the agent itself making bad decisions, getting stuck, or wasting resources in ways that are technically "safe" but functionally useless. The document does address reliability across several sections (graceful degradation in 4.4, fault tolerance in 5.1.5, the circuit breaker, crash recovery, and watchdog mechanisms), but these are distributed rather than consolidated, and some operational gaps remain.

Below are 12 areas of concern, ordered by severity.

---

## 1. MCP Compatibility Gap: Gear Should Be Built MCP-First

**Severity**: HIGH -- Strategic Risk

**Section**: 9.4

The document addresses MCP in Section 9.4 (API Design) and acknowledges it "should inform Gear API design decisions to avoid future incompatibility." This is not relegated to future considerations -- it is in the active API design section. However, the treatment is still insufficient for how important MCP has become. MCP is not emerging as a standard -- it has already emerged. By the time Meridian ships, the MCP ecosystem will have hundreds of production servers covering most of the tool integrations Meridian would need: email, calendars, databases, file systems, APIs, smart home devices, code execution, and more.

**The core problem**: Meridian is designing a custom plugin execution format (GearContext API, custom sandbox protocol) that partially overlaps with what MCP standardizes for tool discovery and invocation. The Gear manifest itself serves a purpose MCP does not -- sandboxing, permission enforcement, secret injection, resource limits, provenance tracking, and audit logging -- but the tool invocation path duplicates MCP unnecessarily. Every hour spent building a custom tool execution SDK is an hour not spent on what actually differentiates Meridian (the dual-LLM trust boundary, the Journal learning system, the security model).

**What I have seen in practice**: Every project that invents its own tool/plugin protocol ends up either (a) building an MCP adapter layer anyway, which becomes the primary way tools are consumed, making the native format vestigial, or (b) having a tiny plugin ecosystem because authors do not want to learn yet another format.

**Specific concerns**:

- The `GearAction` interface maps closely to MCP's tool definitions, with different field names but similar semantics.
- The adapter idea ("MCP-server-as-Gear") sounds simple but is not. MCP servers have their own lifecycle, transport requirements (stdio, SSE, HTTP), and state management that do not fit cleanly into the "spawn a sandbox, run, destroy" model described in Section 5.6.3.

**What Gear adds over MCP**: To be clear, the Gear layer is not a pure duplication. MCP defines a transport and tool schema protocol but provides no sandboxing, no permission manifests, no resource limits, no secret injection, no audit logging, and no provenance tracking. The `GearManifest` fields like `permissions`, `resources`, `origin`, `draft`, `signature`, and `checksum` have no MCP equivalent. These are genuine value-adds that justify Gear's existence as a security layer.

**Recommendation**: Make Gear the Meridian security/permission wrapper around MCP servers. The Gear manifest becomes a permission manifest that wraps an MCP server. The Meridian-specific security layer (permission enforcement, secret injection, audit logging, resource limits) sits between Scout's MCP tool calls and the actual MCP server. The MCP server handles the tool execution; Meridian handles the trust boundary. This gives you the entire MCP ecosystem on day one, and your differentiation (Sentinel validation, sandboxing, permission manifests) layers on top rather than replacing the standard.

The Journal Gear Synthesizer can still work -- it would generate MCP servers instead of custom Gear code. The manifest format stays, but as a security overlay, not a tool definition format.

---

## 2. Tool Use Format: The Missing Translation Layer

**Severity**: HIGH -- Architectural Gap

**Sections**: 5.2.2, 5.2.4

The `ExecutionPlan`/`ExecutionStep` format is a custom structured output that Scout must produce. But every LLM provider has its own tool-use/function-calling format:

- Anthropic uses `tool_use` content blocks with `tool_name`, `input` (JSON)
- OpenAI uses `tool_calls` with `function.name`, `function.arguments` (JSON string)
- Google uses `functionCall` with `name`, `args`
- Ollama models vary widely in their tool-calling support and format

The architecture describes an `LLMProvider` interface (Section 5.2.4) with a generic `chat()` method, but there is no description of how Scout's prompt engineering works to get these different providers to output a consistent `ExecutionPlan` structure. This is not a trivial problem.

**What actually happens in practice**: You end up with one of two approaches:

1. **Structured output via tool-use**: You define your `ExecutionPlan` as a tool schema and let the LLM's native tool-use format produce it. This works but means your plan format is constrained by what tool-use schemas can express (no nested conditional logic, limited expressiveness).

2. **Structured output via JSON mode**: You instruct the LLM to output raw JSON matching your schema. This is fragile, model-dependent, and requires extensive validation/retry logic.

Neither approach is described. The document assumes Scout will just produce valid `ExecutionPlan` JSON, but does not specify the mechanism.

**Clarification on the execution model**: To be precise about how the architecture works: Scout produces plans during the planning phase; Scout does not call Gear during execution. Axis dispatches to Gear based on the plan (Section 5.1.6: "Axis does not make decisions about *what* to do. It follows plans from Scout, approved by Sentinel"). The translation question is therefore specifically about how different LLM providers produce the `ExecutionPlan` structure during planning, not about runtime tool invocation.

**Recommendation**: Add a section explicitly describing the tool-use translation layer. Likely this lives in the Scout package as a set of provider-specific adapters that:
1. Convert the Gear catalog into provider-native tool schemas
2. Parse provider-native tool-call outputs into `ExecutionStep` objects
3. Handle provider-specific quirks (OpenAI's stringified JSON, Anthropic's content blocks, etc.)

Consider using the Vercel AI SDK or a similar abstraction that already handles multi-provider tool-use normalization, rather than building this from scratch.

---

## 3. Multi-Step Plan Execution: Plans Need Explicit Dependencies

**Severity**: HIGH -- Design Limitation

**Sections**: 5.2.2, 5.1.3

The `ExecutionPlan` is defined as `steps: ExecutionStep[]` -- a flat list. The document mentions `parallelGroup` and `order` as free-form fields that Scout "can include when relevant," and Section 5.1.3 notes that "Scout can mark steps as parallelizable" and "Axis dispatches parallel steps concurrently, respecting the overall worker limit." This provides a basic parallel execution model, but the dependency semantics are under-specified for what is the core execution model of the entire system.

**Real-world plans often need more than flat ordering**:

- **Dependencies**: Step 3 needs the output of Step 1 as input. Step 4 needs outputs from both Step 2 and Step 3. This is a DAG, not a list.
- **Conditional branches**: "If the file exists, update it. If not, create it." This requires branching logic in the plan.
- **Dynamic step generation**: "Search the web, and for each result, fetch the page and extract data." The number of steps is not known at planning time.

The architecture's approach to complexity is through `createSubJob` in the GearContext API, which delegates sub-tasks through the full Scout -> Sentinel pipeline. This is a deliberate design choice that preserves the security model -- every sub-plan gets Sentinel validation. For a security-first platform, this tradeoff is intentional and defensible. However, it does add latency for complex workflows, and the base plan format should still support explicit step dependencies.

**What I have seen fail**: Projects that start with flat step lists always end up bolting on DAG execution later, and the retrofit is painful because the plan format was not designed for it.

**Recommendation**: Make `dependencies` a required field on `ExecutionStep`:

```typescript
interface ExecutionStep {
  id: string;
  gear: string;
  action: string;
  parameters: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  dependencies: string[];  // IDs of steps that must complete before this one
  [key: string]: unknown;
}
```

Axis computes the execution graph from the `dependencies` field and runs steps in maximal parallelism. This is compatible with the loose schema principle -- `dependencies` becomes a required field (like `id`, `gear`, `action`, `parameters`, `riskLevel`), while conditional branching and loops remain expressible through `createSubJob` or future free-form control-flow fields. This keeps the plan format structured enough for Axis to execute deterministically while leaving room for the architecture to evolve.

---

## 4. Replanning Loops: The "Max 3 Iterations" Needs Refinement

**Severity**: HIGH -- Reliability Risk

**Section**: 5.3.4

The approval flow diagram shows "Scout revises plan (max 3 iterations)" when Sentinel returns `NEEDS_REVISION`. This raises several concerns:

**Important context on Sentinel's role**: Sentinel evaluates plans against five specific categories (Section 5.3.2): security, privacy, financial, ethical, and legal. Sentinel does not evaluate whether a plan will accomplish the user's task effectively -- that is Scout's job. This means the classic "oscillation" scenario (validator says "too risky," then "won't work") is unlikely because Sentinel's feedback is always about safety, not effectiveness. The more realistic failure mode is that Sentinel repeatedly flags the same safety concern that Scout cannot resolve without fundamentally changing the approach.

**Degradation under revision**: There is no mechanism to ensure Plan N+1 is better than Plan N. In practice, LLMs under pressure to revise often produce plans that are either identical (ignoring the revision feedback), strictly worse (removing necessary steps to appease the validator), or wildly different (abandoning the original approach entirely).

**Missing context**: When Scout revises, what context does it receive? The document does not specify whether Scout sees:
- Sentinel's specific revision feedback
- The rejected plan
- All previous rejected plans (to avoid repeating them)

Without this, Scout is revising without clear direction.

**Cost implications**: Each iteration costs a Scout LLM call + a Sentinel LLM call. Three iterations means up to 6 LLM calls for a single task. The architecture does address cost concerns extensively in Section 5.3.7 -- fast path skips Sentinel, adaptive model selection reduces costs 30-50%, Sentinel Memory auto-approves previously approved patterns, and caching handles repeated scheduled tasks. But the cost of contentious plan revisions specifically is not mitigated by these measures.

**Post-failure behavior**: The approval flow diagram does specify the outcome: `REJECTED → Job fails with explanation / User notified via Bridge`. This is clear, but the user experience of receiving "your task failed after 3 revision attempts" without actionable guidance on how to rephrase or decompose the request could be improved.

**Recommendation**:
1. Include Sentinel's revision feedback in Scout's revision context, along with all previously rejected plans.
2. Add a "revision strategy" that escalates: first iteration tries minor modifications, second iteration tries a fundamentally different approach, third iteration asks the user for guidance rather than failing silently.
3. Track plan similarity across revisions -- if Plan N+1 is >90% similar to a previously rejected plan, do not bother sending it to Sentinel again.
4. Consider letting Sentinel provide structured feedback (specific steps to modify or remove) rather than just a verdict, so Scout has clear revision targets.

---

## 5. GearContext Capabilities: Consider Expanding the API Surface

**Severity**: MEDIUM-HIGH -- Capability Gap

**Section**: 9.3

The GearContext API provides: `params`, `getSecret`, `readFile`, `writeFile`, `listFiles`, `fetch`, `log`, `progress`, `createSubJob`. That is nine methods.

**Existing capabilities worth noting**: The architecture does provide authentication building blocks that are easy to overlook. `getSecret(name)` combined with `fetch()` provides auth token injection -- a Gear can retrieve an API key or OAuth token from the secret store and include it in fetch headers. This is not a pre-built "authenticated HTTP client" but the primitives are there. Similarly, the `permissions.environment` field in the manifest declares environment variables the Gear reads, providing some environment awareness.

**What is missing that real-world automations need**:

| Missing Capability | Use Case | Current Workaround |
|---|---|---|
| **Database access** | Query a user's local Postgres/MySQL/SQLite | None. Cannot connect to databases. |
| **Higher-level HTTP** | REST API calls with pagination, retry, rate limiting | `getSecret()` + `fetch()` covers auth, but no pagination/retry primitives |
| **WebSocket/SSE** | Subscribe to real-time feeds | Not possible |
| **IPC / local services** | Talk to local daemons (Docker, systemd, Ollama) | None. Cannot open sockets. |
| **Timers / delays** | Wait between API calls for rate limiting | None. No `setTimeout`/`sleep` equivalent. |
| **Temporary state** | Store intermediate results across steps | Must write to filesystem. No in-memory key-value store. |
| **Event emission** | Notify Axis of interesting events mid-execution | Only `log` and `progress`. No structured event emission. |
| **Child process** | Run a local CLI tool (ffmpeg, imagemagick, git) | Must use `shell` Gear via `createSubJob`, which goes through full pipeline |

**The shell Gear and progressive autonomy**: The document acknowledges that `shell` Gear exists for running commands and requires "explicit user approval per-command" (Section 5.6.5). The critic's instinct might be that this makes the system a perpetual approval queue, but Section 5.3.8 (Sentinel Memory) directly addresses this. When a user approves `git push origin*`, that decision is stored and auto-approves future matching commands. The same applies to any repeated shell pattern. This creates a progressive autonomy model: the first time a novel command is run, the user approves; subsequent invocations are auto-approved based on precedent. The initial experience is approval-heavy, but it improves with use. Whether this ramp-up period is acceptable for first-time users is a UX question worth considering.

**Recommendation**: Expand GearContext with at least:
- `exec(command, args, opts)` -- run a declared command (from an allowlist in the manifest, not arbitrary shell). This is different from the shell Gear; it is a controlled command execution within the Gear's own sandbox.
- `sleep(ms)` -- basic delay for rate limiting
- `emit(event, data)` -- structured event emission to Axis
- `getState(key)` / `setState(key, value)` -- ephemeral key-value store scoped to the current job

For database access and IPC, consider making these declarable capabilities in the manifest (similar to `network.domains` but for `databases` and `sockets`) rather than trying to add them all to GearContext directly.

---

## 6. Gear Language Support: Formalize the Container Path

**Severity**: MEDIUM-HIGH -- Ecosystem Limitation

**Sections**: 5.6.3, 14.1

The architecture describes two levels of sandboxing (Section 5.6.3):

- **Level 1: Process Isolation (Default)**: Uses `isolated-vm` for V8 isolates, `seccomp` on Linux, sandbox profiles on macOS. This level is effectively JavaScript/TypeScript only.
- **Level 2: Container Isolation (Recommended)**: Docker containers with dedicated container per execution, read-only root filesystem, filtered network. This level can run any language runtime.

The two-tier model is already in the architecture, which is good. However, Level 2 is described as the "recommended" path for deployments with Docker, not as the primary mechanism for multi-language Gear. The gap is not that multi-language support is impossible -- it is that it is not formalized as a first-class development path.

**The problem**: Many of the automations Meridian targets are better expressed in other languages:
- **Python**: ML/AI tasks, data analysis, scientific computing, the vast majority of automation libraries
- **Shell scripts**: System administration, file processing, quick glue code
- **Go/Rust**: High-performance networking, system-level automation

The Python gap is particularly painful. The entire AI/ML ecosystem is Python-first. If someone wants a Gear that uses `pandas` to analyze a CSV, or `beautifulsoup` to scrape a website, they would need to use Container Gear -- but there is no documented SDK, template, or guide for building Container Gear in Python.

**What MCP solves here**: MCP servers can be written in any language. If Gear were MCP wrappers (see Point 1), this problem largely evaporates. A Python MCP server is just a Python process that speaks MCP protocol. Meridian's contribution is the permission manifest and sandbox enforcement around it, not the execution runtime.

**Recommendation**: Either adopt MCP as the primary tool protocol (which solves this) or formalize Container Gear as a first-class development path with:
- A documented SDK for Python (and potentially other languages)
- A `GearContext`-equivalent API for non-JS runtimes (likely via stdin/stdout JSON protocol)
- Container base images with the GearContext API pre-wired
- Examples and templates for Python, Shell, and Node.js Container Gear

---

## 7. Error Handling in Plans: The Replanning Context Problem

**Severity**: MEDIUM-HIGH -- Reliability Gap

**Sections**: 4.5 (Step 9), 5.4.4

The document says: "If a step fails, Axis routes back to Scout for replanning using a potentially different approach or Gear." This is one sentence describing what is actually the hardest problem in multi-step agent execution.

**What Scout needs to replan effectively**:
1. The original user request
2. The original plan
3. Which steps succeeded, with their results
4. Which step failed, with the full error (stack trace, HTTP status, stderr output)
5. The state of the world after partial execution (files created, API calls made, etc.)
6. What Gear is available as alternatives
7. Whether the partial results are recoverable or whether the whole plan needs to restart

**What the document specifies**: The Job model (Section 5.1.2) stores `plan_json`, `result_json`, and `error_json`, and the free-form `[key: string]: unknown` allows attaching step-level results. But the document does not describe how this information is assembled and presented to Scout during replanning.

**Real-world failure modes I have seen**:
- Scout replans from scratch, ignoring that steps 1-2 already created files, leading to duplicate files or conflicting state.
- Scout cannot see the error from step 3, so it produces the exact same plan, which fails the same way.
- Partial execution left the system in an inconsistent state (half-written file, partial API transaction) that neither the old plan nor the new plan accounts for.

**The rollback question**: The `ExecutionStep` can include a free-form `rollback` field. The architecture does not say Axis automatically executes this field -- it is informational metadata that Scout includes "when relevant" under the loose schema principle. This is fine as long as the implementation is clear about whether rollback is (a) guidance for Scout during replanning, or (b) instructions Axis can act on. If the latter, rollback instructions would need Sentinel validation, which the architecture does not describe.

**Recommendation**:
1. Define the exact context bundle that accompanies a replanning request (all 7 items above).
2. Add a `StepResult` type that captures success/failure/partial results for each completed step, and include the array of `StepResult`s in the replanning context.
3. Clarify the role of the `rollback` field: is it guidance for Scout, or executable by Axis? If executable, route rollback plans through Sentinel.
4. Consider a "compensation" model rather than rollback: when replanning, Scout must account for the side effects of already-executed steps in its new plan. This aligns better with the loose schema principle -- Scout is best positioned to reason about partial state, not Axis.

---

## 8. Streaming and Long-Running Tasks: The Timeout and Heartbeat Gap

**Severity**: MEDIUM -- Operational Limitation

**Sections**: 5.6.2, 9.3

The default Gear timeout is 300,000ms (5 minutes), configurable per-Gear via the manifest's `resources.timeoutMs` and per-job via the job-level `timeout_ms` configuration (Section 10.4). There is no hard-coded maximum -- timeouts are fully configurable. But many real-world tasks take much longer:

- Downloading a large file: minutes to hours
- Running a build/compile: 5-30 minutes for non-trivial projects
- Web scraping a large site: 30+ minutes
- Video processing: potentially hours

The `progress(percent, message)` method in GearContext suggests awareness of this. The architecture also supports concurrent job execution (Section 5.1.3: configurable worker pool with 2-8 workers), so users can continue interacting with the system while long tasks run, and Bridge provides a job queue/status sidebar (Section 5.5.2). However, the architecture does not address:

1. **How does Axis distinguish "still working" from "stuck"?** A Gear that has not called `progress()` in 10 minutes -- is it processing a large file or is it deadlocked? There is no heartbeat mechanism. The watchdog described in Section 5.1.5 monitors Axis's own event loop responsiveness, but not individual Gear execution health.
2. **Can timeouts be extended dynamically?** If a Gear realizes it needs more time than declared, can it request an extension?
3. **Resource contention**: A 30-minute job on a 2-worker Raspberry Pi means 50% of capacity is consumed for the entire duration. Section 5.1.3 mentions backpressure for queue depth but does not differentiate scheduling for long-running vs. short-lived tasks.

**Recommendation**:
1. Add a heartbeat mechanism: Gear must call `progress()` or `heartbeat()` at least once every N seconds (configurable, default 60). If the deadline passes without a heartbeat, Axis warns the user and optionally terminates the Gear.
2. Allow Gear to declare expected duration ranges in their manifest (`estimatedDurationMs: { min, max }`), so Axis can schedule appropriately.
3. Consider a long-running job queue separate from the regular queue, with its own worker allocation, so long tasks do not starve short ones.
4. Define a "background job" pattern where the Gear returns a handle immediately and the result is delivered asynchronously via notification.

---

## 9. Testing Gear: Where Is the Developer Experience?

**Severity**: MEDIUM -- Ecosystem Risk

**Section**: 13.1

The testing strategy section mentions "unit tests for sandboxing" and "Gear sandbox enforcement is tested with intentionally malicious Gear," but this is about testing Meridian's sandbox, not about testing Gear themselves.

If you want a healthy Gear ecosystem (whether built-in, user-contributed, or Journal-generated), Gear authors need:

1. **A Gear development kit (GDK)**: A CLI tool or library that scaffolds a new Gear project, provides type definitions for `GearContext`, and includes a local test harness.
2. **A local sandbox emulator**: So Gear authors can test their code in an environment that mimics the production sandbox without needing a full Meridian installation running.
3. **Mock GearContext**: A testing utility that provides a mock implementation of `GearContext` with injectable responses (mock filesystem, mock fetch, mock secrets).
4. **Integration test runner**: A way to test a Gear against a real (but isolated) Meridian instance to verify manifest permissions, sandbox compliance, and end-to-end behavior.
5. **Manifest validator**: A CLI tool that validates a Gear manifest for correctness, completeness, and security best practices.

**For Journal-generated Gear specifically**: The Gear Synthesizer produces code and a manifest. The architecture says Journal-generated Gear goes "through the same security pipeline as all other Gear" and is "flagged for user review" before activation (Section 5.6.4). But the gap is validation between generation and user review: how is the generated code tested before presentation? Does Journal run it in a test sandbox? What if it generates code with syntax errors or runtime exceptions? Most users are not going to read source code. They need the system to validate it first.

**Recommendation**: Design the Gear development kit as part of the v1 architecture, not as an afterthought. At minimum:
- `@meridian/gear-sdk`: TypeScript types + mock GearContext for testing
- `meridian gear test <path>`: Run a Gear's tests in a sandbox
- `meridian gear validate <path>`: Check manifest, lint code, verify sandbox compliance
- For Journal-generated Gear: automated test execution before presenting to user. If the generated code fails its own tests, Journal should iterate (not dump broken code on the user).

---

## 10. The Built-in Gear Set: Balancing Minimalism with Usability

**Severity**: MEDIUM -- Capability Gap

**Section**: 5.6.5

The built-in set is: `file-manager`, `web-search`, `web-fetch`, `shell`, `scheduler`, `notification`. Six Gear total. The architecture's Core Principle 6 ("Progressive capability") explicitly states the system "starts minimal and grows its abilities based on what the user actually needs, not what it ships with." This is philosophically coherent with the "thin platform, thick capabilities" principle. But let me compare against the use cases from the idea document:

| Use Case (from idea.md) | Needed Gear | Available? |
|---|---|---|
| "Managing your calendar" | Calendar API integration (Google, Outlook) | No (but buildable via `shell` or Journal) |
| "Draft emails" | Email sending (SMTP, Gmail API) | No (but buildable via `shell` or Journal) |
| "Automating workflows" | HTTP API caller (REST with auth) | Partial (`web-fetch` + `getSecret()` covers auth, but no pagination/retry) |
| "Controlling smart home devices" | Home Assistant / MQTT integration | No |
| "Building software projects" | Git operations, code execution | Via `shell` with Sentinel Memory progressive autonomy |
| "Gathering research" | `web-search` + `web-fetch` | Yes |
| "Data analysis" | CSV/JSON parsing, computation | No (no data processing Gear) |
| "Graphic design" | Image manipulation | No (aspirational use case) |
| "Video editing" | Video processing | No (aspirational use case) |

**The bootstrap mechanism**: The architecture's bootstrap strategy is `shell` Gear combined with Sentinel Memory (Section 5.3.8). When a user first asks to run `git commit`, they approve the shell command. Sentinel Memory stores `{ actionType: "shell.execute", scope: "git commit*", verdict: "allow" }` and auto-approves future matching commands. Over time, Journal observes these patterns and can synthesize dedicated Gear (e.g., a `git` Gear) to replace the shell workaround. This is a viable progressive autonomy model, but the initial "approval-heavy" period will be frustrating for users who expect the system to work out of the box for common tasks.

**Missing from the built-in set that would improve first-run experience**:
- `http-api`: Make authenticated REST/GraphQL API calls with secret injection, pagination, retry. While `web-fetch` + `getSecret()` covers basic auth, a dedicated Gear for API interaction would provide better retry logic, pagination handling, and structured error responses.
- `code-runner`: Execute code snippets in a sandbox (JavaScript/Python). Distinct from `shell` because the code runs in a controlled environment, not the host shell.
- `data-transform`: Parse, filter, transform structured data (CSV, JSON, XML). Essential for any automation pipeline.

**Recommendation**: Consider expanding the built-in set to 8-10 Gear covering the most common automation primitives. The philosophy of "ship minimal, grow through Journal" is sound in principle but risks a poor first-run experience. A modest expansion of built-in Gear can bootstrap the learning flywheel while staying true to the "thin platform" principle. Calendar, email, and smart home integrations are correctly left to user-installed or Journal-generated Gear -- those are domain-specific, not primitives.

---

## 11. Gear Dependency Management: The Unaddressed Supply Chain

**Severity**: MEDIUM -- Security/Operational Gap

**Sections**: 5.6, 6.2 (LLM03)

The document mentions "Dependency lockfiles: Gear dependencies are locked and audited" in the OWASP section, but does not describe how Gear dependencies actually work.

**Key questions left unanswered**:

1. **How are npm dependencies installed?** If a Gear needs `axios` or `cheerio`, where does the `npm install` happen? In the sandbox? Before sandboxing? In a build step?
2. **Shared vs. isolated node_modules**: Do Gear share a common set of dependencies, or does each Gear have its own `node_modules`? Isolated is safer but consumes massive disk on a Raspberry Pi. Shared creates dependency conflict risks.
3. **Vulnerability tracking**: Who is responsible for updating a Gear's dependencies when a CVE is published? The Gear author? Meridian's automated scanning? The user?
4. **Journal-generated Gear dependencies**: When Journal's Gear Synthesizer generates code, it might `import` packages that are not installed. How does the system resolve this? Does the Synthesizer output a `package.json`? Does it only use built-in Node.js APIs?
5. **Transitive dependency attacks**: A Gear declares `cheerio` as a dependency. `cheerio` depends on `parse5`, which has a malicious version published. The Gear manifest's `checksum` covers the Gear package (which may or may not include bundled dependencies -- this is unspecified).
6. **Size constraints**: On a 32GB Raspberry Pi SD card, how many Gear with their own `node_modules` can coexist before disk is exhausted?

**Recommendation**: Add a dedicated section on Gear dependency management. At minimum:
- Gear dependencies are declared in the manifest (not a separate `package.json`)
- Dependencies are installed in an isolated directory per Gear version
- Dependencies are checksum-locked (like `npm ci` with a lockfile)
- Meridian runs `npm audit` on Gear dependencies at install time and alerts on known vulnerabilities
- Journal-generated Gear is restricted to a curated allowlist of dependencies (or zero dependencies for v1)
- Consider using `esbuild` or `tsup` to bundle Gear into single files with all dependencies inlined, eliminating the `node_modules` problem entirely

---

## 12. Real-World Agent Failures: Consolidate the Reliability Story

**Severity**: HIGH -- Needs Consolidation

**Throughout document**

The architecture document addresses reliability across multiple distributed sections:
- Section 4.3: Fast path vs. full path for efficient routing
- Section 4.4: Graceful degradation table (6 failure scenarios with specific behaviors)
- Section 5.1.5: Fault tolerance (graceful shutdown, crash recovery, step-level retry, circuit breaker with 3-failure threshold, watchdog for event loop blocking)
- Section 5.2.2: Structured plan format (machine-parseable, validatable against schema)
- Section 5.2.5: Adaptive model selection for cost management
- Section 5.3.4: Approval flow with revision loop
- Section 5.3.8: Sentinel Memory for learning approval patterns
- Section 5.4.4: Gear Improvement Loop (learning from failures, always journaling failures)

This is more comprehensive than it first appears. However, the reliability content is scattered and there are specific operational gaps that are not addressed.

**The top failure modes in production agent systems, ranked by frequency**:

1. **Tool selection errors**: The agent picks the wrong tool for the job. Scout selects `web-fetch` when it should use a dedicated API Gear. Scout tries to use a Gear that does not support the required action.
2. **Parameter hallucination**: The agent invents parameters that do not exist in the tool schema. Scout generates `{ "format": "xlsx" }` for a Gear that only supports `"csv"` and `"json"`. The architecture partially addresses this -- Gear actions declare parameter schemas via `parameters: JSONSchema` (Section 5.6.2), and Section 6.2 (LLM05) says "Gear parameters are validated against their declared JSON Schema before being passed to execution." This provides structural validation but does not catch semantically invalid parameters.
3. **Context window management**: In multi-turn conversations, the agent loses track of what it already did or what the user asked for. The architecture addresses this with a configurable context window (default 20 messages, Section 5.2.3) augmented by semantic search from Journal (top-k=5 relevant memories) and keyword search via FTS5. The retrieval-augmented approach extends effective context beyond the raw message window, but whether this is sufficient for complex multi-step workflows is an open question.
4. **Infinite elaboration**: The agent keeps "improving" its plan without ever executing it. This is especially common with revision loops.
5. **Premature completion**: The agent declares success when the task is only partially done.
6. **Cascading failures**: Step 1 produces slightly wrong output. Step 2 uses it. By Step 5, the result is completely wrong, but no individual step "failed."
7. **Resource waste loops**: The agent retries the same failing approach repeatedly, consuming API credits without making progress. The circuit breaker (Section 5.1.5) mitigates this for Gear-level failures (3 consecutive failures within 5 minutes disables the Gear), but does not cover plan-level retries that use different Gear each time.

**What the architecture is missing**:

- **Output validation beyond schema**: Gear actions declare `returns: JSONSchema`, which provides structural validation. But there is no semantic validation -- a Gear that returns `{ success: true, data: null }` passes schema validation but may represent a functional failure.
- **Plan quality heuristics**: Is there any check on Scout's plan quality before sending to Sentinel? Plans that are clearly incomplete (no steps), reference non-existent Gear, or have mismatched parameter types should be caught before consuming a Sentinel call. Section 6.2 (LLM05) says "Plans that don't conform to the schema are rejected" but this is about format, not quality.
- **Progress monitoring**: For multi-step plans, is there a check that the overall task is making progress toward the user's goal? Or does Axis just execute steps mechanically?
- **Cost-aware planning**: Scout needs to know how much budget remains before producing a plan that will cost more than is available. Section 11.1 tracks costs and enforces limits, but does not describe feeding remaining budget into Scout's planning context.
- **Completion verification**: After execution, is the result checked against the original request? The Journal reflection pipeline (Section 5.4.3) analyzes "Did the task succeed or fail? Why?" but this runs asynchronously after the response. For the current interaction, the user has no indication of whether the system believes it succeeded.

**Recommendation**: Consolidate the reliability story into a dedicated section (or at minimum, add a cross-reference table). Specifically:
1. **Output validators**: Axis should validate Gear outputs against their declared return schemas (already partially there) and flag suspicious outputs (null data, empty results) for Scout review.
2. **Plan validators**: Before Sentinel review, Axis runs basic structural validation on plans (no empty steps, all referenced Gear exist and are enabled, all parameters match schemas).
3. **Progress watchdog**: Axis monitors multi-step execution and intervenes if progress stalls (configurable thresholds).
4. **Cost-aware planning**: Scout is told the remaining daily budget as part of its context and must produce plans within budget.
5. **Completion verification**: After execution, Scout (using the secondary model for cost savings) reviews the result against the original request and determines if the task is actually done, before the response is sent to the user.
6. **Graceful degradation for bad plans**: Instead of failing the entire job after 3 Sentinel rejections, offer the user a simplified version of the task or ask for clarification about what is acceptable.

---

## Summary of Recommendations by Priority

### Must-Fix Before Implementation

| # | Issue | Severity | Core Action |
|---|---|---|---|
| 1 | MCP Compatibility | HIGH | Redesign Gear as security wrappers around MCP servers |
| 2 | Tool Use Translation | HIGH | Define the provider-to-plan translation layer |
| 3 | Plan Dependencies | HIGH | Make dependencies a required field on ExecutionStep |
| 12 | Reliability Consolidation | HIGH | Consolidate scattered reliability content; add output validation, plan validation, completion verification |

### Should-Fix Before Beta

| # | Issue | Severity | Core Action |
|---|---|---|---|
| 4 | Replanning Loops | HIGH | Define revision context, add convergence detection, escalate to user |
| 5 | GearContext API | MEDIUM-HIGH | Expand with exec, sleep, emit, state methods |
| 6 | Language Support | MEDIUM-HIGH | Formalize Container Gear SDK for Python, or adopt MCP |
| 7 | Error Context | MEDIUM-HIGH | Define StepResult type and replanning context bundle |
| 10 | Built-in Gear Set | MEDIUM | Expand to 8-10 covering core automation primitives |

### Should-Fix Before GA

| # | Issue | Severity | Core Action |
|---|---|---|---|
| 8 | Long-Running Tasks | MEDIUM | Add heartbeat, background job pattern, duration estimates |
| 9 | Gear Developer Experience | MEDIUM | Ship a Gear SDK, test harness, and manifest validator |
| 11 | Dependency Management | MEDIUM | Define dependency resolution, bundling, and vulnerability tracking |

---

## Final Thoughts

Meridian's architecture has the right instincts on security and the dual-LLM trust boundary is a genuinely good idea that I wish more projects would adopt. The Journal learning system is ambitious and, if it works, would be a real differentiator. The Sentinel Memory system for progressive autonomy is a thoughtful design that bridges the gap between security and usability in a way most agent platforms do not attempt.

The architecture is more complete on reliability than it first appears -- fault tolerance, circuit breakers, graceful degradation, and the watchdog mechanism are all present. But these are scattered across sections, making the reliability story hard to assess holistically. Consolidating these into a coherent narrative and filling the remaining gaps (output validation, plan quality checks, completion verification) would significantly strengthen the document.

The single highest-leverage change would be embracing MCP as the tool protocol while keeping Gear as the security/permission layer on top. This solves the tool-use translation problem, the language limitation, and gives Meridian access to the growing MCP ecosystem on day one. Meridian's genuine differentiators -- Sentinel validation, sandboxing, permission manifests, secret injection, audit logging, and Journal's Gear Synthesizer -- all layer cleanly on top of MCP rather than competing with it.

The second highest-leverage change would be consolidating and extending the reliability engineering story. The building blocks are largely in place; they need to be connected into a coherent end-to-end reliability model with explicit output validation, plan quality checks, and completion verification.
