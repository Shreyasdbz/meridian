# Architecture Patches: AI/ML Researcher Review

> **Source**: `docs/critics/ai-researcher.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Scope Down Gear Synthesizer for v1

**Severity**: Critical
**Review Finding**: #3 — Gear Synthesizer Feasibility
**Target Section**: 5.4.3 (Reflection & Gear Building Pipeline)

### Rationale

The reviewer rates Gear Synthesizer as the highest-risk component. LLM code generation success rates for complete, self-contained plugins with correct manifests, error handling, and sandbox compliance are uncertain. Additionally, generated Gear has no automated testing, the improvement loop is under-specified, and dependency management is absent. The recommendation is to scope down aggressively for v1: limit to composing existing built-in Gear into workflows rather than generating arbitrary code.

### Changes

**5.4.3 — After the "When does Journal NOT create a Gear?" list, add a new subsection:**

```markdown
#### 5.4.3.1 Gear Synthesizer Scope (v1)

For the initial release, the Gear Synthesizer is limited to **composition Gear** — plugins
that orchestrate sequences of existing built-in Gear actions. The Synthesizer does not generate
arbitrary code with external dependencies in v1.

**What the Synthesizer CAN do in v1:**

- Compose built-in Gear into multi-step workflows (e.g., `web-fetch` + `file-manager` →
  `rss-digest` Gear that fetches feeds and saves summaries).
- Parameterize existing Gear actions with learned defaults from procedural memory.
- Generate a declarative manifest with permissions derived from the composed Gear's existing
  permissions (union of constituent permissions).

**What the Synthesizer CANNOT do in v1:**

- Write arbitrary TypeScript/JavaScript with custom logic beyond control flow and data
  transformation between composed steps.
- Introduce new npm or system dependencies not already available in the sandbox.
- Generate Gear that requires network domains not already declared by constituent Gear.

**Testing generated Gear:**

The Synthesizer must produce at least one smoke test per action in the generated Gear. These
tests run in the sandbox before the Gear is presented to the user for review. A Gear that fails
its own smoke tests is not surfaced — instead, the failure is recorded in Journal for future
reflection.

**Iteration limits:**

The Gear Improvement Loop (Section 5.4.4) is bounded: a maximum of 3 improvement attempts per
Gear per triggering task, with a total token budget of 50,000 tokens across all attempts. If
the Synthesizer cannot produce a passing Gear within these bounds, it records the failure pattern
and does not retry until a materially different task triggers re-evaluation.

**Dependency policy:**

Synthesizer-generated Gear is restricted to Node.js built-in APIs and libraries already present
in the sandbox runtime. No dynamic dependency installation. This restriction will be relaxed
in future versions with a vetted dependency allowlist.
```

**5.4.3 — In the existing "When does Journal create a Gear?" list, amend the second bullet:**

Current:
> A task failed because no existing Gear could handle it, but Journal can see a pattern for how to solve it (e.g., user asked to resize images, no Gear exists → Journal writes a Gear using sharp/imagemagick).

Proposed:
> A task failed because no existing Gear could handle it, but Journal can see a pattern for solving it by composing existing Gear (e.g., user asked to fetch and summarize articles, no single Gear exists → Journal composes `web-fetch` + `file-manager` into an `article-digest` Gear). In v1, the Synthesizer cannot introduce external dependencies like sharp or imagemagick; such tasks are recorded as candidates for future manual Gear creation.

---

## Patch 2: Add Evaluation Framework

**Severity**: Critical
**Review Finding**: #11.1 — Missing Evaluation Framework
**Target Section**: 13 (Testing Strategy) — add new subsection 13.5

### Rationale

The architecture describes no systematic evaluation framework for LLM-dependent components. Without evaluation, there is no way to measure whether Scout plans well, Sentinel catches threats, the Reflector reflects accurately, or retrieval returns relevant results. The existing testing strategy (structural, behavioral, red-team, regression) is necessary but not sufficient for measuring LLM output quality.

### Changes

**Add Section 13.5 after Section 13.4:**

```markdown
### 13.5 LLM Output Evaluation Framework

Beyond structural and behavioral testing, Meridian requires an evaluation framework for
measuring the quality of LLM-dependent outputs over time. This framework is built alongside
the components it evaluates, not after.

#### 13.5.1 Evaluation Dimensions

| Component | Metric | Method |
|-----------|--------|--------|
| Scout (planning) | Plan validity rate | % of plans that pass schema validation and reference only existing Gear/actions |
| Scout (planning) | Plan acceptance rate | % of plans approved by Sentinel without revision |
| Scout (model selection) | Routing accuracy | % of secondary-model tasks that succeed without primary-model retry |
| Sentinel (safety) | True positive rate | % of known-dangerous plans correctly rejected (red-team suite) |
| Sentinel (safety) | False positive rate | % of known-safe plans incorrectly rejected |
| Reflector (memory) | Categorization accuracy | Sampled human evaluation of memory type assignments |
| Reflector (memory) | Causal accuracy | Agreement between Reflector's failure attribution and structured log evidence |
| Journal (retrieval) | Recall@5 | % of relevant memories in top-5 results for known query/memory pairs |
| Journal (retrieval) | MRR | Mean Reciprocal Rank across evaluation queries |
| Gear Synthesizer | First-attempt pass rate | % of generated Gear that passes its own smoke tests on first attempt |

#### 13.5.2 Evaluation Infrastructure

- **Benchmark suite**: A curated set of evaluation cases with graded difficulty, stored in
  `tests/evaluation/`. Includes known-good plans, known-dangerous plans, query/memory relevance
  pairs, and reflection input/output samples.
- **Automated evaluation**: Evaluation metrics run as part of CI on any change to Scout, Sentinel,
  Journal, or their prompt templates. Results are tracked over time.
- **Human evaluation sampling**: Periodically (configurable, default: weekly), the system surfaces
  a random sample of Reflector outputs and memory classifications for user review through Bridge.
  User corrections feed back into the benchmark suite.
- **A/B testing for prompts**: When prompt templates change, the evaluation suite runs against both
  the old and new prompts, and results are compared before the change is merged.

#### 13.5.3 Production Quality Tracking

In production, Meridian tracks per-task-type success rate over time. This "learning curve" metric
is visible in Bridge and provides empirical evidence of whether the system's adaptation is
improving outcomes. If success rate degrades for a task type, the system alerts the user.
```

---

## Patch 3: Multi-Tag Memory Classification

**Severity**: High
**Review Finding**: #1 — Memory Architecture Realism
**Target Section**: 5.4.2 (Memory Types) and 8.3 (Journal Database schema)

### Rationale

The tripartite memory classification forces single categorization, but real memories are often simultaneously episodic, semantic, and procedural. The reviewer recommends allowing multiple type tags. Additionally, confidence calibration is rudimentary (contradiction-only) and temporal dynamics lack a decay function.

### Changes

**5.4.2 — Add paragraph after the three memory type descriptions:**

```markdown
**Cross-type tagging:** Memories are not forced into a single category. A single insight
(e.g., "deploying to the production server requires SSH key auth because password auth is
disabled") can be tagged as both semantic (fact about the server) and procedural (step in
deployment workflow), with a link to the originating episode. The Reflector outputs a list of
applicable types per memory, and the storage layer creates entries in each relevant table with
cross-references.

**Confidence model:** Semantic facts use a multi-signal confidence score rather than simple
contradiction-based reduction:
- **Source count**: How many independent episodes support this fact.
- **Recency**: When was the fact last confirmed (explicit `lastConfirmedAt` timestamp).
- **User confirmations**: Explicit user validation via Bridge counts as a strong signal.
- **Temporal decay**: Facts that have not been confirmed within a configurable window
  (default: 90 days) have their effective confidence reduced by a decay factor when retrieved.
  The stored confidence is not modified — decay is applied at query time.

**Conflict resolution:** When new information contradicts an existing fact, the Reflector does
not immediately overwrite. Instead:
1. If the new information comes from a single episode with no user confirmation, the existing
   fact's confidence is reduced and the new fact is stored alongside it with low initial
   confidence.
2. If the user explicitly states the correction, the old fact is superseded immediately.
3. If multiple independent episodes support the new information, the old fact is superseded
   after a configurable threshold (default: 3 confirming episodes).
```

**8.3 — Journal Database schema, add a cross-reference table and update the `facts` table:**

```sql
-- Add to facts table
--   last_confirmed_at TEXT,         -- Explicit confirmation timestamp
--   source_count INTEGER DEFAULT 1, -- Number of supporting episodes
--   superseded_by TEXT REFERENCES facts(id), -- If replaced by newer fact

-- Cross-type memory links
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,           -- ID in source table
  source_type TEXT NOT NULL,         -- 'episodic' | 'semantic' | 'procedural'
  target_id TEXT NOT NULL,           -- ID in target table
  target_type TEXT NOT NULL,         -- 'episodic' | 'semantic' | 'procedural'
  created_at TEXT NOT NULL
);
```

---

## Patch 4: Strengthen Reflection Pipeline Against Confabulation

**Severity**: High
**Review Finding**: #2 — Reflection Pipeline Quality
**Target Section**: 5.4.3 (Reflection & Gear Building Pipeline)

### Rationale

LLM reflection routinely confabulates causal explanations for failures. The Reflector might blame a parsing error when the real cause was rate limiting. The reviewer recommends a two-phase approach: first extract structured facts from logs deterministically, then have the LLM do higher-level synthesis on verified facts.

### Changes

**5.4.3 — Replace the Reflector description in the diagram annotation with:**

```markdown
┌──────────────┐
│  Reflector   │  Two-phase reflection:
│              │
│  Phase 1:    │  Deterministic extraction from structured execution logs:
│  (no LLM)   │  - Exit codes, HTTP status codes, error messages
│              │  - Timing data (which steps were slow)
│              │  - Resource usage (tokens consumed, API calls made)
│              │  - Gear output schemas (did output match expected format?)
│              │
│  Phase 2:    │  LLM analysis on verified facts from Phase 1:
│  (LLM call)  │  1. Given these structured facts, what went wrong / right?
│              │  2. Are there new user/environment facts?
│              │  3. Are there reusable patterns worth remembering?
│              │  4. Does this contradict any existing memories?
│              │  5. Could a Gear be created or improved?
│              │  The LLM MUST NOT contradict Phase 1 facts. If the logs
│              │  show a 429 status code, the LLM cannot attribute failure
│              │  to an authentication error.
└──────┬───────┘
```

**5.4.3 — Add after the Reflector description:**

```markdown
**Reflection validation:** Phase 2 outputs are cross-checked against Phase 1 facts. If the
Reflector's causal attribution contradicts structured log evidence (e.g., claims "authentication
failure" when the log shows HTTP 429 Too Many Requests), the reflection is flagged as unreliable
and stored with reduced confidence. The structured facts from Phase 1 are always stored in the
episode record regardless of Phase 2 quality.

**Procedural memory demotion:** Procedures with a poor track record (failure ratio exceeding
a configurable threshold, default: 40% over the last 10 uses) are automatically demoted — they
are excluded from retrieval results and surfaced to the user for review in Bridge. Procedures
that are unused for a configurable period (default: 180 days) are archived.

**New procedures start at low confidence** and gain confidence only through repeated successful
application. A procedure must be applied successfully at least 3 times before it is retrieved
at full weight.
```

---

## Patch 5: Harden Information Barrier — Strip Free-Form Fields

**Severity**: High
**Review Finding**: #5 — Dual-LLM Safety Boundary (covert channels)
**Target Section**: 5.3.1 (Why Sentinel Must Be Separate) and 5.3.3 (Validation Response Format)

### Rationale

The execution plan's free-form fields (`[key: string]: unknown`) are a covert channel from Scout to Sentinel. A prompt-injected Scout can encode manipulative framing in fields like `reasoning` or `description`. The reviewer recommends stripping free-form fields before Sentinel sees the plan and adding composite-action analysis.

### Changes

**5.3.1 — Add after the information barrier table:**

```markdown
**Plan sanitization for Sentinel:** Before Axis sends a plan to Sentinel, it strips all
free-form fields from the `ExecutionPlan` and its `ExecutionStep` objects. Sentinel receives
only the required fields: `id`, `jobId`, `steps` (each containing only `id`, `gear`, `action`,
`parameters`, and `riskLevel`). This minimizes the information-theoretic channel between Scout
and Sentinel, preventing a compromised Scout from embedding persuasive framing in fields like
`reasoning` or `description`.

Scout's `riskLevel` assessment is included because Sentinel needs it for prioritization, but
Sentinel is instructed to perform its own independent risk assessment and not trust Scout's
label. If Sentinel's assessment diverges from Scout's by more than one level (e.g., Scout says
"low" but Sentinel determines "high"), this divergence is logged as an anomaly.

**Composite-action analysis:** Sentinel evaluates not just individual steps but the combined
effect of all steps in a plan. Patterns like "read credentials file then make external network
request" or "read sensitive file then write to a different location" are flagged regardless of
individual step risk levels. A deterministic pre-check runs before the LLM-based validation,
catching known-dangerous composite patterns without consuming an LLM call.
```

---

## Patch 6: Strengthen Prompt Injection Defenses

**Severity**: High
**Review Finding**: #6 — Prompt Injection Defense Reality
**Target Section**: 5.2.6 (Prompt Injection Defense)

### Rationale

The reviewer identifies three gaps: (1) delimiter-based tagging is a weak primary defense and should be explicitly labeled as a soft layer, (2) multi-hop injection through memory is unaddressed, (3) Gear output is a prompt injection vector with no sanitization.

### Changes

**5.2.6 — Add after the existing `<external_content>` example:**

```markdown
**Defense layering (explicit):** Content provenance tagging is a *soft* defense layer — it
reduces the attack surface but is not a security boundary. LLMs do not reliably respect
delimiter-based boundaries. The actual security boundaries are:

1. **Structured plan validation**: Plans must be valid JSON conforming to the `ExecutionPlan`
   schema. Free-form text from Scout is not executed.
2. **Sentinel's independent review**: Sentinel evaluates the plan without access to the
   original input, breaking the injection chain.
3. **Sandbox enforcement**: Even if a plan is approved, Gear cannot exceed declared permissions
   at runtime.

Content tagging provides defense-in-depth but should never be the sole control for any security
property.

**Gear output sanitization:** When Gear returns results to Axis, the results are sanitized
before being passed to Scout. The sanitization strips or escapes content that resembles system
prompts, XML/HTML instruction tags, or common prompt injection patterns (e.g., "ignore previous
instructions", "you are now", "system:"). This is pattern-based filtering — it reduces risk but
is not foolproof. The sanitized content is tagged with `source: "gear:<gear-id>"` provenance.

**Multi-hop injection defense:** The Reflector applies an instruction/data classifier before
writing to memory stores. Content that contains instruction-like patterns (imperative sentences
directed at an AI, system prompt fragments, role-play directives) is flagged and either:
- Stored with an `untrusted_instruction_content: true` tag, causing it to be excluded from
  Scout's retrieved context, or
- Stripped of instruction-like content while preserving factual information.

This prevents the attack pattern where malicious content is stored as a memory and later
retrieved as context that influences Scout's planning.
```

---

## Patch 7: Improve Retrieval Specification

**Severity**: Medium
**Review Finding**: #4 — Retrieval Quality
**Target Section**: 5.4.5 (Retrieval: Hybrid Search)

### Rationale

The retrieval system is under-specified in areas that determine quality: embedding model quality requirements, chunking strategy, temporal decay in scoring, and RRF parameters. The reviewer recommends explicit specification of these.

### Changes

**5.4.5 — Add after the existing description:**

```markdown
#### Retrieval Configuration

**Embedding model tiers:** Different deployment environments use different embedding models
with different quality characteristics. The system documents the expected retrieval quality
degradation per tier:

| Deployment | Embedding Model | Dimensions | Expected Retrieval Quality |
|------------|----------------|------------|---------------------------|
| VPS / Mac Mini | `nomic-embed-text` | 768 | Baseline (good) |
| Raspberry Pi | `all-MiniLM-L6-v2` | 384 | ~15-20% lower recall on nuanced queries |
| API-based | Provider embedding API | Varies | Comparable to baseline |

Users on constrained devices are informed of the quality tradeoff during setup and can opt
for API-based embedding if they prefer accuracy over privacy.

**Chunking strategy:** Each memory type uses a "one memory, one embedding" approach:
- Episodic: one embedding per episode summary (not per raw message).
- Semantic: one embedding per fact.
- Procedural: one embedding per procedure.

This avoids arbitrary chunking boundaries and ensures each embedding corresponds to a
semantically coherent unit.

**Temporal decay in scoring:** Retrieval scores incorporate recency:

```
final_score = rrf_score * temporal_weight(age)
```

Where `temporal_weight` returns 1.0 for memories updated within the last 7 days, decaying
logarithmically to a floor of 0.5 for the oldest memories. The decay parameters are
configurable. Temporal decay can be disabled per-query for tasks that explicitly need
historical context.

**RRF parameters:** Reciprocal Rank Fusion uses k=60 (standard) with equal weighting between
vector and FTS5 result lists as the default. These parameters are configurable and logged
per-query to enable tuning. During development, a retrieval evaluation harness (see Section
13.5) tracks MRR and Recall@k to inform parameter tuning.
```

---

## Patch 8: Simplify Adaptive Model Selection

**Severity**: Medium
**Review Finding**: #7 — Adaptive Model Selection
**Target Section**: 5.2.5 (Adaptive Model Selection)

### Rationale

Asking an LLM to assess task complexity for model routing is a meta-cognitive task where LLMs are poorly calibrated. The reviewer recommends starting with explicit task-type enumeration rather than LLM-based judgment, and adding an outcome-based feedback loop.

### Changes

**5.2.5 — Replace "Scout decides which model to use based on its assessment of the task complexity" with:**

```markdown
**Model routing strategy:** Rather than asking Scout to judge complexity (a meta-cognitive task
where LLMs are poorly calibrated), model selection is based on explicit task-type matching:

**Secondary model is used when:**
- The step involves a single Gear action with well-defined parameters (single-step dispatch).
- The step is summarization of content already retrieved.
- The step is parsing structured data from a known format.
- The step is generating Gear parameters for a Gear that has been successfully used before
  (based on procedural memory).

**Primary model is used for everything else**, including:
- Multi-step planning and decomposition.
- Replanning after failures.
- Novel or ambiguous requests.
- Any task where the secondary model has previously failed.

This enumerated approach avoids the meta-cognitive burden. The list of secondary-eligible task
types is maintained as configuration, not as an LLM judgment call.

**Outcome-based feedback:** When a secondary-model task fails and requires primary-model retry,
the task type and context are recorded. If a task type accumulates 3 secondary-model failures
within a 30-day window, it is automatically promoted to primary-model-only. This feedback loop
allows the system to learn which tasks genuinely require the primary model without relying on
LLM self-assessment.
```

**5.2.5 — Amend the cost impact paragraph:**

Current:
> For a typical usage pattern where ~60% of operations are simple Gear dispatches, adaptive model selection can reduce API costs by 30–50% without meaningful quality degradation on the simple tasks.

Proposed:
> **Cost impact (projected):** For usage patterns where a significant portion of operations are simple Gear dispatches, adaptive model selection can reduce API costs meaningfully. The actual savings depend on the user's task distribution — users who primarily do complex multi-step tasks will see less benefit. Cost savings are tracked and displayed in Bridge so users can evaluate whether the secondary model is pulling its weight.

---

## Patch 9: Dynamic Context Budgets

**Severity**: Medium
**Review Finding**: #8 — Context Window Management
**Target Section**: 11.1 (LLM API Optimization — Token Management)

### Rationale

Static context budgets are suboptimal — a research task needs more memory budget while a conversational task needs more conversation budget. The reviewer recommends dynamic allocation and per-tier recommended configurations.

### Changes

**11.1 — Replace the "Context window budgeting" bullet list with:**

```markdown
- **Context window budgeting**: Scout's context is assembled with dynamic token budgets that
  adapt to the task type:
  - System prompt: ~2,000 tokens (fixed)
  - Gear catalog: variable (included only for full-path tasks)
  - Total input budget: configurable per deployment tier (see below)
  - Remaining budget is split between recent conversation and retrieved memories. The split
    is dynamic: conversation-heavy tasks (multi-turn clarification) get up to 70% conversation /
    30% memory. Retrieval-heavy tasks (research, knowledge questions) get up to 30%
    conversation / 70% memory. Scout signals the expected task type, and Axis adjusts the
    split accordingly. Default (when uncertain): 60% conversation / 40% memory.

  **Recommended budgets per deployment tier:**

  | Tier | Total Input Budget | Rationale |
  |------|-------------------|-----------|
  | Raspberry Pi | 8,000 tokens | Cost and latency constrained |
  | Mac Mini / VPS | 16,000 tokens | Balanced |
  | Power user | 32,000+ tokens | User has large context budget with provider |

- **Rolling summary for long conversations**: When the conversation exceeds the conversation
  budget, older messages are summarized into a compressed representation (~500 tokens) rather
  than simply dropped. This preserves the gist of earlier conversation while freeing tokens
  for recent context. The summary is regenerated when the window slides.
```

---

## Patch 10: Expand LLM Provider Interface

**Severity**: Medium
**Review Finding**: #10 — LLM Provider Abstraction Leakiness
**Target Section**: 5.2.4 (LLM Provider Abstraction)

### Rationale

Tool use formats, structured output support, streaming behavior, and error semantics differ significantly across providers. The `LLMProvider` interface needs capability declarations so Scout can adapt its behavior per provider.

### Changes

**5.2.4 — Expand the `LLMProvider` interface:**

```typescript
interface LLMProvider {
  id: string;
  name: string;                          // "anthropic", "openai", "ollama", etc.
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  estimateTokens(text: string): number;
  maxContextTokens: number;

  // Capability declarations
  capabilities: {
    toolUse: boolean;                    // Supports function/tool calling
    structuredOutput: boolean;           // Supports JSON schema output mode
    vision: boolean;                     // Supports image inputs
    streaming: boolean;                  // Supports streaming responses
  };

  // Provider-specific retry configuration
  retryConfig: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    retryableStatusCodes: number[];      // e.g., [429, 500, 502, 503]
  };
}
```

```markdown
**Startup validation:** On startup, Meridian validates that the configured Scout and Sentinel
models meet minimum capability requirements:
- Scout requires `toolUse: true` and `structuredOutput: true` (or a fallback parsing layer).
- Sentinel requires `structuredOutput: true`.
- If capabilities are insufficient, the system logs a warning and falls back to prompt-based
  structured output with JSON parsing and validation.

**Provider-specific adapters** handle the differences in tool use format, streaming event
structure, and error semantics. Each adapter is independently tested against a provider
conformance test suite that verifies structured output, tool calling, streaming, and error
handling work correctly for each supported model.
```

---

## Patch 11: Add Plan Pre-Validation

**Severity**: Medium
**Review Finding**: #11.3 — Hallucination Detection
**Target Section**: 4.5 (Data Flow — step 6) and 5.1.1 (Axis Responsibilities)

### Rationale

Scout can hallucinate Gear or actions that don't exist. Currently this is caught at execution time (step 8), wasting a Sentinel LLM call. Adding a deterministic pre-validation step before Sentinel review catches these errors earlier and cheaper.

### Changes

**4.5 — Amend step 6:**

Current:
> 6. **Validation**: Axis sends *only the execution plan* (not the user's original message) to Sentinel.

Proposed:
> 6. **Pre-validation & Validation**: Axis first performs a deterministic pre-validation of the plan: verifying that every referenced Gear exists in the registry, every action is defined in the Gear's manifest, and parameters conform to the action's declared JSON Schema. Plans that fail pre-validation are returned to Scout for correction without consuming a Sentinel LLM call. Plans that pass pre-validation are then sent (with free-form fields stripped, see 5.3.1) to Sentinel for safety validation.

**5.1.1 — Add to Axis responsibilities:**

```markdown
- Pre-validate execution plans (Gear existence, action existence, parameter schema conformance) before routing to Sentinel
```

---

## Patch 12: Add Prompt Versioning Strategy

**Severity**: Medium
**Review Finding**: #11.2 — Prompt Versioning and Management
**Target Section**: 15 (Development Principles) — add new subsection 15.4

### Rationale

System prompts for Scout, Sentinel, and the Reflector are critical tunable parameters that need intentional management. The current document does not describe a versioning, testing, or management strategy for prompts.

### Changes

**Add Section 15.4:**

```markdown
### 15.4 Prompt Management

System prompts for Scout, Sentinel, and the Reflector are treated as first-class configuration
artifacts, not inline strings.

- **Storage**: Prompts are stored as versioned template files in each package's `src/prompts/`
  directory (e.g., `packages/scout/src/prompts/system.ts`).
- **Templating**: Prompts are assembled from static sections (instructions, safety rules) and
  dynamic sections (available Gear catalog, user preferences). Template variables are explicitly
  typed.
- **Version control**: Prompts are tracked in git alongside the code they belong to. Changes to
  prompt files trigger the LLM evaluation suite (Section 13.5) in CI.
- **Regression testing**: The evaluation benchmark suite runs against both the old and new prompt
  on every change. Regressions in evaluation metrics block the change.
- **Change review**: Prompt changes are treated with the same rigor as security-sensitive code
  changes — they require review and evaluation results.
```

---

## Patch 13: Handle LLM Reasoning Failures Explicitly

**Severity**: Medium
**Review Finding**: #11.5 — LLM Reasoning Failure Handling
**Target Section**: 5.2 (Scout) — add new subsection 5.2.7

### Rationale

LLMs can produce malformed JSON, refuse to respond, loop without converging, or truncate mid-response. These failure modes are qualitatively different from deterministic code failures and need specific handling.

### Changes

**Add Section 5.2.7 after 5.2.6:**

```markdown
#### 5.2.7 LLM Output Failure Handling

LLM outputs can fail in ways that differ from deterministic code. Axis and Scout handle these
explicitly:

| Failure Mode | Detection | Response |
|-------------|-----------|----------|
| Malformed JSON | Schema validation fails on Scout output | Retry with same input (up to 2 retries). If all fail, return error to user. |
| Model refusal | Response contains refusal patterns without a plan | Log the refusal, retry once with a rephrased prompt. If still refused, escalate to user with explanation. |
| Infinite replanning loop | Scout → Sentinel → revision cycle exceeds 3 iterations (existing limit) | Break the loop, return the last Sentinel rejection reason to the user. |
| Truncated output | Response ends mid-JSON (token limit exceeded) | Detect via incomplete JSON parsing. Retry with reduced context (summarize conversation history to free tokens). |
| Empty / nonsensical output | Response does not contain any recognizable plan structure | Treat as malformed JSON — retry then error. |
| Repetitive output | Scout produces the same plan after Sentinel rejection | Detect via plan similarity. On second identical plan, break the loop and return rejection to user. |

All LLM output failures are logged with the full request context (minus secrets) for debugging.
Repeated failures from a specific provider/model are tracked and surfaced as a health warning
in Bridge.
```

---

## Patch 14: Refine Semantic Cache

**Severity**: Low
**Review Finding**: #9 — Semantic Cache Reliability
**Target Section**: 11.1 (Response Caching)

### Rationale

The 0.98 threshold is very conservative (low hit rate). The reviewer recommends supplementing with exact-match caching and adding context-aware cache keys.

### Changes

**11.1 — Amend the Response Caching section:**

```markdown
#### Response Caching

- **Exact-match cache**: For identical query strings (hash-based), return cached responses
  without an API call. This is cheap, reliable, and particularly effective for scheduled tasks
  that repeat the same query.
- **Semantic cache**: For near-identical queries, return cached responses using embedding
  similarity with a high threshold (>0.98 cosine similarity). Accept that hit rates will be
  low at this threshold — the semantic cache is a bonus optimization, not a core cost-reduction
  mechanism.
- **Context-aware cache keys**: Cache entries are keyed on the query embedding plus a hash of
  system state that affects the response (available Gear list, relevant user preferences).
  Cache entries are invalidated when system state changes, not just on TTL expiry.
- **Cache scope**: Per-user, per-model. Cache entries expire after 24 hours by default.
- **Cache bypass**: Time-sensitive queries (weather, news, stock prices) and tasks with side
  effects bypass the cache.
```

---

## Patch 15: Clarify "Learning" Terminology

**Severity**: Low
**Review Finding**: #12 — The "Learning" Claim
**Target Section**: 2 (Executive Summary)

### Rationale

The reviewer notes that Meridian's adaptation is retrieval-augmented knowledge accumulation, not parameter-level learning. The architecture document's language is fine for a product context, but the executive summary could be slightly more precise without losing clarity.

### Changes

**Section 2 — First paragraph, amend:**

Current:
> It learns and improves over time through reflection on successes, failures, and user feedback.

Proposed:
> It adapts and improves over time by accumulating knowledge from successes, failures, and user feedback — storing reusable patterns, building new capabilities, and refining its behavior based on what works for each user.

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|-------------------|
| 1 | Scope down Gear Synthesizer for v1 | Critical | 5.4.3 |
| 2 | Add evaluation framework | Critical | 13 (new 13.5) |
| 3 | Multi-tag memory + confidence model | High | 5.4.2, 8.3 |
| 4 | Two-phase reflection, procedure demotion | High | 5.4.3 |
| 5 | Strip free-form fields for Sentinel, composite analysis | High | 5.3.1 |
| 6 | Layered prompt injection defenses | High | 5.2.6 |
| 7 | Retrieval specification (embedding tiers, chunking, decay) | Medium | 5.4.5 |
| 8 | Enumerated model routing + feedback loop | Medium | 5.2.5 |
| 9 | Dynamic context budgets + rolling summary | Medium | 11.1 |
| 10 | Provider capability declarations + startup validation | Medium | 5.2.4 |
| 11 | Deterministic plan pre-validation | Medium | 4.5, 5.1.1 |
| 12 | Prompt versioning strategy | Medium | 15 (new 15.4) |
| 13 | Explicit LLM failure mode handling | Medium | 5.2 (new 5.2.7) |
| 14 | Exact-match cache + context-aware keys | Low | 11.1 |
| 15 | Clarify "learning" terminology | Low | 2 |
