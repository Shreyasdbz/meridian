# Architecture Patches: Non-Technical User Review

> **Source**: `docs/critics/non-technical-user.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

**Scope note:** The non-technical user review raises many product-level concerns (mobile app, one-click installer, built-in AI subscription, voice wake words). Some of these are product decisions beyond the scope of an architecture document. The patches below focus on concerns that *do* have architectural implications — places where the architecture can be amended to make the product more usable without compromising its technical foundations.

---

## Patch 1: Define an Onboarding Architecture

**Severity**: Critical
**Review Finding**: #1 (Installation), #3 (API Keys), #10 (Self-Hosting Tax)
**Target Section**: 10.2 (Installation) and 10.4 (Configuration)

### Rationale

The reviewer identifies installation and API key configuration as the single largest barriers to adoption. The architecture describes four CLI-based installation methods and a TOML config file, but no guided onboarding flow. The first-run setup wizard is mentioned once (Section 5.5.6 for authentication) but not specified as a comprehensive onboarding experience. For any non-developer user — and even for many developers — a guided setup flow is the difference between a working system and an abandoned one.

### Changes

**10.2 — Add after the existing installation commands:**

```markdown
#### 10.2.1 First-Run Setup Wizard

Regardless of installation method, the first time Meridian starts it launches a guided setup
wizard served through Bridge. No terminal interaction is required after the initial install
command. The wizard walks the user through all required configuration in a step-by-step web UI:

**Step 1: Account Creation**
- Create a username and password for Bridge authentication.
- Optional TOTP setup for two-factor authentication.

**Step 2: LLM Provider Configuration**
- Select a provider from a visual list (Anthropic, OpenAI, Google, Ollama/local).
- For cloud providers: a guided flow with direct links to the provider's API key page,
  annotated screenshots of where to find the key, and a "Test Connection" button that
  verifies the key works before proceeding.
- For Ollama: detect whether Ollama is already running locally. If not, provide a one-click
  install link and model download guidance.
- **Single-provider default**: The wizard defaults to configuring one provider for both Scout
  and Sentinel (the "Balanced" configuration from Section 5.3.6). The option to use separate
  providers is available under an "Advanced" toggle but not required.

**Step 3: Cost Controls**
- Display the daily cost limit (default: $5.00) with a plain-language explanation:
  "This limits how much Meridian spends on AI API calls per day. For typical use, expect
  $1–3/day. You can change this anytime."
- Allow the user to adjust the limit with a slider.
- Link to the cost tracking dashboard (available in Bridge after setup).

**Step 4: Workspace Configuration**
- Select a workspace directory for Meridian's file operations (default provided).
- Explain what the workspace is in plain language.

**Step 5: Quick Preference Capture**
- 3–5 optional questions to seed Journal's semantic memory: preferred name, primary use case
  (personal productivity, development, home automation, general), communication style
  preference.

**Step 6: Ready**
- Summary of configuration choices.
- "Start using Meridian" button that opens the main conversation interface.
- Link to an interactive tutorial that walks through a first task.

The setup wizard stores all configuration in the `config` table and config file — the same
configuration that can be manually edited later. The wizard is re-accessible from Bridge
settings for reconfiguration.
```

**10.4 — Add to the configuration precedence hierarchy:**

```markdown
5. **Setup wizard**: First-run guided configuration (writes to config file and config table).
   The wizard is the primary configuration method for non-technical users; all other methods
   are for advanced users and automation.
```

---

## Patch 2: Define Tiered Approval Defaults with Fast-Learning

**Severity**: Critical
**Review Finding**: #4 (Approval Fatigue)
**Target Section**: 5.3.5 (Default Risk Policies) and 5.3.8 (Sentinel Memory)

### Rationale

The reviewer describes the approval system as a "paranoid bureaucrat" and identifies approval fatigue as a primary usability concern. The current defaults require user approval for sending messages, network POST requests, and most write operations. For a user who says "email John about dinner Friday," this means an interruption for something they explicitly requested. The reviewer acknowledges Sentinel Memory helps over time but argues the first week will be an "endless parade" of approvals.

The fix is not to weaken security but to refine what "user-initiated action" means. When the user explicitly requests an action in their message, the approval bar should be lower than when the system initiates an action autonomously (e.g., from a scheduled job or as a sub-step the user didn't directly request).

### Changes

**5.3.5 — Replace the default risk policies table with a tiered model:**

```markdown
#### 5.3.5 Default Risk Policies

Risk policies distinguish between **user-initiated actions** (the user explicitly asked for
this in their message) and **system-initiated actions** (side effects, sub-steps, scheduled
jobs, or actions the user didn't directly request). User-initiated actions have a lower
approval bar because the user's message itself is a form of intent.

| Action Type | User-Initiated | System-Initiated |
|-------------|---------------|-----------------|
| Read local files | Approved (within allowed paths) | Approved (within allowed paths) |
| Write/modify files in workspace | Approved | Approved |
| Write/modify files outside workspace | Needs user approval | Needs user approval |
| Delete files | Needs user approval | Always needs user approval |
| Network requests (GET) | Approved for allowlisted domains | Approved for allowlisted domains |
| Network requests (POST/PUT/DELETE) | Approved when directly requested | Needs user approval |
| Shell command execution | Needs user approval | Always needs user approval |
| Credential usage | Approved for declared Gear, logged | Approved for declared Gear, logged |
| Financial transactions | Always needs user approval, hard limit check | Always needs user approval, hard limit check |
| Sending messages (email, chat) | Approved when directly requested | Needs user approval |
| System configuration changes | Always needs user approval | Always needs user approval |

**How Scout signals user-initiated intent:**

When Scout produces an execution plan, each step includes a `userDirected: boolean` field
indicating whether the user explicitly requested this action. Sentinel independently evaluates
whether the `userDirected` claim is plausible given the plan context — a plan that claims
every step is user-directed when the user's request was simple would be flagged as anomalous.

**Hard-floor policies:** Financial transactions, system configuration changes, and shell
command execution always require user approval regardless of initiation source. These
hard-floor policies cannot be weakened by Sentinel Memory or user-initiated classification.
Users can make other policies stricter (but not weaker than the above defaults) through
Bridge settings.
```

**5.3.8 — Add after "Safety properties":**

```markdown
**Accelerated learning period:** During the first 14 days of use (configurable), Sentinel
Memory aggressively generalizes from approvals to reduce approval fatigue during onboarding.
For example:

- If the user approves sending an email to one address, Sentinel Memory generalizes to
  "allow sending emails to any address" (not just the specific one).
- If the user approves a web search, Sentinel Memory generalizes to "allow all GET network
  requests."
- If the user approves deleting a file in a specific directory, Sentinel Memory generalizes
  to "allow file deletion within that directory" (not system-wide).

Generalizations are logged and visible in Bridge. After the learning period, generalization
becomes more conservative (scope-matched rather than category-matched). The user can review
and revoke any generalized permission at any time.

**Batched approvals:** When a plan contains multiple steps that each require approval,
Sentinel batches them into a single approval prompt rather than interrupting the user per-step.
The prompt shows all pending actions in a checklist format, and the user can approve all,
reject all, or approve/reject individually.
```

---

## Patch 3: Expand Built-In Gear for Day-One Utility

**Severity**: Critical
**Review Finding**: #6 (Limited Day-One Capabilities)
**Target Section**: 5.6.5 (Built-in Gear)

### Rationale

The reviewer's core complaint is that Meridian ships with almost nothing useful — no email, no calendar, no weather, no reminders. The "thin platform" philosophy means users must wait for Journal to build capabilities or install Gear that doesn't exist yet. This is a cold-start problem: the system needs task execution to learn, but users won't execute tasks if the system can't do anything they care about.

The fix is to expand the built-in Gear set to cover the most common assistant use cases, while keeping each Gear simple and sandboxed.

### Changes

**5.6.5 — Replace the built-in Gear table:**

```markdown
#### 5.6.5 Built-in Gear

Meridian ships with built-in Gear covering foundational operations and common assistant use
cases. The goal is day-one utility: a new user should be able to perform their most common
assistant tasks without installing additional Gear.

**Foundational Gear** (primitive capabilities used by other Gear and Journal):

| Gear | Purpose | Risk Level |
|------|---------|------------|
| `file-manager` | Read, write, list, and organize files in the workspace | Medium |
| `web-search` | Search the web using a privacy-respecting engine (SearXNG or similar) | Low |
| `web-fetch` | Fetch and parse web page content | Low |
| `shell` | Execute shell commands (requires explicit user approval per-command) | Critical |
| `scheduler` | Create, update, and delete scheduled jobs | Medium |
| `notification` | Send notifications through Bridge | Low |

**Everyday Gear** (common assistant tasks):

| Gear | Purpose | Risk Level |
|------|---------|------------|
| `email` | Send and read email via IMAP/SMTP (configured during setup or on first use) | High |
| `calendar` | Read and manage calendar events via CalDAV (Google Calendar, iCloud, etc.) | Medium |
| `reminders` | Create, list, and manage reminders with natural language time parsing | Low |
| `weather` | Fetch weather forecasts via a free weather API (Open-Meteo or similar) | Low |
| `notes` | Create, search, and manage plaintext/markdown notes in the workspace | Low |

**Everyday Gear** requires initial configuration (email credentials, calendar URL, location for
weather) which is handled through Bridge's settings UI with guided setup flows — the same
pattern as the first-run wizard. Gear that requires credentials uses the secrets vault
(Section 6.4) and declares its secret requirements in its manifest.

This expanded set provides enough day-one utility that a new user can accomplish real tasks
immediately, while still keeping the platform's "thin core" principle — all Gear above
follows the same sandboxed, manifest-declared, Sentinel-validated pipeline as any other Gear.
Journal can still compose and extend these into more specialized workflows.
```

---

## Patch 4: Add Cost Estimation and Transparency

**Severity**: High
**Review Finding**: #5 (Unclear Costs)
**Target Section**: 11.1 (Cost Tracking) and 5.5.1 (Bridge Responsibilities)

### Rationale

The reviewer cannot determine what Meridian will cost to use. The architecture tracks costs internally but never specifies how this information is surfaced to users. For a system where every action incurs variable API costs, cost transparency is a usability requirement, not a nice-to-have.

### Changes

**11.1 — Expand the Cost Tracking section:**

```markdown
#### Cost Tracking and Transparency

Meridian tracks and surfaces API costs at every level:

**Per-request cost display:** After each task completes, Bridge displays the cost of that
task (input tokens, output tokens, model used, calculated cost) in an expandable detail
panel beneath the response. This is collapsed by default but always accessible.

**Cost dashboard:** Bridge provides a dedicated cost dashboard showing:
- Today's spending vs. daily limit (progress bar)
- 7-day and 30-day spending history (chart)
- Cost breakdown by component (Scout, Sentinel, Journal reflection)
- Cost breakdown by task type (shows which kinds of tasks are most expensive)
- Estimated monthly cost based on current usage patterns

**Cost estimation at setup:** During the first-run wizard (Section 10.2.1), the cost controls
step includes representative cost estimates:

| Usage Level | Approximate Daily Cost | Approximate Monthly Cost |
|-------------|----------------------|------------------------|
| Light (5–10 tasks/day, mostly conversational) | $0.50–$1.50 | $15–$45 |
| Moderate (10–25 tasks/day, mixed) | $1.50–$3.00 | $45–$90 |
| Heavy (25+ tasks/day, complex workflows) | $3.00–$5.00+ | $90–$150+ |

These estimates assume adaptive model selection is enabled and a mix of fast-path and
full-path interactions. Actual costs depend on the user's provider, model choices, and
task complexity. Estimates are updated in Bridge as real usage data accumulates.

**Cost alerts:** Configurable alerts at 50%, 80%, and 95% of the daily cost limit. Alerts
appear as in-app notifications and optionally as browser push notifications.
```

**5.5.1 — Add to Bridge responsibilities:**

```markdown
- Display per-task cost and aggregate cost dashboards
- Surface cost alerts when approaching daily limits
```

---

## Patch 5: Voice Interaction Architecture

**Severity**: High
**Review Finding**: #8 (Voice as Afterthought)
**Target Section**: 5.5.3 (Input Modalities) — expand to new subsection 5.5.3.1

### Rationale

The reviewer identifies voice as the primary way non-technical users interact with assistants, yet the architecture dedicates a single table row to it. The architecture should specify the voice pipeline in enough detail that voice is a first-class interaction mode, not a checkbox feature. This doesn't mean implementing always-on wake words in v1, but it does mean designing the voice pipeline so it *can* support these features and ensuring the initial voice experience is usable.

### Changes

**5.5.3 — Add new subsection after the modality table:**

```markdown
#### 5.5.3.1 Voice Interaction Pipeline

Voice is a first-class input modality, not an accessory to text. The architecture supports
progressive enhancement of voice capabilities:

**v1 Voice Pipeline (launch):**

```
User presses mic button in Bridge
       │
       ▼
Browser captures audio (Web Speech API / MediaRecorder)
       │
       ▼
Audio sent to transcription service
  ├── Local: whisper.cpp via Whisper server (privacy-preserving, ~2-5s latency on Mac Mini)
  └── API: OpenAI Whisper API or provider equivalent (~1-2s latency)
       │
       ▼
Transcribed text enters normal message pipeline (identical to typed text)
       │
       ▼
Response generated by Scout
       │
       ▼
Response displayed as text in Bridge
  AND optionally spoken via Web Speech Synthesis API (browser TTS)
```

**Text-to-speech (TTS) responses:** Bridge includes a toggleable "read responses aloud"
setting. When enabled, responses are spoken using the browser's built-in Web Speech Synthesis
API (zero cost, no external API call, works offline). For higher quality TTS, users can
optionally configure an external TTS provider (e.g., ElevenLabs, OpenAI TTS). TTS is
particularly useful for hands-busy scenarios (cooking, driving).

**Voice configuration:**
- **Transcription provider**: Local (whisper.cpp) or API-based (configurable in Bridge
  settings, same pattern as LLM provider selection).
- **TTS toggle**: On/off, with voice selection from available browser voices.
- **Voice activity detection**: Optional auto-send when the user stops speaking (configurable
  silence threshold, default: 1.5 seconds) so the user doesn't need to press a button to
  stop recording.
- **Continuous conversation mode**: A toggle that keeps the microphone active after a response
  is spoken, enabling back-and-forth conversation without repeated button presses.

**Future voice enhancements (not v1, see Section 16):**
- Wake word detection ("Hey Meridian") using a lightweight local model.
- Companion mobile app with persistent voice access.
- Integration with home speaker devices via local network protocols.
```

**16 — Add new subsection 16.7:**

```markdown
### 16.7 Advanced Voice and Mobile

- **Wake word**: Local wake word detection using a small keyword-spotting model (e.g.,
  Porcupine, openWakeWord). Runs continuously on low power. Once triggered, activates the
  voice pipeline.
- **Mobile app**: Native iOS/Android app (or PWA) that connects to the user's Meridian
  instance. Enables voice interaction, push notifications, and on-the-go access.
- **Home speaker integration**: Bridge extension for Bluetooth or local-network speaker
  devices, enabling ambient voice interaction similar to smart speakers.
```

---

## Patch 6: Simplify Bridge UI for Non-Technical Users

**Severity**: High
**Review Finding**: #2 (Component Complexity Exposed to Users)
**Target Section**: 5.5.2 (Frontend Architecture)

### Rationale

The reviewer is overwhelmed by the six named components, the terminology, and the described UI panels (job queue sidebar, memory browser, Gear management, system logs). The architecture describes a UI suited for developers monitoring a system, not for non-technical users who want a simple assistant. The fix is to specify a layered UI that defaults to simplicity and reveals complexity progressively.

### Changes

**5.5.2 — Add after the existing frontend description:**

```markdown
#### Progressive Disclosure UI

Bridge uses a progressive disclosure model: the default experience is simple, and advanced
features are revealed as users need them.

**Default view (Simple mode):**
- A single conversation thread (chat interface). No sidebars, no panels, no system terminology.
- The user types or speaks. The assistant responds. Approval requests appear inline as
  simple yes/no prompts ("Meridian wants to send an email to john@example.com. Allow?").
- Job status is communicated in natural language within the conversation ("Working on it...",
  "Done.", "I ran into a problem: [explanation]").
- Component names (Axis, Scout, Sentinel, Journal, Gear) are never shown to the user in
  Simple mode. Internally these components exist, but the UI abstracts them into plain
  language: "planning" (Scout), "safety check" (Sentinel), "remembering" (Journal).
- Settings are accessible via a gear icon with a clean, categorized settings page.

**Advanced view (toggle in settings):**
- Enables the full panel set: job queue sidebar, memory browser, Gear management,
  system logs, cost dashboard.
- Shows component names and technical details.
- Useful for developers, power users, and debugging.

**Contextual exposure:** Some advanced features appear contextually even in Simple mode:
- If a task fails, the conversation includes a "See details" link that expands to show
  technical information.
- Cost information appears as a small, unobtrusive indicator (e.g., "$0.03") next to each
  response, expandable for details.
- Memory corrections appear as suggestions: "I'll remember that you prefer dark mode. You can
  manage what I remember in Settings > Memory."

The default mode is Simple. Users are never required to understand the system's internals
to use it effectively. Advanced mode is opt-in for users who want full visibility.
```

---

## Patch 7: Address Reliability Perception

**Severity**: Medium
**Review Finding**: #9 (Reliability Concerns)
**Target Section**: 4.4 (Graceful Degradation)

### Rationale

The reviewer reads the graceful degradation table as a "long list of ways my assistant might not work." The architecture handles failures responsibly, but the failure modes are presented from an engineering perspective (what the system does) rather than a user perspective (what the user experiences). Adding user-facing behavior descriptions addresses the perception gap without changing the underlying engineering.

### Changes

**4.4 — Expand the graceful degradation table to include user-visible behavior:**

```markdown
| Failure | System Behavior | User Experience |
|---------|-----------------|-----------------|
| Scout's LLM API is unreachable | Queue the job, retry with exponential backoff (30s, 1m, 5m, 15m). Notify user after first failure. If a local model is configured, fall back to it. | "I'm having trouble reaching my AI provider. I'll keep trying — your request is queued and will be processed as soon as the connection is restored." |
| Sentinel's LLM API is unreachable | Queue validation. Do not execute unvalidated plans. Notify user that jobs are pending validation. | "Your request is ready, but I need to verify it's safe before I proceed. My safety check service is temporarily unavailable — I'll complete this as soon as it's back." |
| Both APIs unreachable | System enters "offline mode." Accepts messages, queues jobs, but cannot execute. Resumes automatically when connectivity returns. | "I'm currently offline and can't process new tasks. I'll queue your requests and work through them when my connection is restored. You can still browse your memories and past conversations." |
| Journal database corrupted | Axis continues operating without memory retrieval. Scout receives no historical context but can still plan. Alert user to run backup restoration. | "I'm having trouble accessing my memory. I can still help with tasks, but I won't remember our previous conversations until this is fixed. [Restore from backup]" |
| Gear sandbox fails to start | Skip the failing Gear, report the error, and ask Scout to replan without that Gear. | "I couldn't complete [action] due to a technical issue. Let me try a different approach..." (automatic replanning) |
| Disk full | Pause all non-critical operations. Alert user. Continue serving read-only requests. | "I'm running low on storage space and have paused background tasks. Please free up some disk space to continue. [See storage details]" |

User-facing messages are templates. The actual messages are assembled by Bridge based on
the failure type and context. The tone is conversational and informative, never technical
jargon. Error codes and technical details are available via "See details" expansion in
Advanced mode only.
```

---

## Patch 8: Acknowledge Product Accessibility Gap in Scope

**Severity**: Medium
**Review Finding**: #1 (Installation), #10 (Self-Hosting Tax), #11 (Comparison to ChatGPT/Claude)
**Target Section**: 2 (Executive Summary) and 10.1 (Target Environments)

### Rationale

The reviewer repeatedly compares Meridian unfavorably to ChatGPT, Claude, Siri, and Alexa in terms of ease of use. Many of their suggestions (App Store listing, native mobile app, built-in AI subscription) are product decisions beyond v1 scope. However, the architecture should be honest about its current audience and articulate how the design enables future accessibility improvements. This prevents misaligned expectations without closing the door on broader adoption.

### Changes

**Section 2 — Add after "Key Differentiators from Existing Platforms":**

```markdown
### Target Audience (v1)

Meridian v1 is designed for **technically comfortable users** — people who can run a terminal
command, configure an API key, and manage a local service. This includes software developers,
system administrators, power users, and tech-savvy enthusiasts.

This is a deliberate scope constraint, not a permanent limitation. The architecture is designed
so that future product layers can make Meridian accessible to non-technical users:

- The first-run setup wizard (Section 10.2.1) handles all configuration through a web UI,
  reducing terminal interaction to a single install command.
- All configuration is accessible through Bridge's settings UI, eliminating the need to edit
  config files for day-to-day use.
- The progressive disclosure UI (Section 5.5.2) hides system internals by default.
- Bridge's web architecture enables future packaging as a desktop app (Electron/Tauri),
  mobile app (PWA or native wrapper), or managed hosted service — all without core
  architecture changes.

**Future accessibility milestones** (not v1):
- One-click desktop installer (`.dmg`, `.exe`) wrapping the setup wizard.
- Progressive Web App (PWA) support for mobile home screen installation.
- Managed hosting option ("Meridian Cloud") for users who don't want to self-host.
- Bundled AI provider subscription to eliminate the API key setup step.
```

**10.1 — Add to the target environments table:**

```markdown
| Desktop app (future) | 8+ GB | 50+ GB | Any | Electron/Tauri wrapper. One-click install. |
| Mobile PWA (future) | N/A | N/A | N/A | Connects to user's Meridian instance. |
```

---

## Patch 9: Add Cost Comparison Context

**Severity**: Medium
**Review Finding**: #5 (Costs), #11 (Comparison to ChatGPT/Claude)
**Target Section**: 5.3.7 (Cost Implications)

### Rationale

The reviewer cannot evaluate whether Meridian's costs are reasonable because the document doesn't contextualize them. Adding a brief cost comparison — acknowledging the premium while explaining what the user gets for it — helps users make an informed decision.

### Changes

**5.3.7 — Add after the existing cost mitigations list:**

```markdown
**Cost context:** For transparency, Meridian's per-month API costs for moderate use
(estimated $45–$90/month) exceed the flat rate of consumer AI subscriptions like ChatGPT
Plus ($20/month) or Claude Pro ($20/month). The premium buys:

- **Local data storage**: Conversation history, memories, and files stay on the user's
  device — not on a third party's servers.
- **Task execution**: Meridian acts on the user's behalf (sends emails, manages files,
  runs schedules), not just answers questions.
- **Persistent memory and learning**: The system accumulates knowledge and builds
  capabilities specific to the user.
- **Safety validation**: Independent review of every action before execution.
- **No vendor lock-in**: The user owns all data and can switch LLM providers freely.

Users for whom these properties are not worth the premium should use a consumer AI
subscription instead — Meridian is not positioned as a cheaper alternative to ChatGPT.
It is positioned as a more capable, more private, and more autonomous alternative for
users who value those properties.

For cost-conscious deployments, running Scout on a local model via Ollama (Section 16.4)
can reduce or eliminate API costs entirely, at the expense of planning quality on complex
tasks.
```

---

## Patch 10: Automatic Maintenance and Health Reporting

**Severity**: Medium
**Review Finding**: #10 (Self-Hosting Tax)
**Target Section**: 10.5 (Update Mechanism) and 12.3 (Health Checks)

### Rationale

The reviewer describes self-hosting as "a personal server administration hobby" requiring database maintenance, backup monitoring, disk space management, and manual updates. The architecture already includes automated backups and monitoring, but it doesn't clearly articulate self-management capabilities. Explicitly specifying automatic maintenance reduces the perceived (and actual) operations burden.

### Changes

**10.5 — Add new subsection 10.5.1:**

```markdown
#### 10.5.1 Automatic Maintenance

Meridian handles routine maintenance automatically, requiring no user intervention:

| Task | Frequency | Behavior |
|------|-----------|----------|
| Database backup | Daily | Automatic backup to `data/backups/`. Rotation: 7 daily, 4 weekly, 3 monthly. Backup integrity verified via `PRAGMA integrity_check`. |
| Database optimization | Weekly (idle periods) | SQLite `VACUUM` and `ANALYZE` run during detected idle periods (no active jobs for 30+ minutes). |
| Log rotation | Daily | Application logs rotated at 50 MB, retained for 7 days. Audit logs rotated at 100 MB, retained for 1 year. |
| Disk space monitoring | Continuous | Warning at 80% disk usage, pause non-critical operations at 90%. Alerts surface in Bridge. |
| Memory management | Continuous | RAM monitoring with pause of non-critical jobs below 512 MB available. |
| Episode archival | Weekly | Episodic memories older than the retention period (default: 90 days) are auto-summarized and archived. |
| Stale Sentinel decisions | Daily | Expired Sentinel Memory decisions are cleaned up automatically. |

**Health summary:** Bridge displays a persistent, unobtrusive health indicator (green/yellow/red)
in the UI. Tapping it shows a plain-language health summary: "Everything is running smoothly"
(green), "Running low on disk space" (yellow), or "Cannot reach AI provider" (red). No
technical jargon in Simple mode. Full technical health details available in Advanced mode.

**Update notifications:** When a new version is available (checked on user-initiated
`meridian update --check` only, per Section 10.5), Bridge shows a notification: "A new
version of Meridian is available (v0.2.0). [Update now] [Remind me later] [See what's new]".
The update process runs through Bridge with a progress indicator and automatic rollback
if the update fails.
```

---

## Patch 11: Interactive Tutorial System

**Severity**: Low
**Review Finding**: #2 (Learning Curve), #6 (Limited Functionality Discovery)
**Target Section**: 5.5 (Bridge) — add new subsection 5.5.8

### Rationale

The reviewer is overwhelmed by the system's conceptual complexity. Even with a simplified UI, new users need guidance on what Meridian can do and how to use it effectively. An interactive tutorial bridges the gap between "installed" and "productive."

### Changes

**Add Section 5.5.8 after 5.5.7:**

```markdown
### 5.5.8 Interactive Tutorial

After the first-run setup wizard, Bridge offers an optional interactive tutorial that walks
the user through their first tasks using the conversation interface itself:

1. **"Say hello"**: User sends a message, sees the fast-path response. Learns basic
   interaction.
2. **"Ask me to remember something"**: User states a preference ("I like my coffee black").
   Meridian confirms it will remember. Demonstrates Journal's semantic memory.
3. **"Ask me to search for something"**: User requests a web search. Demonstrates Gear
   execution and the result format.
4. **"Ask me to set a reminder"**: User creates a reminder. Demonstrates the scheduler
   and notification system.
5. **"Ask me to do something that needs approval"**: User requests an action that triggers
   Sentinel approval (e.g., "write a file"). Demonstrates the approval flow.

Each tutorial step includes a brief, plain-language explanation of what happened behind the
scenes (without component names in Simple mode): "I searched the web for you using a
privacy-respecting search engine. I keep your search history on your device, not in the
cloud."

The tutorial is skippable, re-accessible from Bridge settings, and adapts to which Gear
is configured (e.g., skips the email tutorial step if email is not configured yet).
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|-------------------|
| 1 | First-run setup wizard architecture | Critical | 10.2, 10.4 |
| 2 | Tiered approval defaults + fast-learning + batched approvals | Critical | 5.3.5, 5.3.8 |
| 3 | Expand built-in Gear for day-one utility | Critical | 5.6.5 |
| 4 | Cost estimation, dashboard, and transparency | High | 11.1, 5.5.1 |
| 5 | Voice interaction pipeline and TTS | High | 5.5.3, 16 |
| 6 | Progressive disclosure UI (Simple/Advanced modes) | High | 5.5.2 |
| 7 | User-facing graceful degradation messages | Medium | 4.4 |
| 8 | Target audience scope + accessibility roadmap | Medium | 2, 10.1 |
| 9 | Cost comparison context and value proposition | Medium | 5.3.7 |
| 10 | Automatic maintenance and health reporting | Medium | 10.5, 12.3 |
| 11 | Interactive tutorial system | Low | 5.5 (new 5.5.8) |
