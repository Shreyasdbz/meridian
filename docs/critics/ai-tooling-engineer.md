# Critical Review: Meridian Architecture Document

## Reviewer Profile

**Perspective**: Senior AI tooling engineer with production experience building LLM agent systems, tool-use frameworks, and plugin architectures (LangChain, AutoGPT, OpenDevin, custom enterprise agent platforms).

**Date**: 2026-02-07
**Document Reviewed**: `docs/architecture.md` v1.2

---

## Executive Summary

Meridian's architecture document is unusually thorough for a project that has zero lines of code. The security posture is genuinely best-in-class for the self-hosted agent space, and the Sentinel information barrier is a sound design that most projects never even attempt. The dual-LLM trust boundary is the strongest architectural decision in the document.

That said, the document has a pattern I have seen repeatedly in ambitious agent projects: it spends 80% of its rigor on security (which is the easy part to reason about statically) and 20% on the operational mechanics of actually running an autonomous agent reliably (which is where every production agent system actually breaks). The architecture is well-defended against adversaries but under-defended against the agent itself making bad decisions, getting stuck, or wasting resources in ways that are technically "safe" but functionally useless.

Below are 12 areas of concern, ordered by severity.

---

## 1. MCP Compatibility Gap: Gear Should Probably Just Be MCP

**Severity**: HIGH -- Strategic Risk

**Section**: 9.4

The document treats MCP compatibility as a "future consideration" with hand-wavy bullet points about adapters and wrappers. This is a strategic error. MCP is not emerging as a standard -- it has already emerged. By the time Meridian ships, the MCP ecosystem will have hundreds of production servers covering most of the tool integrations Meridian would need: email, calendars, databases, file systems, APIs, smart home devices, code execution, and more.

**The core problem**: Meridian is designing a custom plugin format (Gear manifests, GearContext API, custom sandbox protocol) that duplicates what MCP already standardizes. Every hour spent building a Gear SDK is an hour not spent on what actually differentiates Meridian (the dual-LLM trust boundary, the Journal learning system, the security model).

**What I have seen in practice**: Every project that invents its own tool/plugin protocol ends up either (a) building an MCP adapter layer anyway, which becomes the primary way tools are consumed, making the native format vestigial, or (b) having a tiny plugin ecosystem because authors do not want to learn yet another format.

**Specific concerns**:

- The `GearContext` API (Section 9.3) is essentially a subset of what MCP servers already provide, but with incompatible interfaces.
- The `GearManifest` format (Section 5.6.2) reinvents MCP's tool schema declaration, but with a different JSON structure.
- The `GearAction` interface maps almost 1:1 to MCP's tool definitions, just with different field names.
- The adapter idea ("MCP-server-as-Gear") sounds simple but is not. MCP servers have their own lifecycle, transport requirements (stdio, SSE, HTTP), and state management that do not fit cleanly into the "spawn a sandbox, run, destroy" model described in Section 5.6.3.

**Recommendation**: Make Gear the Meridian security/permission wrapper around MCP servers. The Gear manifest becomes a permission manifest that wraps an MCP server. The GearContext API becomes the Meridian-specific security layer (permission enforcement, secret injection, audit logging) that sits between Scout's MCP tool calls and the actual MCP server. The MCP server handles the tool execution; Meridian handles the trust boundary. This gives you the entire MCP ecosystem on day one, and your differentiation (Sentinel validation, sandboxing, permission manifests) layers on top rather than replacing the standard.

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

**Additional gap**: When Scout uses tool-use to call Gear during plan execution, how does that work? The `ExecutionStep` specifies `gear` and `action` and `parameters`, but this is not in the format any LLM provider's tool-use protocol expects. Who translates between the LLM's native tool-calling format and the `ExecutionStep` format? Is it Scout's prompt? Is it a translation layer in Axis? This is completely unspecified.

**Recommendation**: Add a section explicitly describing the tool-use translation layer. Likely this lives in the Scout package as a set of provider-specific adapters that:
1. Convert the Gear catalog into provider-native tool schemas
2. Parse provider-native tool-call outputs into `ExecutionStep` objects
3. Handle provider-specific quirks (OpenAI's stringified JSON, Anthropic's content blocks, etc.)

Consider using the Vercel AI SDK or a similar abstraction that already handles multi-provider tool-use normalization, rather than building this from scratch.

---

## 3. Multi-Step Plan Execution: Plans Are Not Lists, They Are DAGs

**Severity**: HIGH -- Design Limitation

**Sections**: 5.2.2, 5.1.3

The `ExecutionPlan` is defined as `steps: ExecutionStep[]` -- a flat list. The document mentions `parallelGroup` and `order` as free-form fields that Scout "can include when relevant." This is dangerously under-specified for what is the core execution model of the entire system.

**Real-world plans are not lists**:

- **Dependencies**: Step 3 needs the output of Step 1 as input. Step 4 needs outputs from both Step 2 and Step 3. This is a DAG, not a list.
- **Conditional branches**: "If the file exists, update it. If not, create it." This requires branching logic in the plan.
- **Loops**: "For each file in the directory, run this transformation." This requires iteration.
- **Dynamic step generation**: "Search the web, and for each result, fetch the page and extract data." The number of steps is not known at planning time.
- **Error-specific branching**: "If Step 2 fails with a 404, try Step 2b. If it fails with a 500, retry 3 times."

The architecture punts on all of this by making `parallelGroup` and `order` free-form fields. But Axis is the executor -- it needs to understand dependencies to know what can run in parallel and what must wait. If these fields are free-form, Axis cannot reliably execute plans.

**What I have seen fail**: Projects that start with flat step lists always end up bolting on DAG execution later, and the retrofit is painful because the plan format was not designed for it. The alternative -- having Scout break complex tasks into multiple sub-plans and using `createSubJob` -- adds massive latency (each sub-plan goes through the full Scout -> Sentinel pipeline).

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

Axis computes the execution graph from the `dependencies` field and runs steps in maximal parallelism. For conditional branches and loops, define a small set of control-flow step types (`conditional`, `forEach`, `retry`) rather than leaving it to free-form fields. This keeps the plan format structured enough for Axis to execute deterministically while giving Scout the ability to express non-trivial workflows.

---

## 4. Replanning Loops: The "Max 3 Iterations" Time Bomb

**Severity**: HIGH -- Reliability Risk

**Section**: 5.3.4

The approval flow diagram shows "Scout revises plan (max 3 iterations)" when Sentinel returns `NEEDS_REVISION`. This raises several serious concerns:

**Oscillation**: Scout produces Plan A. Sentinel says "too risky, revise." Scout produces Plan B (more conservative). Sentinel says "this won't accomplish the task, revise." Scout produces Plan C, which looks like Plan A again. I have seen this exact loop in production agent systems. The max-3 limit is a blunt instrument that does not solve the underlying problem.

**Degradation under revision**: There is no mechanism to ensure Plan N+1 is better than Plan N. In practice, LLMs under pressure to revise often produce plans that are either identical (ignoring the revision feedback), strictly worse (removing necessary steps to appease the validator), or wildly different (abandoning the original approach entirely). The document assumes revision converges toward an acceptable plan, but there is no convergence guarantee.

**Missing context**: When Scout revises, what context does it receive? The document does not specify whether Scout sees:
- Sentinel's specific revision feedback
- The rejected plan
- All previous rejected plans (to avoid repeating them)
- A diff of what Sentinel objected to

Without this, Scout is revising blind.

**Cost explosion**: Each iteration costs a Scout LLM call + a Sentinel LLM call. Three iterations means up to 6 LLM calls for a single task before it either succeeds or fails entirely. On a budget-constrained deployment with cost caps, this can exhaust the daily budget on a single contentious task.

**What is missing**: What happens after the third iteration? The document implies the job fails, but it does not say whether the user is asked to intervene, whether the task is abandoned, or whether there is a fallback. "Job fails with explanation" is not great UX for "set up my email automation" -- the user needs to understand what to do differently.

**Recommendation**:
1. Include Sentinel's revision feedback in Scout's revision context, along with all previously rejected plans.
2. Add a "revision strategy" that escalates: first iteration tries minor modifications, second iteration tries a fundamentally different approach, third iteration asks the user for guidance (not just fails).
3. Track plan similarity across revisions -- if Plan N+1 is >90% similar to a previously rejected plan, do not bother sending it to Sentinel again.
4. Consider letting Sentinel provide "minimum viable changes" rather than just pass/fail -- e.g., "remove step 3 and this plan is acceptable."

---

## 5. GearContext Limitations: The API Is Too Thin

**Severity**: MEDIUM-HIGH -- Capability Gap

**Section**: 9.3

The GearContext API provides: `params`, `getSecret`, `readFile`, `writeFile`, `listFiles`, `fetch`, `log`, `progress`, `createSubJob`. That is nine methods. Let me list what is missing that real-world automations need:

| Missing Capability | Use Case | Current Workaround |
|---|---|---|
| **Database access** | Query a user's local Postgres/MySQL/SQLite | None. Cannot connect to databases. |
| **Structured HTTP** | Make REST API calls with auth headers, pagination, retry | `fetch` exists but has no built-in auth token injection, pagination, or retry |
| **WebSocket/SSE** | Subscribe to real-time feeds | Not possible |
| **IPC / local services** | Talk to local daemons (Docker, systemd, Ollama) | None. Cannot open sockets. |
| **Timers / delays** | Wait between API calls for rate limiting | None. No `setTimeout`/`sleep` equivalent. |
| **Environment info** | Check OS, architecture, available tools | None. Gear is blind to its environment. |
| **Temporary state** | Store intermediate results across steps | Must write to filesystem. No in-memory key-value store. |
| **Event emission** | Notify Axis of interesting events mid-execution | Only `log` and `progress`. No structured event emission. |
| **Child process** | Run a local CLI tool (ffmpeg, imagemagick, git) | Must use `shell` Gear via `createSubJob`, which goes through full pipeline |
| **Stdin/Stdout streaming** | Pipe data between tools | Not possible |

**The shell Gear problem**: The document acknowledges that `shell` Gear exists for running commands, but it requires "explicit user approval per-command." In practice, most useful automations eventually need to run CLI tools. If every `git commit` or `ffmpeg -i` call requires user approval, the system is not autonomous -- it is a very elaborate command approval queue.

**Recommendation**: Expand GearContext with at least:
- `exec(command, args, opts)` -- run a declared command (from an allowlist in the manifest, not arbitrary shell). This is different from the shell Gear; it is a controlled command execution within the Gear's own sandbox.
- `sleep(ms)` -- basic delay for rate limiting
- `getEnv()` -- return declared environment variables
- `emit(event, data)` -- structured event emission to Axis
- `getState(key)` / `setState(key, value)` -- ephemeral key-value store scoped to the current job

For database access and IPC, consider making these declarable capabilities in the manifest (similar to `network.domains` but for `databases` and `sockets`) rather than trying to add them all to GearContext directly.

---

## 6. Gear Language Limitation: JavaScript-Only Is a Serious Constraint

**Severity**: MEDIUM-HIGH -- Ecosystem Limitation

**Sections**: 5.6.3, 14.1

The document specifies `isolated-vm` for process-level sandboxing and implies Gear is JavaScript/TypeScript (running in V8 isolates). This is never explicitly stated but is clearly implied by the technology choices.

**The problem**: Many of the automations Meridian targets are better expressed in other languages:
- **Python**: ML/AI tasks, data analysis, scientific computing, the vast majority of automation libraries
- **Shell scripts**: System administration, file processing, quick glue code
- **Go/Rust**: High-performance networking, system-level automation

The Python gap is particularly painful. The entire AI/ML ecosystem is Python-first. If someone wants a Gear that uses `pandas` to analyze a CSV, or `requests` + `beautifulsoup` to scrape a website, or `Pillow` to process images, they cannot write it in the Gear framework. They would need the `shell` Gear to call Python, which (a) goes through the full approval pipeline and (b) has no sandbox guarantees.

**What MCP solves here**: MCP servers can be written in any language. If Gear were MCP wrappers (see Point 1), this problem evaporates. A Python MCP server is just a Python process that speaks MCP protocol. Meridian's contribution is the permission manifest and sandbox enforcement around it, not the execution runtime.

**If you keep the custom Gear format**: Consider a two-tier model:
1. **Native Gear** (TypeScript, `isolated-vm`): For lightweight, security-critical built-in operations. Fast to start, strong sandbox guarantees.
2. **Container Gear** (any language, Docker): For user/community/Journal Gear that needs other runtimes. The Docker container model already supports this -- you just need to formalize it as a first-class path rather than an afterthought.

**Recommendation**: Either adopt MCP as the primary tool protocol (which solves this) or explicitly design Container Gear as a first-class citizen with its own SDK for at least Python, with the same manifest format and permission model.

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

**What the document specifies**: Nothing. "Routes back to Scout for replanning" with no indication of what context accompanies the replanning request.

**Real-world failure modes I have seen**:
- Scout replans from scratch, ignoring that steps 1-2 already created files, leading to duplicate files or conflicting state.
- Scout cannot see the error from step 3, so it produces the exact same plan, which fails the same way.
- Scout sees the error but misinterprets it, producing a plan that is broken in a different way.
- Partial execution left the system in an inconsistent state (half-written file, partial API transaction) that neither the old plan nor the new plan accounts for.

**The rollback question**: The `ExecutionStep` has a free-form `rollback` field. But rollback is not free-form -- it requires specific, tested logic. If step 3 fails after step 2 wrote a file and step 1 made an API call, what gets rolled back? Who decides? If Scout decides, its rollback plan also needs Sentinel validation, adding another round-trip. If Axis auto-rolls-back based on the `rollback` field, it is executing LLM-generated rollback instructions without validation, which violates the security model.

**Recommendation**:
1. Define the exact context bundle that accompanies a replanning request (all 7 items above).
2. Add a `StepResult` type that captures success/failure/partial results for each completed step, and include the array of `StepResult`s in the replanning context.
3. For rollback, do not make it free-form. Either (a) make rollback a separate plan that goes through Sentinel, or (b) limit rollback to predefined safe operations (delete created files, nothing else) that Axis can execute without LLM involvement.
4. Consider a "compensation" model rather than rollback: when replanning, Scout must account for the side effects of already-executed steps in its new plan.

---

## 8. Streaming and Long-Running Tasks: The 5-Minute Timeout Problem

**Severity**: MEDIUM -- Operational Limitation

**Sections**: 5.6.2, 9.3

The default Gear timeout is 300,000ms (5 minutes). The maximum is not specified. But many real-world tasks take much longer:

- Downloading a large file: minutes to hours
- Running a build/compile: 5-30 minutes for non-trivial projects
- Web scraping a large site: 30+ minutes
- Video processing: potentially hours
- Long-running data analysis: variable

The `progress(percent, message)` method in GearContext suggests awareness of this, but the architecture does not address:

1. **How does Axis distinguish "still working" from "stuck"?** A Gear that has not called `progress()` in 10 minutes -- is it processing a large file or is it deadlocked? There is no heartbeat mechanism.
2. **Can timeouts be extended dynamically?** If a Gear realizes it needs more time than declared, can it request an extension?
3. **What happens to the user experience during a 30-minute Gear execution?** The Bridge WebSocket presumably shows "executing..." for 30 minutes. Is there a way for the user to check detailed progress? Cancel mid-execution? Interact with the system while a long-running job is in progress?
4. **Resource contention**: A 30-minute job on a 2-worker Raspberry Pi means 50% of capacity is consumed for the entire duration. The architecture mentions backpressure but does not address long-running job scheduling.

**Recommendation**:
1. Add a heartbeat mechanism: Gear must call `progress()` or `heartbeat()` at least once every N seconds (configurable, default 60). If the deadline passes without a heartbeat, Axis warns the user and optionally terminates the Gear.
2. Allow Gear to declare expected duration ranges in their manifest (`estimatedDurationMs: { min, max }`), so Axis can schedule appropriately.
3. Add a long-running job queue that is separate from the regular queue, with its own worker allocation, so long tasks do not starve short ones.
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

**For Journal-generated Gear specifically**: The Gear Synthesizer produces code and a manifest. How is this code tested before it is presented to the user as a draft? Does Journal run the generated Gear in a test sandbox? What if it generates code with syntax errors or runtime exceptions? The document says the Gear is "flagged for user review," but most users are not going to read JavaScript source code. They need the system to validate it first.

**Recommendation**: Design the Gear development kit as part of the v1 architecture, not as an afterthought. At minimum:
- `@meridian/gear-sdk`: TypeScript types + mock GearContext for testing
- `meridian gear test <path>`: Run a Gear's tests in a sandbox
- `meridian gear validate <path>`: Check manifest, lint code, verify sandbox compliance
- For Journal-generated Gear: automated test execution before presenting to user. If the generated code fails its own tests, Journal should iterate (not dump broken code on the user).

---

## 10. The Built-in Gear Set: Missing Critical Primitives

**Severity**: MEDIUM -- Capability Gap

**Section**: 5.6.5

The built-in set is: `file-manager`, `web-search`, `web-fetch`, `shell`, `scheduler`, `notification`. Six Gear total. Let me compare this to what users will need for the use cases described in the idea document:

| Use Case (from idea.md) | Needed Gear | Available? |
|---|---|---|
| "Managing your calendar" | Calendar API integration (Google, Outlook) | No |
| "Draft emails" | Email sending (SMTP, Gmail API) | No |
| "Automating workflows" | HTTP API caller (REST with auth) | Partial (`web-fetch`, but no auth injection) |
| "Controlling smart home devices" | Home Assistant / MQTT integration | No |
| "Building software projects" | Git operations, code execution | Only via `shell` (requires per-command approval) |
| "Gathering research" | `web-search` + `web-fetch` | Yes |
| "Data analysis" | CSV/JSON parsing, computation | No (no data processing Gear) |
| "Graphic design" | Image manipulation | No |
| "Video editing" | Video processing | No |

The philosophy of "Journal will build what's needed" is interesting but relies on a bootstrap problem: Journal needs successful task completions to learn from, but the system cannot complete tasks it does not have Gear for. The initial Gear set needs to be sufficient for the most common use cases to get the learning flywheel spinning.

**The `shell` Gear as an escape hatch**: In practice, `shell` will become the most-used Gear because it can do everything else. But every invocation requires user approval, making the system a glorified `sudo` prompt. This will be the number one source of user frustration.

**Missing from the built-in set**:
- `http-api`: Make authenticated REST/GraphQL API calls (with secret injection, pagination, retry). This is different from `web-fetch` which is for scraping web pages.
- `code-runner`: Execute code snippets in a sandbox (JavaScript/Python). Distinct from `shell` because the code runs in a controlled environment, not the host shell.
- `data-transform`: Parse, filter, transform structured data (CSV, JSON, XML). Essential for any automation pipeline.
- `email`: Send/receive email. Listed as a core use case in the idea doc.
- `git`: Git operations with built-in safety (no force push, no credential exposure). Much safer than going through `shell` for every `git` command.

**Recommendation**: Expand the built-in set to at least 10-12 Gear covering the core use cases. The philosophy of "ship minimal, grow through Journal" sounds elegant but will result in a terrible first-run experience where the system cannot do anything useful without the user hand-approving dozens of shell commands so that Journal can learn.

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
5. **Transitive dependency attacks**: A Gear declares `cheerio` as a dependency. `cheerio` depends on `parse5`, which has a malicious version published. The Gear manifest's `checksum` covers the Gear code but not its `node_modules` tree.
6. **Size constraints**: On a 32GB Raspberry Pi SD card, how many Gear with their own `node_modules` can coexist before disk is exhausted?

**Recommendation**: Add a dedicated section on Gear dependency management. At minimum:
- Gear dependencies are declared in the manifest (not a separate `package.json`)
- Dependencies are installed in an isolated directory per Gear version
- Dependencies are checksum-locked (like `npm ci` with a lockfile)
- Meridian runs `npm audit` on Gear dependencies at install time and alerts on known vulnerabilities
- Journal-generated Gear is restricted to a curated allowlist of dependencies (or zero dependencies for v1)
- Consider using `esbuild` or `tsup` to bundle Gear into single files with all dependencies inlined, eliminating the `node_modules` problem entirely

---

## 12. Real-World Agent Failures: The Reliability Gap

**Severity**: HIGH -- The Silent Killer

**Throughout document**

The architecture document spends approximately 2,500 words on security (Sections 6.1-6.6) and approximately 200 words on what happens when the agent simply makes bad decisions. This ratio is inverted from what matters in practice.

**The top failure modes in production agent systems, ranked by frequency**:

1. **Tool selection errors**: The agent picks the wrong tool for the job. Scout selects `web-fetch` when it should use `http-api`. Scout tries to use a Gear that does not support the required action.
2. **Parameter hallucination**: The agent invents parameters that do not exist in the tool schema. Scout generates `{ "format": "xlsx" }` for a Gear that only supports `"csv"` and `"json"`.
3. **Context window amnesia**: In multi-turn conversations, the agent loses track of what it already did or what the user asked for. The 20-message window (Section 5.2.3) is aggressively small for complex workflows.
4. **Infinite elaboration**: The agent keeps "improving" its plan without ever executing it. This is especially common with the revision loop.
5. **Premature completion**: The agent declares success when the task is only partially done. "I've created the file" when the file exists but is empty.
6. **Cascading failures**: Step 1 produces slightly wrong output. Step 2 uses it. Step 3 uses Step 2's output. By Step 5, the result is completely wrong, but no individual step "failed."
7. **Resource waste loops**: The agent retries the same failing approach repeatedly, consuming API credits without making progress. The max-3 retry in Sentinel helps but does not cover Gear-level retries.

**What the architecture is missing**:

- **Output validation**: After a Gear executes, who validates that the output is correct? Axis checks if Gear returned without error, but does not check if the result makes sense. A Gear that returns `{ success: true, data: null }` is treated as success.
- **Plan quality heuristics**: Is there any check on Scout's plan quality before sending to Sentinel? Plans that are clearly incomplete (no steps), circular (step A depends on step B depends on step A), or nonsensical should be caught before consuming a Sentinel call.
- **Progress monitoring**: For multi-step plans, is there a check that the overall task is making progress toward the user's goal? Or does Axis just execute steps mechanically?
- **Token budget awareness**: Scout needs to know how much budget remains before producing a plan that will cost more than is available.
- **Stuck detection**: If a job has been in `executing` state for 10x its expected duration with no progress updates, the system should proactively intervene.
- **User satisfaction signal**: After a task completes, does the system check if the user is satisfied? Or does it assume success? The Journal reflection is an offline process -- it does not help with the current interaction.

**Recommendation**: Add a "reliability engineering" section that is as detailed as the security section. Specifically:
1. **Output validators**: Axis should validate Gear outputs against their declared return schemas. Outputs that do not match are treated as failures.
2. **Plan validators**: Before Sentinel review, Axis runs basic structural validation on plans (no empty steps, no circular dependencies, all referenced Gear exist, all parameters match schemas).
3. **Progress watchdog**: Axis monitors multi-step execution and intervenes if progress stalls (configurable thresholds).
4. **Cost-aware planning**: Scout is told the remaining daily budget and must produce plans within budget.
5. **Completion verification**: After execution, Scout (using the secondary model for cost savings) reviews the result against the original request and determines if the task is actually done.
6. **Graceful degradation for bad plans**: Instead of failing the entire job after 3 Sentinel rejections, offer the user a simplified version of the task or ask for clarification about what is acceptable.

---

## Summary of Recommendations by Priority

### Must-Fix Before Implementation

| # | Issue | Severity | Core Action |
|---|---|---|---|
| 1 | MCP Compatibility | HIGH | Redesign Gear as security wrappers around MCP servers |
| 2 | Tool Use Translation | HIGH | Define the provider-to-plan translation layer |
| 3 | Plan DAG Execution | HIGH | Make dependencies a required field; add control-flow step types |
| 12 | Reliability Engineering | HIGH | Add output validation, plan validation, progress monitoring, completion verification |

### Should-Fix Before Beta

| # | Issue | Severity | Core Action |
|---|---|---|---|
| 4 | Replanning Loops | HIGH | Define revision context, add convergence detection, escalate to user |
| 5 | GearContext API | MEDIUM-HIGH | Expand with exec, sleep, env, emit, state methods |
| 6 | Language Limitation | MEDIUM-HIGH | Formalize Container Gear or adopt MCP |
| 7 | Error Context | MEDIUM-HIGH | Define StepResult type and replanning context bundle |
| 10 | Built-in Gear Set | MEDIUM | Expand to 10-12 covering core use cases |

### Should-Fix Before GA

| # | Issue | Severity | Core Action |
|---|---|---|---|
| 8 | Long-Running Tasks | MEDIUM | Add heartbeat, background job pattern, duration estimates |
| 9 | Gear Developer Experience | MEDIUM | Ship a Gear SDK, test harness, and manifest validator |
| 11 | Dependency Management | MEDIUM | Define dependency resolution, bundling, and vulnerability tracking |

---

## Final Thoughts

Meridian's architecture has the right instincts on security and the dual-LLM trust boundary is a genuinely good idea that I wish more projects would adopt. The Journal learning system is ambitious and, if it works, would be a real differentiator.

But the document reads like it was written by someone who has thought deeply about "how do I prevent bad things from happening" and less about "how do I make good things happen reliably." The former is table stakes; the latter is what determines whether anyone actually uses the product.

The single highest-leverage change would be embracing MCP as the tool protocol. It solves problems 1, 2, 6, and partially 5 and 10 in one architectural decision, and it aligns Meridian with the direction the entire ecosystem is moving. Every month Meridian spends building a custom Gear format is a month its competitors spend building on top of a growing MCP ecosystem.

The second highest-leverage change would be taking the reliability problem as seriously as the security problem. Build the agent watchdog. Validate outputs. Detect stuck states. Verify completion. These are the things that will determine whether Meridian is a toy demo or a production-grade system.
