# Architecture Patches: Product Manager Review

> **Source**: `docs/critics/product-manager.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Add Implementation Phases with v0.1 Scope

**Severity**: Critical
**Review Finding**: #1 — MVP Scope, #9 — Feature Prioritization, #15 — Ship in 3 Months
**Target Section**: New Section 17 (before current "Future Considerations", renumbered to 18)

### Rationale

The architecture describes 18-24 months of work with no phasing. The reviewer identifies this as the single greatest risk to the project — building everything before shipping anything. The architecture needs an explicit phased implementation plan that defines what ships first, what ships second, and what is deferred indefinitely. Without this, there is no forcing function to cut scope.

### Changes

**Add Section 17 — Implementation Phases:**

```markdown
## 17. Implementation Phases

The architecture described in this document is the *target state*, not the launch state. Meridian
ships incrementally, with each phase producing a usable product. No phase builds capabilities
that go untested by real users before the next phase begins.

### 17.1 Phase 1: Core Loop (v0.1) — Target: 8-10 Weeks

The goal of v0.1 is a working end-to-end loop: user sends a message, the system plans and
executes a task, the user sees a result. Everything else is deferred.

**What ships:**

| Component | v0.1 Scope | What Is Cut |
|-----------|-----------|-------------|
| **Axis** | Job queue (immediate only), basic message routing, SQLite persistence, sequential execution | No HMAC signing, no cron scheduling, no event bus, no worker pool (single worker) |
| **Scout** | Single LLM provider (Anthropic), single model, basic plan generation, fast-path detection | No adaptive model selection, no secondary model, no multi-provider |
| **Sentinel** | Rule-based policy engine (allowlist/blocklist), no LLM | No LLM-based validation, no Sentinel Memory, no precedent matching |
| **Journal** | Conversation history only (last N messages in SQLite) | No memory types, no vector search, no reflection, no Gear Synthesizer |
| **Bridge** | Text-only chat UI, basic auth (password + session cookie), WebSocket streaming, job status display | No voice/image/video, no memory browser, no Gear management, no TOTP |
| **Gear** | 3 built-in Gear (`file-manager`, `web-fetch`, `shell`), process-level isolation | No Docker sandboxing, no community Gear, no manifest signatures, no network filtering proxy |
| **Shared** | Core interfaces (`Job`, `ExecutionPlan`, `ExecutionStep`, `AxisMessage`) | Minimal type surface |

**v0.1 success criteria:**

1. A user can install Meridian and send their first message within 3 minutes.
2. A conversational query (fast path) returns a response in under 5 seconds.
3. A simple task (e.g., "list the files in my home directory") completes in under 10 seconds.
4. The approval flow works: rule-based policies block dangerous actions and prompt the user.
5. The system is stable enough for daily use by the developer and 5-10 early testers.

### 17.2 Phase 2: Usefulness (v0.2) — Target: 4-6 Weeks After v0.1

Add the features that make users return: better Gear, scheduling, cost visibility.

- **Gear**: Add `web-search`, `scheduler`, `notification` built-in Gear. Improve `shell` output
  handling.
- **Axis**: Add HMAC message signing. Add cron scheduling for recurring jobs.
- **Bridge**: Approval flow improvements, basic settings page, cost-per-task display.
- **Scout**: Better plan generation with tool-use format. Basic error recovery (retry once on
  Gear failure).
- **Observability**: Token usage and cost tracking displayed in Bridge.

### 17.3 Phase 3: Safety & Memory (v0.3) — Target: 4-6 Weeks After v0.2

Add the differentiating features once the core is proven stable.

- **Sentinel**: LLM-based validation (single provider). Replaces rule-based engine for
  full-path tasks. Rule-based engine remains as a fast pre-check.
- **Journal**: Basic semantic memory (store/retrieve user preferences and facts). Vector search
  with sqlite-vec. No reflection pipeline yet.
- **Gear**: Container-level sandboxing (Docker, optional). Gear manifest signatures and
  checksums. Network filtering proxy.
- **Bridge**: Memory viewer (read-only). Gear list page.
- **Security**: Full HMAC signing, Sentinel information barrier enforcement.

### 17.4 Phase 4: Learning (v0.4+) — Target: Ongoing

The features that create compound value over time. Only built after real usage data validates
the approach.

- **Journal**: Reflection pipeline, Gear Synthesizer (composition-only, see 5.4.3.1), procedural
  memory.
- **Sentinel**: Sentinel Memory with precedent matching and expiry.
- **Scout**: Adaptive model selection, multi-provider support.
- **Bridge**: Full memory management (edit, delete, export), onboarding wizard improvements.

### 17.5 Deferred Indefinitely

These features are not planned for any specific release. They will be evaluated based on user
demand:

- Voice, image, and video input modalities
- TOTP two-factor authentication
- Prometheus metrics endpoint
- WCAG 2.1 AA compliance (progressive, not a gate)
- Messaging platform integrations (Telegram, Discord, Slack)
- Gear marketplace / community registry
- Multi-user support
- Agent-to-agent communication
- Proactive behavior
```

**Renumber current Section 16 ("Future Considerations") to Section 18.** The items in the current Section 16 that overlap with Phase 4 or the Deferred list should reference the phasing section.

---

## Patch 2: Add First-Run Experience Specification

**Severity**: Critical
**Review Finding**: #2 — User Journey Gaps: What Are the First 5 Minutes?
**Target Section**: 5.5 (Bridge) — add new subsection 5.5.8

### Rationale

The architecture describes the system exhaustively but never describes what a user actually experiences. The setup wizard gets a single sentence. The first interaction, first success, and empty state are unspecified. For a self-hosted product competing with zero-setup alternatives, the first 5 minutes determine whether a user ever comes back. The reviewer identifies this as critical — the time from installation to "that was cool" must be under 3 minutes.

### Changes

**Add Section 5.5.8 after 5.5.7:**

```markdown
#### 5.5.8 First-Run Experience

The first-run experience is the most important UX flow in the product. Every screen, every
decision, and every failure mode is specified here.

**Installation to Browser (Target: <60 seconds)**

After `docker compose up` or `npm start`, Meridian prints a single line to the terminal:

```
Meridian is running at http://localhost:3000
```

If port 3000 is in use, Meridian automatically selects the next available port and prints the
actual URL. No other terminal output is shown unless there is an error.

**Setup Wizard (Target: <90 seconds, 3 steps)**

On first visit to the Bridge URL, the user sees a setup wizard. The wizard has exactly three
steps:

1. **Create a password.** Single password field with confirmation. No username, no email.
   Minimum 8 characters. The UI explains: "This password protects your Meridian instance.
   You'll use it to log in from this device or your network."

2. **Add an API key.** A single text field with a dropdown to select the provider (Anthropic
   is pre-selected and recommended). The UI includes a direct link to the provider's API key
   page. A "Skip for now" option is visible — if skipped, the system explains it cannot do
   anything useful without an API key and offers to guide the user to get one. The wizard does
   NOT ask for separate Scout and Sentinel providers. A single API key configures both. (In
   v0.1, Sentinel is rule-based and does not need an API key. In later versions, the same
   provider is used for both by default. Separate providers are an advanced setting.)

3. **Try it out.** The wizard presents a pre-filled suggested first message:
   "What can you do?" The user can edit it or send it as-is. This triggers a fast-path
   response that completes in 2-5 seconds and explains Meridian's capabilities in plain
   language, with 2-3 suggested follow-up tasks appropriate to the installed Gear.

**Empty State**

If the user dismisses the wizard or navigates to the main chat, the empty state shows:
- A brief welcome message (2-3 sentences).
- 3-4 suggested starter tasks as clickable chips (e.g., "List files in my home directory",
  "Search the web for today's news", "What's in my Downloads folder?").
- A note explaining that Meridian gains capabilities over time.

Suggested tasks are chosen from actions that the currently installed Gear can handle, ensuring
they succeed on the first try.

**First Full-Path Task**

When the user triggers their first action-requiring task:
- The UI shows clear progress stages: "Planning..." → "Checking safety..." → "Running..."
  → result. Internal component names (Scout, Sentinel, Gear) are never shown.
- If the task requires approval, the approval dialog explains what will happen in plain
  language (e.g., "Meridian wants to list the files in /Users/you/Downloads. Allow?") with
  Allow and Deny buttons. No jargon.
- After the task completes, the UI does NOT show a tutorial about the internal pipeline.
  It shows the result. The architecture details are available in a collapsible "Details"
  section for curious users.

**Failure During Setup**

| Failure | Handling |
|---------|----------|
| Invalid API key | Immediate validation with a lightweight API call. Clear error message with a retry option. |
| Network unreachable | "Can't reach [provider]. Check your internet connection." Retry button. |
| LLM API error | "Got an error from [provider]: [message]. This might be temporary." Retry button. |
| Port conflict | Auto-select next available port. Print the correct URL. |
```

---

## Patch 3: Add 30-Second Demo Specification

**Severity**: Critical
**Review Finding**: #10 — Community and Adoption Risks (Risk 5: The Demo Problem), #12 — Will This Ship?
**Target Section**: New subsection under 17.1 (v0.1 scope, from Patch 1)

### Rationale

The most successful open-source projects have compelling demos. The reviewer argues that the entire v0.1 should be optimized to produce a 30-second demo that makes people want to try the product. If the demo does not work, the architecture is irrelevant. This patch specifies a concrete demo scenario that v0.1 must support flawlessly.

### Changes

**Add to Section 17.1 (Phase 1), after the success criteria:**

```markdown
**Demo scenario (v0.1 must make this work flawlessly):**

The following 30-second sequence is the north star for v0.1 development. Every architectural
decision in v0.1 is evaluated against whether it makes this demo better or worse.

```
User:  "Find all TODO comments in my project and save a summary to todos.txt"

[UI shows: Planning... → Checking safety... → Running...]
[~6 seconds total]

Meridian: Found 23 TODO comments across 8 files. Here's a summary:

  - src/api/auth.ts (5 TODOs): Authentication improvements needed
  - src/db/migrations.ts (3 TODOs): Schema cleanup tasks
  - ... (6 more files)

  Full details saved to /workspace/todos.txt

  Would you like me to prioritize these by urgency?
```

This demo shows:
1. Natural language in, useful result out.
2. Multi-step execution (shell commands to search, file write to save) — not just a chatbot.
3. A follow-up suggestion that hints at ongoing capability.
4. Completion in under 10 seconds.

The demo requires `shell` and `file-manager` Gear, fast-path detection (this is a full-path
task), and the rule-based approval engine (shell commands require approval — for the demo,
the user pre-approves shell read commands during setup or approves once and the approval is
remembered for the session).
```

---

## Patch 4: Reframe Executive Summary and Target Audience

**Severity**: High
**Review Finding**: #3 — Target Audience, #4 — Competitive Landscape, #8 — Lead with Learning Loop
**Target Section**: 2 (Executive Summary)

### Rationale

The reviewer identifies three framing problems: (1) the target persona as described does not exist in meaningful numbers, (2) the executive summary leads with security rather than the genuinely novel feature (Journal + Gear Synthesizer learning loop), and (3) the competitive differentiation is buried. The recommended fix: define the actual target user, lead with what makes Meridian unique, and position security as table stakes rather than headline.

### Changes

**Section 2 — Add a "Target User" subsection after "Core Principles":**

```markdown
### Target User

Meridian's primary user is a **technical power user who wants to automate their workflow with
an AI assistant they control**. This person:

- Is a developer or technically proficient professional.
- Has a cloud API key (Anthropic, OpenAI) or is willing to get one.
- Wants their data to stay on their own hardware.
- Runs Meridian on their laptop, a VPS, or a home server. (It also works on a Raspberry Pi,
  but that is not the primary target.)
- Values capability and extensibility over hand-holding.
- Is comfortable with a chat-based interface and basic system administration.

This is not a consumer product. It is not competing with Siri or Alexa. It is a power tool
for people who want an AI that works for them autonomously, learns their preferences, and
runs on hardware they own.
```

**Section 2 — Amend "Key Differentiators from Existing Platforms":**

Current table compares Meridian to OpenClaw only.

Proposed — replace with:

```markdown
### Key Differentiators

1. **Gets better the more you use it.** Journal records what works, what fails, and what the
   user prefers. The Gear Synthesizer creates new plugins from patterns it learns. Over time,
   Meridian handles tasks it couldn't handle at install. This is the core value proposition —
   an assistant that compounds in capability.

2. **Self-hosted and private.** All data stays on the user's device. LLM API calls send the
   minimum necessary context. No telemetry, no phoning home. The user owns their data and can
   export or delete it at any time.

3. **Safe by design.** Every action plan is independently validated before execution. Plugins
   run in sandboxes with declared permissions. Credentials are encrypted. The safety model is
   structural, not optional — it cannot be misconfigured into an unsafe state.

4. **Starts small, grows with you.** The platform ships with a minimal set of foundational
   capabilities. Users add what they need. Journal creates what it learns. The system never
   has more capability than the user has approved.
```

**Section 2 — First paragraph, amend:**

Current:
> Meridian is an open-source, self-hosted AI assistant platform designed to run on low-power devices (Raspberry Pi, Mac Mini, VPS) and execute tasks autonomously based on natural language commands. It learns and improves over time through reflection on successes, failures, and user feedback.

Proposed:
> Meridian is an open-source, self-hosted AI assistant platform that executes tasks autonomously based on natural language commands and gets better the more you use it. It runs on commodity hardware (laptops, Mac Minis, VPS instances, Raspberry Pis) and stores all data locally. Over time, it learns the user's preferences, builds new capabilities from observed patterns, and refines its behavior based on what works.

---

## Patch 5: Restructure OpenClaw Section

**Severity**: High
**Review Finding**: #11 — The OpenClaw Section: Insecurity Masquerading as Analysis
**Target Section**: 3 (Lessons from OpenClaw)

### Rationale

The reviewer identifies Section 3 as a 60-line competitive teardown that reveals insecurity rather than confidence, frames Meridian's design reactively ("we do it because they didn't"), and dates the document with specific CVE numbers from early 2026. The security decisions themselves are sound, but the framing is weaker than first-principles reasoning. The reviewer recommends moving the competitive analysis to a separate document and presenting security decisions from first principles in the architecture.

### Changes

**Section 3 — Replace the existing section with a condensed, first-principles version:**

```markdown
## 3. Design Motivations

Meridian's architecture is informed by observed failure modes in existing AI agent platforms,
particularly around security, autonomy, and plugin safety. This section presents the
motivations behind key design decisions.

A detailed competitive analysis — including specific incidents, CVEs, and platform comparisons
— is maintained separately in `docs/competitive-analysis.md`.

### 3.1 Why Security Is Structural

Many AI agent platforms treat security as configurable — users can enable authentication, set
up sandboxing, or configure credential encryption. The problem: most users don't. Default-off
security is effectively no security.

Meridian makes security structural:
- Authentication is mandatory, even on localhost.
- Credential encryption is always on. There is no plaintext mode.
- Gear sandboxing is always enforced. There is no "trust this plugin" bypass.
- Safety validation runs on every action-requiring task. It cannot be disabled, only tuned.

### 3.2 Why Autonomy Requires Independent Validation

An AI agent with direct shell access and no validation layer is dangerous. Ambiguous commands
can cause unintended destruction. Prompt injection can manipulate behavior. Self-validation
("Are you sure?") fails because the same model that generated the plan is predisposed to
approve it.

Meridian separates planning (Scout) from validation (Sentinel) with a strict information
barrier. The validator cannot be influenced by the same context that produced the plan.

### 3.3 Why Plugins Must Be Sandboxed by Default

Community plugin ecosystems invariably attract malicious contributions. A plugin that requests
"full system access" and exfiltrates data is indistinguishable from a legitimate system
automation plugin if the platform doesn't enforce boundaries.

Meridian requires every Gear to declare its permissions in a manifest. Undeclared capabilities
are blocked at runtime, not by policy, but by the sandbox itself. A Gear that doesn't declare
network access physically cannot make network requests.

### 3.4 Why External Content Is Never Trusted

AI agents that process emails, web pages, and documents without sanitization are vulnerable
to prompt injection through content. An attacker can embed instructions in an email that the
agent follows as if they came from the user.

Meridian tags all external content with provenance metadata and treats it as data, never as
instructions. Sentinel independently validates that plans are not driven by embedded directives
in external content.
```

Move the current Section 3 content (including the OpenClaw comparison table, CVE details, and
"Lessons Applied" table) to a new file `docs/competitive-analysis.md`. The architecture
document links to it but does not depend on it.

---

## Patch 6: Add Cost Visibility and Sensible Defaults

**Severity**: High
**Review Finding**: #7 — Cost Concerns, #13 — Default Configuration
**Target Section**: 5.5.1 (Bridge Responsibilities), 10.4 (Configuration), 11.1 (Cost Tracking)

### Rationale

The reviewer argues that the cost math does not work for the stated target user — a Raspberry Pi user (cost-sensitive by definition) paying for 2-3 LLM calls per task. The architecture already mitigates this with fast path, journal-skip, Sentinel Memory, and adaptive model selection, but the defaults still assume dual-provider operation. The reviewer recommends: (1) defaults that minimize cost aggressively, (2) per-task cost visibility in the UI from day one, and (3) prominent local model support.

### Changes

**5.5.1 — Add to Bridge responsibilities:**

```markdown
- Display estimated and actual cost per task (token usage, API cost) in the conversation UI
- Show aggregate cost summaries (daily, weekly, monthly) in the settings page
- Alert the user when approaching their daily cost limit (at 80% and 95%)
```

**10.4 — Amend the example `config.toml` to show cost-conscious defaults:**

Current config shows `anthropic` for Scout and `openai` for Sentinel as separate providers.

Proposed — replace with:

```toml
# Example config.toml — defaults optimized for cost

[axis]
workers = 2                          # Concurrent job workers
job_timeout_ms = 300000              # 5 minutes default

[scout]
provider = "anthropic"
max_context_tokens = 100000
temperature = 0.3

[scout.models]
primary = "claude-sonnet-4-5-20250929"

# Uncomment to enable adaptive model selection (reduces cost for simple tasks):
# secondary = "claude-haiku-4-5-20251001"

[sentinel]
# Default: rule-based validation (no LLM cost).
# To enable LLM-based validation, uncomment and configure:
# provider = "anthropic"
# model = "claude-haiku-4-5-20251001"
mode = "rule-based"                  # "rule-based" | "llm"

[journal]
embedding_provider = "local"         # "local" | "openai" | "anthropic"
embedding_model = "nomic-embed-text" # For local embeddings
episode_retention_days = 90
reflection_enabled = false           # Enable after v0.3 when reflection pipeline is stable

[bridge]
bind = "127.0.0.1"
port = 3000
session_duration_hours = 168         # 7 days
show_cost_per_task = true            # Display token usage and estimated cost in the UI

[security]
daily_cost_limit_usd = 5.00
require_approval_for = ["file.delete", "shell.execute", "network.post", "message.send"]
```

**10.4 — Add after the config example:**

```markdown
**Default configuration philosophy:** Out of the box, Meridian uses a single LLM provider, a
single model, rule-based safety validation, and no Journal reflection. This minimizes cost to
approximately one LLM API call per task (comparable to a single ChatGPT query). Users who want
the full dual-LLM safety architecture, adaptive model selection, and learning features can
enable them incrementally through configuration.

The pitch: "Free to run with local models (via Ollama). A few dollars a month with cloud APIs.
More capable configurations available for users who want them."
```

**11.1 — Amend the Cost Tracking section:**

Add after the existing cost tracking bullets:

```markdown
- Display per-task cost breakdown in the Bridge conversation UI (configurable, on by default).
  Each task response shows: model used, input tokens, output tokens, estimated cost. This
  makes cost a first-class visible metric, not a hidden surprise on the monthly API bill.
- For local model deployments (Ollama), cost display shows "local — no API cost" to reinforce
  the value of the local option.
```

---

## Patch 7: Add User-Facing Language Principles

**Severity**: High
**Review Finding**: #6 — Learning Curve: Death by Terminology
**Target Section**: 5.5 (Bridge) — add new subsection 5.5.9 (or 5.5.8 if Patch 2's numbering is adjusted)

### Rationale

The architecture introduces 18+ internal concepts (Axis, Scout, Sentinel, Journal, Bridge, Gear, fast path, full path, journal-skip, Sentinel Memory, Gear Synthesizer, execution plans, validation results, risk levels, permission manifests, provenance tags, information barriers, loose schema). While these are appropriate for an architecture document, if they leak into the user-facing UI, error messages, or documentation, the learning curve is severe. The reviewer recommends hiding the architecture from the user entirely and using plain English in all user-facing surfaces.

### Changes

**Add subsection to 5.5:**

```markdown
#### 5.5.9 User-Facing Language

Internal component names and architecture concepts are never exposed in the user-facing UI.
All user-visible text uses plain English descriptions of what is happening, not how it is
happening.

| Internal Concept | User-Facing Language |
|-----------------|---------------------|
| Scout is planning | "Planning your task..." |
| Sentinel is validating | "Checking safety..." |
| Sentinel rejected the plan | "This task was flagged for review: [reason in plain language]" |
| Axis is dispatching to Gear | "Running..." |
| Gear execution | "Running [action description]..." (e.g., "Searching the web...", "Reading files...") |
| Journal is reflecting | "Learning from this task..." (or hidden entirely, since it's async) |
| needs_user_approval | "Meridian wants to [action]. Allow?" |
| Sentinel Memory | Not surfaced. Approvals are simply remembered. |
| ExecutionPlan / ExecutionStep | Not surfaced. The "Details" panel shows steps as a simple numbered list. |
| fast path / full path | Not surfaced. The user sees a response (fast) or progress stages (full). |
| Gear | "capability" or "tool" in user-facing text. "Gear" is used in developer documentation only. |

**Error messages** follow the same principle. Instead of "Gear `web-fetch` failed with exit
code 1", the user sees "Couldn't fetch the web page. [Reason if available]. Want me to try
a different approach?"

**Developer mode:** Power users and Gear developers can enable a "developer mode" in Bridge
settings that shows internal component names, raw execution plans, Sentinel validation
details, and Gear logs. This is opt-in and off by default.

Component names (Axis, Scout, Sentinel, Journal, Gear) are used in:
- This architecture document
- Developer documentation
- System logs
- The developer mode UI
- Gear manifests and the Gear development API

They are NOT used in:
- The default Bridge UI
- Error messages shown to users
- The setup wizard
- Notification messages
- The onboarding experience
```

---

## Patch 8: Add End-to-End User Story Traces

**Severity**: High
**Review Finding**: #8 — Missing User Stories
**Target Section**: New Section 4.6 (after 4.5 Data Flow)

### Rationale

The architecture provides a generic 11-step request lifecycle but never traces a concrete user story through the system end-to-end. The reviewer identifies three specific stories that expose gaps: email checking (OAuth complexity, Gear availability), home automation (private IP ranges, scheduling), and project setup (shell approval burden). Without concrete traces, the architecture is untested against real usage patterns.

### Changes

**Add Section 4.6:**

```markdown
### 4.6 Concrete User Story Traces

These trace real user stories through the architecture to expose integration points, gaps,
and UX considerations that the generic data flow (Section 4.5) does not surface.

#### 4.6.1 "Find all large files in my Downloads folder and list them by size"

**Why this story:** Exercises the full path with built-in Gear only. Good baseline test.

| Step | Component | What Happens | Time |
|------|-----------|-------------|------|
| 1 | Bridge | User types message, sends via WebSocket | instant |
| 2 | Axis | Creates Job, routes to Scout | <100ms |
| 3 | Scout | Classifies as full-path (requires file system action). Produces plan: 1 step using `shell` Gear with `find ~/Downloads -type f -size +100M -exec ls -lhS {} +` | 2-4s |
| 4 | Axis | Rule-based Sentinel checks policy: `shell.execute` requires user approval | <100ms |
| 5 | Bridge | Shows approval dialog: "Meridian wants to run a command to find large files in your Downloads folder. Allow?" | user click |
| 6 | Axis | Dispatches to `shell` Gear in process sandbox | <100ms |
| 7 | Gear | Executes command, returns stdout | 1-3s |
| 8 | Axis | Routes result to Scout for formatting | <100ms |
| 9 | Scout | Formats the result as a readable list (fast-path-like, single LLM call) | 1-3s |
| 10 | Bridge | Streams formatted response to user | instant |

**Total user-perceived time:** ~5-10 seconds + approval click.
**LLM calls:** 2 (planning + formatting). In v0.1 with rule-based Sentinel: no Sentinel LLM call.
**Approval burden:** 1 click. If the user has previously approved shell read commands, Sentinel
Memory (v0.3+) auto-approves and the task completes without interruption.

**Gaps identified:** None for v0.1. This story works with the minimal built-in Gear set.

#### 4.6.2 "Set up a new TypeScript project with Vitest and ESLint"

**Why this story:** Exercises multi-step planning, multiple shell commands, and file writes.
Tests the approval burden for complex tasks.

| Step | What Happens | Approvals Needed |
|------|-------------|-----------------|
| Scout plans | 6-step plan: `mkdir`, `npm init`, `npm install` (x2), write `vitest.config.ts`, write `.eslintrc.json` | — |
| Sentinel checks | `shell.execute` x4, `file.write` x2 (within workspace: auto-approved) | 4 shell approvals |
| User approves | Approval dialog shows all 4 shell commands in a batch with "Allow all" option | 1 click |
| Gear executes | Steps run sequentially, each in process sandbox | 15-30s total |
| Scout formats | Summary of what was created | 1 LLM call |

**Total user-perceived time:** ~20-40 seconds + 1 approval click.
**Approval burden:** The batch approval UX is critical. Asking for 4 separate approvals would
be intolerable. The Bridge approval dialog MUST support batch approval for multi-step plans.

**Gaps identified:**
1. **Batch approval UI** is not specified in the Bridge section. Must be added.
2. **Shell command grouping** — Sentinel (or the rule-based engine) should recognize that
   multiple shell commands in a single plan can be presented as a batch.

#### 4.6.3 "Check the weather in Tokyo and remind me to pack an umbrella if it's raining"

**Why this story:** Exercises `web-fetch` Gear + `scheduler` Gear + conditional logic in the
plan. Tests Scout's ability to produce conditional plans.

| Step | What Happens |
|------|-------------|
| Scout plans | 2-step plan: (1) `web-fetch` to get weather data, (2) conditional: if rain, use `notification` Gear to set a reminder |
| Sentinel checks | `web-fetch` to weather API (GET, allowlisted domain): auto-approved. `notification`: auto-approved (low risk). |
| Gear executes | Step 1: fetch weather. Step 2: check condition, send notification if needed. |
| Scout formats | "It's currently raining in Tokyo (15°C). I've set a reminder to pack an umbrella." |

**Total user-perceived time:** ~5-8 seconds, no approval needed.
**Gaps identified:**
1. **Conditional execution** — the plan format must support conditional steps (`if` step 1
   result contains X, execute step 2). The `ExecutionStep` interface does not currently have a
   `condition` field. This should be added as a free-form field that Axis evaluates.
2. **"Remind me"** implies scheduling, but the user said "remind me" not "remind me tomorrow."
   Scout must determine whether this is an immediate notification or a scheduled one.
```

---

## Patch 9: Add Batch Approval to Bridge

**Severity**: Medium
**Review Finding**: #8 — User Story trace reveals missing batch approval
**Target Section**: 5.3.4 (Approval Flow) and 5.5 (Bridge)

### Rationale

The user story trace in Patch 8 reveals that multi-step plans requiring multiple approvals create an intolerable UX burden if each approval is individual. A plan with 4 shell commands should not require 4 separate clicks. The architecture must specify a batch approval mechanism.

### Changes

**5.3.4 — Add after the existing approval flow diagram:**

```markdown
**Batch approval:** When a plan contains multiple steps that require user approval, Bridge
groups them into a single approval dialog. The dialog shows:

1. A plain-language summary of the overall task.
2. A list of all actions requiring approval, each with its risk level indicator.
3. Three options: "Allow all", "Review individually", or "Deny all".

"Review individually" expands each action into its own approve/deny toggle, allowing the
user to approve safe steps and deny risky ones. Denied steps cause Axis to route back to
Scout for replanning without those actions.

Sentinel Memory (when available) stores batch approval patterns. If a user approves "shell
commands for project setup" as a batch, similar future batches can be auto-approved.
```

---

## Patch 10: Reframe Deployment Targets

**Severity**: Medium
**Review Finding**: #3 — Target Audience (Raspberry Pi user persona), #14 — Drop Pi as Primary Target
**Target Section**: 10.1 (Target Environments)

### Rationale

The reviewer argues that the Raspberry Pi crowd and the target user persona (technical power user willing to configure API keys and review approvals) have minimal overlap. The Pi should be a supported environment, not the primary design target. Leading with Pi as the first listed target signals "low-power / limited" rather than "powerful / capable."

### Changes

**10.1 — Reorder and reframe the target environments table:**

Current table lists Raspberry Pi 4/5 first with "Primary target."

Proposed:

```markdown
### 10.1 Target Environments

Meridian runs on commodity hardware. The primary design target is a developer's laptop or a
small home server. Lower-power devices are supported with documented tradeoffs.

| Environment | RAM | Storage | CPU | Notes |
|-------------|-----|---------|-----|-------|
| **Laptop / Desktop** | 8+ GB | 50+ GB | Any | Primary development and daily-use target. |
| **Mac Mini / Home Server** | 8-16 GB | 256+ GB SSD | Apple Silicon / x64 | Ideal always-on deployment. Docker recommended. |
| **Linux VPS** | 2-4 GB | 40+ GB SSD | x64 | Cloud deployment. Docker recommended. |
| **Raspberry Pi 4/5** | 4-8 GB | 32+ GB SD/SSD | ARM64 | Supported. Process-level sandbox only (Docker optional). Reduced worker count (default: 2). Lower embedding model quality (see 5.4.5). |
```

---

## Patch 11: Add Conditional Execution to Plan Format

**Severity**: Medium
**Review Finding**: #8 — User Story trace reveals missing conditional execution
**Target Section**: 5.2.2 (Execution Plan Format)

### Rationale

The user story trace in Patch 8 (weather + reminder) reveals that the plan format has no mechanism for conditional execution. Scout must be able to specify "execute step 2 only if step 1's result meets a condition." Without this, every conditional task requires a round-trip back to Scout after step 1 completes, doubling latency.

### Changes

**5.2.2 — Add a note after the `ExecutionStep` interface:**

```markdown
**Conditional execution:** Scout can include conditional steps in the plan. A conditional step
specifies a `dependsOn` step ID and a `condition` (a JSONPath expression evaluated against the
dependency's result). Axis evaluates the condition deterministically — no LLM call needed.

Example: "Fetch weather, then notify if raining."

```json
{
  "steps": [
    {
      "id": "fetch-weather",
      "gear": "web-fetch",
      "action": "get",
      "parameters": { "url": "https://api.weather.example/tokyo" },
      "riskLevel": "low"
    },
    {
      "id": "notify-rain",
      "gear": "notification",
      "action": "send",
      "parameters": { "message": "Pack an umbrella — it's raining in Tokyo!" },
      "riskLevel": "low",
      "dependsOn": "fetch-weather",
      "condition": "$.result.current.condition == 'rain'"
    }
  ]
}
```

If the condition evaluates to false, the step is skipped and marked as `skipped` in the job
result. This avoids an LLM round-trip for simple conditional logic.

Complex conditions that cannot be expressed as JSONPath (e.g., "if the sentiment of the email
is negative") require a round-trip to Scout. Scout marks these steps with
`condition: "llm-evaluate"` and Axis routes the step result back to Scout for a secondary
decision before proceeding.
```

---

## Patch 12: Add Developer Mode to Bridge

**Severity**: Low
**Review Finding**: #6 — Learning Curve (users need to debug without knowing internals)
**Target Section**: 5.5 (Bridge) — referenced in Patch 7 but deserves explicit specification

### Rationale

The user-facing language principles (Patch 7) hide the architecture from normal users. But power users and Gear developers need visibility into the internal pipeline for debugging. A developer mode provides this without polluting the default experience.

### Changes

**Add to Bridge section (after user-facing language subsection):**

```markdown
#### 5.5.10 Developer Mode

Bridge supports an opt-in developer mode (toggled in Settings) that exposes architecture
internals for debugging and development:

| Feature | Normal Mode | Developer Mode |
|---------|------------|----------------|
| Progress stages | "Planning..." / "Running..." | "Scout: generating plan (claude-sonnet-4-5)..." |
| Task result | Formatted result only | Result + raw execution plan JSON + Sentinel validation |
| Error messages | Plain language | Full error with component name, error code, stack trace |
| Cost display | Estimated cost per task | Token breakdown: input/output/cached per LLM call |
| Gear execution | Hidden | Gear ID, action, parameters, stdout/stderr, timing |
| Approval dialog | "Meridian wants to [action]" | Full step details with risk level and policy match |
| System log | Not visible | Live-streaming system log panel with component filter |

Developer mode is persistent per-user (stored in the session) and indicated by a subtle badge
in the Bridge header. It does not affect system behavior — only what is displayed.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|-------------------|
| 1 | Add implementation phases with v0.1 scope | Critical | New 17 |
| 2 | Add first-run experience specification | Critical | 5.5 (new 5.5.8) |
| 3 | Add 30-second demo specification | Critical | 17.1 (from Patch 1) |
| 4 | Reframe executive summary and target audience | High | 2 |
| 5 | Restructure OpenClaw section to first-principles | High | 3 |
| 6 | Add cost visibility and sensible defaults | High | 5.5.1, 10.4, 11.1 |
| 7 | Add user-facing language principles | High | 5.5 (new 5.5.9) |
| 8 | Add end-to-end user story traces | High | New 4.6 |
| 9 | Add batch approval to Bridge | Medium | 5.3.4, 5.5 |
| 10 | Reframe deployment targets | Medium | 10.1 |
| 11 | Add conditional execution to plan format | Medium | 5.2.2 |
| 12 | Add developer mode to Bridge | Low | 5.5 (new 5.5.10) |
