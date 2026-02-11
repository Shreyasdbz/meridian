# Architecture Patches: Power User / Self-Hoster Review

> **Source**: `docs/critics/power-user.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Trust Escalation & Approval Fatigue Mitigation

**Severity**: Critical
**Review Finding**: #3 — Approval Fatigue: A Significant UX Concern
**Target Section**: 5.3.8 (Sentinel Memory)

### Rationale

The reviewer identifies a real architectural gap: during the bootstrapping period before Sentinel Memory has accumulated precedent decisions, users face 10+ approval prompts per day. The well-documented failure mode is that users stop reading approvals and tap "approve" reflexively — defeating the entire safety architecture. Sentinel Memory will reduce this over time, but the first few weeks are critical for retention. The architecture needs proactive trust escalation mechanisms, approval profiles, and time-bounded modes to survive the bootstrapping period without training users to ignore approvals.

### Changes

**5.3.8 — Add after "Safety properties:" section, before the section break:**

```markdown
**Trust escalation (bootstrapping support):**

During the bootstrapping period, users have no Sentinel Memory precedents. To prevent approval
fatigue from undermining the safety model, Sentinel Memory includes proactive trust escalation:

- **Standing rule suggestions**: When a user approves the same category of action N times
  (configurable, default: 5), Bridge proactively suggests creating a standing rule. For example:
  "You have approved plans containing `git push` to `origin` 5 times. Create a standing
  approval for this action?" The user can accept (creates a Sentinel Memory entry with no
  expiry), accept with expiry, or dismiss. This accelerates Sentinel Memory bootstrapping
  without silently expanding trust.

- **Approval profiles**: Users can define named profiles that bundle sets of standing approvals.
  Examples:
  - **Work mode**: Auto-approve email operations, calendar access, git operations, and
    deployment to staging.
  - **Cautious mode**: Approve everything individually (the default).
  - **Maintenance mode**: Auto-approve shell commands matching known maintenance patterns
    (backups, updates, log rotation).

  Profiles are stored as collections of Sentinel Memory entries that can be activated or
  deactivated as a group through Bridge. Switching profiles is instant — it activates or
  deactivates the associated Sentinel Memory entries. Profile changes are logged in the audit
  trail.

- **Session-scoped auto-approval**: Users can temporarily enable auto-approval for a bounded
  duration (configurable, max: 4 hours). During this window, actions that would normally
  require user approval are auto-approved if Sentinel's LLM-based validation passes. Actions
  that Sentinel itself rejects are still blocked. This is analogous to `sudo` timeout behavior.
  The session window is visible in Bridge with a countdown, and the user can revoke it early.
  Session-scoped auto-approval is logged distinctly in the audit trail.

- **Quiet hours**: Users can configure time windows during which approval prompts are queued
  rather than delivered. Scheduled jobs that run during quiet hours either auto-approve via
  Sentinel Memory (if a matching precedent exists) or queue the approval for delivery when
  quiet hours end. No jobs are silently approved without precedent during quiet hours — they
  wait. The user can configure fallback behavior: queue (default), auto-approve if Sentinel
  LLM approves, or skip the job and retry at next schedule.

**Bootstrapping metrics:**

Bridge displays a "trust maturity" indicator showing what percentage of recent full-path tasks
were auto-approved via Sentinel Memory vs. requiring user approval. As the user builds up
precedent decisions, this percentage rises, providing visible feedback that the system is
learning their preferences. When the auto-approval rate exceeds 80%, Bridge suggests reviewing
standing rules for accuracy.
```

---

## Patch 2: Plan Replay Cache for Known Patterns

**Severity**: Critical
**Review Finding**: #6 — Speed: The Latency Tax on Simple Tasks
**Target Section**: 4.3 (Fast Path vs. Full Path) — add new subsection 4.3.2

### Rationale

The reviewer identifies that even with Sentinel Memory eliminating the second LLM call, simple action-requiring tasks ("turn off the lights") still incur a 2-5 second Scout LLM round-trip. The fast path only applies to conversational queries that need no Gear. The architecture needs a middle tier: a "plan replay" mechanism that skips Scout entirely for well-understood, previously-executed tasks. The existing semantic cache (Section 11.1) caches LLM *responses*, not execution *plans* — a plan-level cache is architecturally distinct.

### Changes

**4.3 — Add new subsection 4.3.2 after the Journal-skip section:**

```markdown
#### 4.3.2 Known-Plan Path: Replay for Recognized Tasks

Between the fast path (no Gear) and the full path (Scout + Sentinel + Gear), Meridian supports
a **known-plan path** for tasks that closely match previously successful execution plans.

**How it works:**

When a user message arrives, Axis checks for a matching plan in the plan replay cache before
dispatching to Scout:

1. Embed the user message and compare against embeddings of past messages that led to
   successful plan executions (cosine similarity > configurable threshold, default: 0.95).
2. If a match is found, retrieve the cached execution plan.
3. Validate that the cached plan is still executable (all referenced Gear exist and are
   enabled, all actions still exist in manifests).
4. Send the cached plan to Sentinel for validation (Sentinel Memory may auto-approve).
5. If Sentinel approves, execute directly — Scout is never called.

```
User: "Turn off the living room lights"
       |
       v
Check plan replay cache (embedding similarity)
       |
       +--- Match found (>0.95 similarity) ---> Validate plan still executable
       |                                              |
       |                                         +--- Valid ---> Sentinel review
       |                                         |                    |
       |                                         |               (Sentinel Memory
       |                                         |                likely auto-approves)
       |                                         |                    |
       |                                         |                Execute Gear
       |                                         |
       |                                         +--- Invalid (Gear removed, etc.)
       |                                                   |
       |                                              Fall through to Scout
       |
       +--- No match --------------------------------> Full path (Scout plans)
```

**Latency impact:**

| Path | LLM Calls | Expected Latency |
|------|-----------|-----------------|
| Fast path (conversational) | 1 (Scout) | 2-5 seconds |
| Known-plan path (cache hit + Sentinel Memory hit) | 0 | 200-500ms |
| Known-plan path (cache hit + Sentinel LLM review) | 1 (Sentinel) | 2-5 seconds |
| Full path (first time or novel task) | 2 (Scout + Sentinel) | 4-10 seconds |

**Cache management:**

- Plans are cached after successful execution, keyed on the user message embedding.
- Cache entries include the original message, the plan, and execution metadata.
- Entries are invalidated when: the referenced Gear is updated or removed, the user explicitly
  requests replanning ("do this differently"), or the cached plan fails on replay.
- Cache size is bounded (default: 500 entries, LRU eviction).
- The cache is stored in `meridian.db`, not in memory, so it survives restarts.

**Safety properties:**

- Cached plans still go through Sentinel validation. The plan replay cache skips Scout, not
  Sentinel.
- If a cached plan is rejected by Sentinel (perhaps because policies changed), it is evicted
  from the cache and the request falls through to the full path.
- Users can disable the plan replay cache entirely if they prefer every task to go through
  Scout. Disabled by default for the first week of use to allow the system to build up reliable
  plan history.
```

**4.5 — Amend step 4 (Path Selection):**

Current:
> 4. **Path Selection**: Scout determines whether this is a fast-path (conversational, no action needed) or full-path (requires Gear execution) interaction. Fast-path responses are returned directly — skip to step 9.

Proposed:
> 4. **Path Selection**: Axis first checks the plan replay cache for a matching known plan (see 4.3.2). If a valid cached plan is found, skip to step 6 (validation) without invoking Scout. If no cache match, Axis dispatches to Scout. Scout determines whether this is a fast-path (conversational, no action needed) or full-path (requires Gear execution) interaction. Fast-path responses are returned directly — skip to step 9.

---

## Patch 3: Expand Built-in Gear & Promote MCP Compatibility to Launch

**Severity**: High
**Review Finding**: #4 — Integration Gaps: The Cold Start Problem, #12 — Community Ecosystem: The Bootstrap Problem
**Target Section**: 5.6.5 (Built-in Gear), 9.4 (MCP Compatibility)

### Rationale

The reviewer identifies 6 built-in Gear as insufficient for day-one utility. Self-hosters need at minimum: email, calendar, SSH, Docker, Home Assistant, MQTT, and webhooks. Shipping a "thin platform" is architecturally sound, but the line between "thin platform" and "platform that does nothing useful" matters for adoption. The reviewer also identifies MCP-server-as-Gear wrapping as the fastest path to a useful Gear catalog — making it a launch feature rather than future consideration dramatically improves the cold start problem.

### Changes

**5.6.5 — Replace the built-in Gear table with an expanded set:**

```markdown
Meridian ships with two tiers of built-in Gear:

**Core primitives** — foundational capabilities used by other Gear and by Journal's Gear
Synthesizer:

| Gear | Purpose | Risk Level |
|------|---------|------------|
| `file-manager` | Read, write, list, and organize files in the workspace | Medium |
| `web-search` | Search the web using a privacy-respecting engine (SearXNG or similar) | Low |
| `web-fetch` | Fetch and parse web page content | Low |
| `shell` | Execute shell commands (requires explicit user approval per-command) | Critical |
| `scheduler` | Create, update, and delete scheduled jobs | Medium |
| `notification` | Send notifications through Bridge | Low |

**Starter integrations** — turnkey Gear covering common self-hosting use cases:

| Gear | Purpose | Risk Level |
|------|---------|------------|
| `email` | Send and receive email via IMAP/SMTP. Supports IDLE for push. | Medium |
| `calendar` | Read and manage events via CalDAV (supports Google Calendar, Nextcloud, etc.) | Medium |
| `ssh-remote` | Execute commands on remote hosts via SSH key authentication | Critical |
| `docker-manage` | List, start, stop, restart, and inspect Docker containers (local or remote via SSH) | High |
| `home-assistant` | Control devices and read state via the Home Assistant REST API | Medium |
| `webhook` | Receive inbound HTTP webhooks and trigger jobs via Axis's event bus | Medium |
| `rss-feed` | Fetch, parse, and filter RSS/Atom feeds | Low |
| `git-ops` | Clone, pull, push, and manage git repositories | High |
| `rest-api` | Generic HTTP client for interacting with any REST API. Accepts OpenAPI specs to auto-generate actions. | Medium |

Starter integrations are built to the same quality standard as core primitives — full
manifests, sandbox compliance, and tests. They are included in the default installation but
can be individually disabled.

The `rest-api` Gear deserves special attention: given an OpenAPI/Swagger specification URL or
file, it auto-generates Gear actions for each endpoint, with parameters derived from the spec's
schema. This allows users to wrap any documented HTTP API without writing Gear code.
```

**9.4 — Replace the MCP section header and content:**

Current header:
> #### 9.4 MCP (Model Context Protocol) Compatibility

New header and content:
```markdown
#### 9.4 MCP (Model Context Protocol) Compatibility

Anthropic's Model Context Protocol (MCP) is an emerging standard for LLM-tool integration.
Meridian supports MCP compatibility as a launch feature, not a future consideration — it is the
fastest path to a broad Gear catalog.

**MCP-server-as-Gear adapter (launch feature):**

Any existing MCP server can be wrapped as a Gear with minimal configuration. The adapter:

1. Reads the MCP server's tool declarations (names, descriptions, parameter schemas).
2. Auto-generates a Gear manifest with actions mapped from MCP tools.
3. Wraps MCP tool calls in Meridian's sandbox and permission model.
4. Routes MCP server stdio/SSE transport through Axis's message bus.

The user installs an MCP server as a Gear by pointing Meridian at the server's configuration:

```toml
[gear.mcp-adapters.github]
command = "npx @modelcontextprotocol/server-github"
env = { GITHUB_TOKEN = "secret:github-token" }
# Permissions are inferred from MCP tool declarations + user overrides
```

The adapter inherits Meridian's full security model: the MCP server runs inside a Gear
sandbox, its network access is restricted to declared domains, and its actions go through
Sentinel validation like any other Gear.

**Gear-as-MCP-server (future):**

Each Gear can optionally expose its actions as MCP tools, making them usable by any
MCP-compatible LLM client. This is a future feature.

**Native MCP tool-use (future):**

Scout's LLM calls can use MCP's tool-use protocol directly when the provider supports it.
This is a future optimization.
```

---

## Patch 4: Tiered Offline Mode

**Severity**: High
**Review Finding**: #5 — Offline Capability: Needs More Thought
**Target Section**: 4.4 (Graceful Degradation)

### Rationale

The reviewer notes that the graceful degradation table treats "both APIs unreachable" as a single state (queue everything). But Meridian already supports Ollama as a launch-day provider, so "offline" is not binary — it depends on whether local models are configured. The architecture needs to define tiered offline behavior and provide guidance on local model performance expectations for a system designed to run on a Pi.

### Changes

**4.4 — Replace the "Both APIs unreachable" row in the graceful degradation table and add a new subsection:**

Replace the row:
> | Both APIs unreachable | System enters "offline mode." Accepts messages, queues jobs, but cannot execute. Resumes automatically when connectivity returns. |

With:
> | Cloud APIs unreachable (no local model configured) | System enters "offline mode." Accepts messages, queues jobs, but cannot execute. Resumes automatically when connectivity returns. |
> | Cloud APIs unreachable (local model configured) | System enters "local mode." See Section 4.4.1 for tiered behavior. |

**4.4 — Add new subsection:**

```markdown
#### 4.4.1 Tiered Offline Behavior

When configured with a local LLM via Ollama (or similar), Meridian supports tiered offline
operation rather than a binary online/offline state:

**Tier 1: Full local operation**

When both Scout and Sentinel are configured with local models, the system continues operating
without cloud connectivity. However, local model capabilities are limited:

| Task Type | Local Model Suitability | Behavior |
|-----------|------------------------|----------|
| Plan replay (known-plan path, Section 4.3.2) | Excellent — no Scout LLM call needed | Execute cached plans directly, Sentinel Memory auto-approves |
| Simple single-Gear tasks | Good — 7B+ models handle well-defined single-step plans | Execute normally via local Scout + Sentinel |
| Multi-step planning | Limited — smaller models produce less reliable plans | Attempt locally, fall back to queuing if plan fails pre-validation |
| Complex reasoning / ambiguous requests | Poor — smaller models underperform | Queue for cloud execution when connectivity returns |

**Tier 2: Hybrid operation (recommended)**

When the primary Scout model is cloud-based and a local model is configured as a fallback:

- Simple tasks and cached plan replays execute locally.
- Complex tasks that fail local planning are queued with a notification to the user.
- When connectivity returns, queued jobs are processed automatically.

**Tier 3: Queue-only**

When no local model is configured and cloud APIs are unreachable, all jobs are queued.
Messages are accepted and stored. The user is notified that jobs are pending. Execution
resumes automatically when connectivity returns.

**Local model guidance:**

For users considering local models, the following guidance applies:

| Device | Recommended Model | Use Case |
|--------|------------------|----------|
| Raspberry Pi 4/5 (8 GB) | Phi-3 Mini (3.8B, Q4) or similar | Sentinel only (plan review is a constrained task) |
| Mac Mini (16 GB) | Llama 3 8B (Q4) or Mistral 7B (Q4) | Scout for simple tasks + Sentinel |
| VPS (8+ GB) | Llama 3 8B (Q8) or larger | Full Scout + Sentinel |

These are starting recommendations. Actual model performance for Meridian's task types
(structured plan generation, plan safety review) should be benchmarked and published as part
of the project's documentation. The plan replay cache (Section 4.3.2) significantly reduces
reliance on Scout's planning capability in local mode — most repeated tasks bypass Scout
entirely.
```

---

## Patch 5: First-Run Experience

**Severity**: High
**Review Finding**: #1 — Setup Friction: How Long Until My First Useful Task?
**Target Section**: 5.5 (Bridge) — add new subsection 5.5.8

### Rationale

The reviewer estimates 10-20 minutes to first task, which is acceptable, but notes that "the real setup time is unbounded" because useful Gear may not exist. The architecture should define a first-run experience that demonstrates value immediately. This is an architectural concern, not just UX polish — it defines what the system must be capable of out of the box.

### Changes

**5.5 — Add new subsection 5.5.8 after Accessibility:**

```markdown
#### 5.5.8 First-Run Experience

On first launch, Bridge presents a setup wizard designed to get the user from installation to
their first completed task in under 15 minutes:

**Step 1: Create account** (mandatory)
- Set username and password. Explain why auth is required even on localhost.

**Step 2: Configure LLM provider** (mandatory)
- Offer three tiers:
  - **Quick start (one API key)**: Same provider for Scout and Sentinel. Budget configuration
    (Section 5.3.6). Lowest setup friction, acceptable security.
  - **Recommended (two API keys)**: Different providers for Scout and Sentinel. Explain the
    security benefit in one sentence.
  - **Fully local**: Configure Ollama. Link to model download instructions. Warn about
    capability limitations.
- Validate the API key(s) with a test call before proceeding.

**Step 3: Demo task**
- Run a pre-built demo task end-to-end to show the full pipeline in action. The demo task
  should use only built-in Gear (e.g., "Search the web for today's top news and save a
  summary to a file in the workspace").
- Show the user each step as it happens: Scout planning, Sentinel validating, Gear executing,
  result displayed. This teaches the system's mental model through demonstration.
- The demo task's approval prompt is the user's first interaction with the approval UX.

**Step 4: Optional integrations**
- Present the starter Gear catalog (Section 5.6.5) and let the user enable the ones relevant
  to their setup.
- For Gear that require secrets (email credentials, Home Assistant API key, SSH keys), walk
  through adding them to the vault.

The wizard stores progress so it can be resumed if interrupted. After completion, Bridge opens
to the main conversation interface with a welcome message summarizing what was configured and
suggesting 2-3 tasks the user can try based on their enabled Gear.
```

---

## Patch 6: Cost Tracking Dashboard

**Severity**: Medium
**Review Finding**: #2 — The Dual-LLM Cost Problem
**Target Section**: 5.3.7 (Cost Implications), 11.1 (Cost Tracking)

### Rationale

The reviewer calculates projected costs ($20-35/month for moderate use before savings) and notes the architecture lists seven cost mitigations but does not quantify their impact or give users visibility into actual costs. For self-hosters who track every dollar spent on their infrastructure, cost transparency is essential. Sentinel Memory and caching savings are potentially significant but invisible without a dashboard.

### Changes

**5.3.7 — Add after the cost mitigations list:**

```markdown
**Projected cost ranges:**

For transparency, here are projected monthly costs under different usage patterns. These are
estimates based on mid-2026 API pricing and will vary by provider:

| Usage Level | Tasks/Day | Monthly Cost (no savings) | With Sentinel Memory (est. 70-80% hit) | With all mitigations |
|-------------|-----------|--------------------------|----------------------------------------|---------------------|
| Light | 10-20 | $5-15 | $3-10 | $2-7 |
| Moderate | 30-50 | $15-35 | $8-18 | $5-12 |
| Heavy | 80-100+ | $35-70 | $18-35 | $10-25 |

These ranges assume a mix of fast-path and full-path tasks, adaptive model selection (secondary
model for ~60% of simple dispatches), and journal-skip for information retrieval. The "with all
mitigations" column includes Sentinel Memory auto-approval, semantic/exact-match caching, and
journal-skip. Actual savings depend on how repetitive the user's tasks are — highly repetitive
usage patterns (common for scheduled automation) see the largest savings.

These projections are *estimates* — actual costs are tracked precisely (see below).
```

**11.1 — Expand the Cost Tracking section:**

Current:
> #### Cost Tracking
> - Track token usage per API call (input tokens, output tokens, cached tokens).
> - Aggregate daily/weekly/monthly costs based on provider pricing.
> - Alert when approaching the daily cost limit (at 80% and 95%).
> - Hard stop when the daily limit is reached (configurable override for critical tasks).

Proposed:
```markdown
#### Cost Tracking

- Track token usage per API call (input tokens, output tokens, cached tokens).
- Aggregate daily/weekly/monthly costs based on provider pricing.
- Alert when approaching the daily cost limit (at 80% and 95%).
- Hard stop when the daily limit is reached (configurable override for critical tasks).

**Cost dashboard (Bridge):**

Bridge includes a cost dashboard accessible from the settings panel, showing:

- **Today/this week/this month**: Total LLM API cost, broken down by component (Scout,
  Sentinel, Journal Reflector) and by model (primary vs. secondary).
- **Savings breakdown**: How much was saved by each mitigation:
  - Sentinel Memory auto-approvals (Sentinel LLM calls avoided)
  - Plan replay cache hits (Scout LLM calls avoided)
  - Semantic/exact-match cache hits (Scout LLM calls avoided)
  - Fast-path routing (Sentinel calls avoided)
  - Journal-skip (Reflector calls avoided)
  - Adaptive model selection (cost difference between primary and secondary model)
- **Sentinel Memory hit rate**: Percentage of full-path tasks auto-approved via precedent.
  This metric doubles as a "trust maturity" indicator (see Section 5.3.8).
- **Cost per task type**: Average cost by task category, helping users identify expensive
  patterns.
- **Trend**: Cost trend over the last 30 days, showing whether costs are stabilizing as the
  system learns.
```

---

## Patch 7: Remote Access Patterns & Mobile Approval UX

**Severity**: Medium
**Review Finding**: #7 — Mobile Access: The Reverse Proxy Gap
**Target Section**: 6.5 (Network Security) — add new subsection, 5.5.5 (Notification System)

### Rationale

The reviewer points out that a system requiring approval of background tasks must have a solid remote approval story. The architecture mandates TLS for remote access and mentions reverse proxy support, but does not recommend specific patterns or describe mobile approval UX. For an assistant that runs scheduled background tasks, the ability to approve from a phone is not optional.

### Changes

**6.5 — Add new subsection after the existing content:**

```markdown
#### 6.5.1 Recommended Remote Access Patterns

For users who need to access Bridge from outside their local network (e.g., approving tasks
from a phone), the following patterns are recommended, ranked by security:

| Pattern | Security | Convenience | Setup Complexity |
|---------|----------|-------------|-----------------|
| **VPN (Tailscale/WireGuard)** | Excellent — no public exposure | Good — requires VPN client on devices | Low (Tailscale) to Medium (WireGuard) |
| **Reverse proxy + TLS + SSO** | Good — exposed but authenticated | Good — standard HTTPS access | Medium |
| **Cloudflare Tunnel / ngrok** | Good — zero-trust, no open ports | Excellent — standard HTTPS, no VPN | Low |
| **Direct TLS exposure** | Acceptable — depends on Bridge auth | Excellent — direct HTTPS | Medium |

**Recommended for most self-hosters**: VPN (Tailscale) for zero-configuration secure access,
or Cloudflare Tunnel for convenience without opening firewall ports. Bridge provides hardened
Nginx and Caddy reverse proxy configurations in the documentation for users who prefer that
approach.

All patterns require Bridge's mandatory authentication. Remote access never bypasses
authentication, even when behind a VPN or reverse proxy.
```

**5.5.5 — Add to the Notification System section:**

```markdown
**Mobile approval actions:**

For approval notifications (Sentinel's `needs_user_approval` verdicts), Bridge supports
actionable notifications that allow one-tap approve/reject without opening the full UI:

- **Web Push**: Notifications include action buttons ("Approve" / "Reject" / "View Details").
  Tapping Approve or Reject sends the decision directly via the notification's service worker,
  requiring only the authenticated session cookie.
- **Webhook-based**: For users who forward notifications to Telegram, Discord, or Slack via
  the notification Gear, Bridge generates a time-limited, single-use approval URL that can be
  embedded in the message. The URL expires after 1 hour and is valid for one use only.

Approval actions via push notifications or webhook URLs are logged in the audit trail with
`approvalMethod: "push"` or `approvalMethod: "webhook-url"` to distinguish them from
in-app approvals. Sentinel Memory records the decision identically regardless of approval
method.
```

---

## Patch 8: Resource Usage Estimates

**Severity**: Medium
**Review Finding**: #10 — Resource Impact: The Pi Question
**Target Section**: 10.1 (Target Environments)

### Rationale

The reviewer runs 15+ containers on a Pi 4 with ~4.8 GB free and needs to know whether Meridian fits. The architecture lists target environments but provides no resource estimates. For a system designed for constrained devices, resource expectations are architectural documentation, not afterthought.

### Changes

**10.1 — Add after the target environments table:**

```markdown
#### 10.1.1 Expected Resource Usage

The following are projected resource requirements. Actual measurements will be published after
initial development.

**Meridian core (Axis + Bridge + Scout/Sentinel clients + Journal):**

| State | RAM (est.) | CPU | Disk |
|-------|-----------|-----|------|
| Idle | 150-250 MB | < 1% | — |
| Processing a task (1 active job) | 250-400 MB | 5-15% | — |
| Peak (max concurrent workers) | 400-600 MB | 20-40% | — |

**Data storage growth:**

| Data | Growth Rate (est.) | Notes |
|------|--------------------|-------|
| Databases (meridian.db + journal.db + sentinel.db + audit.db) | ~1-5 MB/day at moderate use | Depends on task volume and memory retention |
| Vector embeddings (journal-vectors.db) | ~0.5-2 MB/day | Depends on memory creation rate |
| Workspace files | User-dependent | Configurable quotas |
| Logs | ~5-20 MB/day | 7-day rotation by default |

**Optional components:**

| Component | Additional RAM | Notes |
|-----------|---------------|-------|
| Local embeddings (Ollama + nomic-embed-text) | 500 MB - 1 GB | Ollama runtime + model |
| Local Sentinel model (Ollama + 7B Q4) | 4-6 GB | Does not fit alongside a full homelab on 8 GB Pi |
| Local Scout model (Ollama + 7B Q4) | 4-6 GB (shared with Sentinel if same runtime) | Requires dedicated hardware or >=16 GB device |
| SearXNG (for web-search Gear) | ~150 MB | Included in Docker Compose |
| Gear sandbox processes | ~50-100 MB each | Process-level; 2 concurrent by default on Pi |

**Deployment guidance:**

| Scenario | Fits on Pi 4 (8 GB) alongside homelab? | Recommended? |
|----------|---------------------------------------|--------------|
| Cloud LLMs, API-based embeddings | Yes (~300-500 MB) | Yes — lowest resource footprint |
| Cloud LLMs, local embeddings | Tight (~800 MB - 1.2 GB) | Yes, if 1+ GB RAM is available |
| Local Sentinel, cloud Scout | Unlikely (~5-7 GB total) | No — use a separate device or Mac Mini |
| Fully local (Scout + Sentinel) | No (~8-12 GB total) | Requires dedicated 16+ GB hardware |

These estimates are conservative. Actual usage will be benchmarked on target hardware during
development, and the resource table will be updated with measured values.
```

---

## Patch 9: Export Format Specification

**Severity**: Medium
**Review Finding**: #9 — Data Portability: Underspecified
**Target Section**: 8.4 (Backup and Recovery)

### Rationale

The reviewer notes that "JSON/Markdown" is not a specification and asks whether data is portable beyond Meridian. The architecture uses SQLite with documented schemas, which is itself a strong portability argument — but the export format needs to be explicitly defined and versioned. Sentinel Memory portability is also unaddressed.

### Changes

**8.4 — Add new subsection after the existing content:**

```markdown
#### 8.4.1 Export Format Specification

The `meridian export` command produces a versioned, documented archive:

```
meridian-export-v1/
├── manifest.json              # Export metadata (version, timestamp, Meridian version)
├── config.toml                # User configuration
├── memories/
│   ├── episodes.jsonl         # One JSON object per line, episodic memories
│   ├── facts.jsonl            # Semantic memories
│   ├── procedures.jsonl       # Procedural memories
│   └── embeddings.bin         # Binary embedding vectors (with metadata header)
├── sentinel/
│   └── decisions.jsonl        # Sentinel Memory approval decisions
├── gear/
│   ├── registry.json          # Installed Gear metadata
│   └── journal-generated/     # Journal-generated Gear source + manifests
│       ├── <gear-id>/
│       │   ├── manifest.json
│       │   └── src/
├── conversations/
│   └── messages.jsonl         # Conversation history
├── jobs/
│   └── jobs.jsonl             # Job history (plans, results, errors)
├── audit/
│   └── audit.jsonl            # Audit log entries
└── workspace/                 # File workspace (copied as-is)
```

**Format properties:**

- **JSONL (JSON Lines)**: Each line is a self-contained JSON object. This format is trivially
  parseable by any language, streamable, and grep-friendly.
- **Versioned**: The `manifest.json` includes a `formatVersion` field. Future format changes
  increment this version and include migration instructions.
- **Complete**: The export includes everything needed to reconstruct a working Meridian
  instance: memories, Sentinel decisions, Gear, config, and workspace.
- **Portable**: Memory exports are designed to be useful outside Meridian:
  - `facts.jsonl` entries include `category`, `content`, and `confidence` — usable as a
    personal knowledge base.
  - `procedures.jsonl` entries include `content` and success/failure counts — usable as
    runbooks.
  - `episodes.jsonl` entries include full interaction summaries.

**Selective export**: Users can export subsets: `meridian export --memories-only`,
`meridian export --sentinel-only`, `meridian export --gear-only`.

**Sentinel Memory portability**: Sentinel decisions are included in the export. When
importing to a new Meridian instance (`meridian restore`), Sentinel Memory is restored,
preserving all standing approvals. This avoids the bootstrapping problem of re-approving
everything after a rebuild.

**SQLite as escape hatch**: All databases use documented schemas (Section 8.3) and standard
SQLite. Users can always query the databases directly with any SQLite tool (`sqlite3`,
DB Browser for SQLite, Python's `sqlite3` module, etc.) without relying on Meridian's export
command. The databases are the source of truth; the export format is a convenience layer.
```

---

## Patch 10: Concrete Learning Pipeline Examples

**Severity**: Medium
**Review Finding**: #11 — The "Learning" Promise: Skepticism Required
**Target Section**: 5.4.3 (Reflection & Gear Building Pipeline)

### Rationale

The reviewer stress-tests the learning promise across three scenarios (preference learning, procedure learning, Gear synthesis) and finds the architecture theoretical — no concrete examples of Reflector output, Gear Synthesizer output, or learning progression. Adding concrete examples makes the architecture tangible and sets expectations for what the learning pipeline actually produces.

### Changes

**5.4.3 — Add after the Gear Synthesizer pipeline diagram, before "When does Journal create a Gear?":**

```markdown
**Concrete example: Reflection output**

Given a completed task "Deploy my blog" that ran shell commands (`git pull`, `npm install`,
`npm run build`, `pm2 restart blog`), the Reflector produces:

Phase 1 (deterministic extraction):
```json
{
  "taskId": "01902a4b-...",
  "outcome": "success",
  "steps": [
    { "gear": "shell", "action": "execute", "command": "git pull", "exitCode": 0, "durationMs": 2340 },
    { "gear": "shell", "action": "execute", "command": "npm install", "exitCode": 0, "durationMs": 18420 },
    { "gear": "shell", "action": "execute", "command": "npm run build", "exitCode": 0, "durationMs": 8950 },
    { "gear": "shell", "action": "execute", "command": "pm2 restart blog", "exitCode": 0, "durationMs": 1200 }
  ],
  "totalDurationMs": 30910,
  "tokenCost": { "scout": 1850, "sentinel": 920 }
}
```

Phase 2 (LLM analysis on Phase 1 facts):
```json
{
  "memories": [
    {
      "type": "procedural",
      "content": "To deploy the user's blog: 1) git pull in the blog directory, 2) npm install, 3) npm run build, 4) pm2 restart blog. All steps use the shell Gear.",
      "confidence": 0.5
    },
    {
      "type": "semantic",
      "content": "The user's blog uses Node.js with pm2 as the process manager.",
      "confidence": 0.8
    }
  ],
  "gearCandidate": null,
  "notes": "First occurrence of this task pattern. Procedure recorded at low confidence. If repeated successfully 2 more times, confidence will increase and Gear Synthesizer may create a blog-deploy Gear."
}
```

**Learning progression:**

| Occurrence | What Happens |
|------------|-------------|
| 1st "deploy my blog" | Full Scout planning + Sentinel review. Procedure stored at 0.5 confidence. |
| 2nd (same pattern) | Scout retrieves procedure from Journal, produces a faster plan. Procedure confidence increases to 0.7. Plan cached in replay cache. |
| 3rd (same pattern) | Plan replay cache hit — Scout skipped entirely. Sentinel Memory auto-approves. Procedure confidence reaches 1.0. Gear Synthesizer evaluates whether to create a `blog-deploy` Gear. |
| Subsequent | Sub-second execution via plan replay + Sentinel Memory. If Gear was synthesized and approved, future plans reference the Gear directly instead of raw shell commands. |
| Failure (e.g., npm install fails) | Plan replay cache entry evicted. Journal reflects on the failure. Procedure updated with failure context ("npm install can fail if node_modules is corrupted — add rm -rf node_modules as a recovery step"). |

**What the learning pipeline does NOT do:**

- It does not modify LLM weights. All "learning" is retrieval-augmented knowledge
  accumulation — storing facts, procedures, and preferences that are retrieved as context.
- It does not make novel creative leaps. Gear synthesis composes existing capabilities;
  it does not invent new algorithms.
- It does not guarantee improvement. The Reflector can extract incorrect causal explanations
  (mitigated by two-phase reflection, see Phase 1/Phase 2 above). Procedures start at low
  confidence and must prove themselves through repeated success.
```

---

## Patch 11: Position as Orchestration Layer

**Severity**: Low
**Review Finding**: #8 — Competing With Existing Solutions: The Value Gap
**Target Section**: 2 (Executive Summary)

### Rationale

The reviewer runs Home Assistant, n8n, and Ollama + Open WebUI — and notes that Meridian's value is not replacing these tools but orchestrating them. The architecture does not explicitly position Meridian as an orchestration layer, which is a missed framing opportunity. This is less about adding new architecture and more about clarifying the existing architecture's purpose.

### Changes

**Section 2 — After "Core Principles", before "Key Differentiators", add:**

```markdown
### Intended Role

Meridian is not a replacement for existing automation tools (Home Assistant, n8n, IFTTT) or
chat interfaces (Open WebUI, ChatGPT). It is an **intelligent orchestration layer** that sits
in front of existing tools and makes them accessible through natural language.

The value proposition is:
1. **Natural language decomposition**: Turn "set up a new Node project with testing and deploy
   it to my VPS" into a structured, executable plan — something no workflow tool does today.
2. **Adaptive learning**: The system improves at the user's specific tasks over time, building
   procedures and Gear that encode what works.
3. **Independent safety validation**: Unlike unchecked automation, every plan is reviewed by an
   independent validator before execution.
4. **Unified interface**: One conversational interface to many backend tools, rather than
   context-switching between UIs.

Meridian achieves the broadest utility when connected to tools the user already runs — the
starter Gear catalog (Section 5.6.5) and MCP adapter (Section 9.4) are designed to make
existing infrastructure smarter, not to replace it.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|-------------------|
| 1 | Trust escalation, approval profiles, quiet hours, bootstrapping metrics | Critical | 5.3.8 |
| 2 | Plan replay cache for known patterns (skip Scout) | Critical | 4.3 (new 4.3.2), 4.5 |
| 3 | Expand built-in Gear to 15, promote MCP adapter to launch | High | 5.6.5, 9.4 |
| 4 | Tiered offline mode with local model guidance | High | 4.4 (new 4.4.1) |
| 5 | First-run setup wizard | High | 5.5 (new 5.5.8) |
| 6 | Cost projections table and cost/savings dashboard | Medium | 5.3.7, 11.1 |
| 7 | Remote access patterns and mobile approval UX | Medium | 6.5 (new 6.5.1), 5.5.5 |
| 8 | Resource usage estimates per deployment scenario | Medium | 10.1 (new 10.1.1) |
| 9 | Versioned export format specification with JSONL | Medium | 8.4 (new 8.4.1) |
| 10 | Concrete learning pipeline examples and progression | Medium | 5.4.3 |
| 11 | Position Meridian as orchestration layer | Low | 2 |
