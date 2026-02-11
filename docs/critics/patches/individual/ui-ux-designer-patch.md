# Architecture Patches: UI/UX Designer Review

> **Source**: `docs/critics/ui-ux-designer.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-10

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Add Dual-Mode Interface Specification (Chat + Mission Control)

**Severity**: Critical
**Review Finding**: #1 — The Chat Paradigm Limitation
**Target Section**: 5.5.2 (Frontend Architecture)

### Rationale

The architecture describes "a single scrolling conversation thread (similar to chat interfaces)" as the entire UI model. The reviewer identifies this as the most consequential design decision in the document, and argues it is the wrong primary metaphor for a task automation platform. Long-running tasks get buried, parallel tasks interleave chaotically, approval requests get lost in scroll, and job status has no spatial representation. The reviewer proposes a dual-mode interface: a cleaned-up conversation view for dialogue and a mission control dashboard for status and control. This is the single highest-impact UX change.

### Changes

**5.5.2 — Replace the paragraph beginning "The UI is a single scrolling conversation thread":**

Current:
> The UI is a single scrolling conversation thread (similar to chat interfaces) with additional panels for:
> - Job queue / status sidebar
> - Memory browser
> - Gear management
> - Settings and configuration
> - System logs

Proposed:
```markdown
The UI supports two primary modes, reflecting the two fundamentally different types of
interaction Meridian handles:

**Conversation View (Chat)**

A scrolling message thread for human-to-assistant dialogue. Shows user messages and final
assistant responses. Status updates, progress indicators, and approval requests are NOT
displayed inline as chat messages. Instead, when a task enters the full path (Scout →
Sentinel → Gear), the conversation shows a single compact task reference card
("Working on: [task description] — [View progress]"). The conversation is the "front
stage" — clean, readable, scannable.

**Mission Control (Dashboard)**

A spatial, status-oriented view of everything happening in the system. Key areas:

- **Active Tasks**: Cards showing currently executing jobs with real-time progress, step
  trackers, and elapsed time. Click to expand the full execution log.
- **Pending Approvals**: A prominent, always-visible section. Each approval shows a
  plain-language summary of the plan with Approve/Reject actions.
- **Recent Completions**: Last N completed jobs with outcomes. One-click to see details.
- **Scheduled Jobs**: Upcoming cron tasks with next-run times.
- **System Health**: Component status at a glance.

On wider screens (≥1280px), both modes are visible simultaneously (conversation on the left,
mission control on the right). On narrower screens, the user toggles between them. The key
insight: chat is for intent and dialogue; the dashboard is for status and control. Mixing
them degrades both.

Additional panels (accessed from mission control or settings navigation):
- Memory browser (see 5.5.9 for profile-based design)
- Gear management
- Settings and configuration
- System logs (developer mode only, see 5.5.11)
```

---

## Patch 2: Add Approval UX Specification and Trust Tiers

**Severity**: Critical
**Review Finding**: #2 — Approval Flow UX: The Approval Fatigue Problem
**Target Section**: 5.3.4 (Approval Flow), 5.3.5 (Default Risk Policies), 5.3.8 (Sentinel Memory)

### Rationale

The architecture has plan-level approval (which is good), but the UX layer on top of this model is unspecified. The reviewer identifies four gaps: (1) no specification for how plans are presented in the approval dialog, (2) no trust escalation path (binary ask-or-auto-approve), (3) no pre-approval for scheduled tasks (leading to 3 AM blocking), and (4) no Sentinel Memory seeding during onboarding (making the first week a wall of approval prompts). The architecture already supports these features structurally; the UX specification is what's missing.

### Changes

**5.3.4 — Add after the existing approval flow diagram:**

```markdown
**Approval dialog design:**

When Bridge presents a `NEEDS_USER_APPROVAL` verdict to the user, the approval dialog shows:

1. A plain-language summary of the overall task (from the plan's `summary` field, see 5.2.2).
2. A checklist of all steps, each showing a human-readable action description and a risk
   level indicator (color-coded: green for low, yellow for medium, orange for high, red for
   critical).
3. Three options:
   - **Approve** — approves the entire plan.
   - **Details** — expands each step to show the specific Gear, action, and parameters.
   - **Reject** — cancels the job with an explanation to Scout.

For plans with multiple approval-requiring steps, Bridge presents a single unified approval
dialog (batch approval), not separate prompts per step. The user approves or rejects the
plan as a whole. An advanced "Review individually" option allows per-step approve/deny for
power users; denied steps cause Axis to route back to Scout for replanning.

Example approval dialog:

```
Setting up a new Node project with testing

Here's my plan:
  [✓] Create directory ~/projects/new-app         (low risk)
  [!] Initialize npm project (npm init -y)         (shell command)
  [!] Install dependencies (vitest, typescript)    (shell command)
  [✓] Create tsconfig.json                         (low risk)
  [✓] Create initial test file                     (low risk)

2 steps need your approval (terminal commands).
[Approve Plan] [See Details] [Reject]
```
```

**5.3.5 — Add after the default risk policies table:**

```markdown
**Trust level profiles:**

Users select a trust profile during onboarding (and can change it anytime in settings).
Trust profiles configure Sentinel's escalation behavior:

| Profile | Behavior | Recommended For |
|---------|----------|-----------------|
| **Supervised** | Prompt for every plan that contains approval-required actions. | New users, first week of use (default). |
| **Balanced** | Auto-approve plans where all steps are low or medium risk. Prompt only for high or critical risk steps. | After Sentinel Memory has accumulated common patterns. |
| **Autonomous** | Auto-approve everything except critical risk. | Experienced users with established Sentinel Memory. |

Trust profiles are a UX wrapper around the existing policy system — they adjust which risk
levels trigger `needs_user_approval` vs. auto-approval. The hard floor policies (financial
transactions always require approval, shell commands always require approval per 5.6.5)
cannot be overridden by any trust profile.
```

**5.3.8 — Add after the "How Sentinel uses this memory" flow diagram:**

```markdown
**Scheduled task pre-approval:** When a user creates a scheduled task through Bridge, Bridge
displays the plan template for the task and offers pre-approval: "Every time this runs, it
will do [X, Y, Z]. Approve for all future runs?" If the user approves, the approval is
stored as a Sentinel Memory entry scoped to that schedule. This prevents the scenario where
a newly scheduled task blocks at 3 AM waiting for approval because the pattern has no
precedent.

**Sentinel Memory seeding:** During onboarding (first-run wizard), Bridge offers common
approval bundles:

- "Allow file operations in your workspace?" (covers `file.read` and `file.write` within
  the workspace directory)
- "Allow web searches and fetching public web pages?" (covers `web-search` and `web-fetch`
  GET requests)

Each bundle creates a set of Sentinel Memory entries. This reduces first-week approval
fatigue without compromising security. The user can review and revoke any seeded decision
through Bridge at any time.
```

---

## Patch 3: Add Mobile Responsiveness Requirement

**Severity**: Critical
**Review Finding**: #7 — Mobile Responsiveness
**Target Section**: 5.5.2 (Frontend Architecture), 5.5.7 (Accessibility)

### Rationale

Mobile is not mentioned once in the architecture. The reviewer argues this is a critical omission: Meridian sends notifications, requests approvals, and runs autonomously. The user will not always be at their desk. An approval request that blocks for hours because the user is away from their desktop defeats the purpose of the system. The Tailwind CSS stack already supports responsive design trivially.

### Changes

**5.5.2 — Add after the dual-mode interface specification (Patch 1):**

```markdown
**Responsive layout:**

Bridge is responsive from the first commit. Tailwind's responsive utilities (`sm:`, `md:`,
`lg:`, `xl:`) are used throughout. Breakpoint behavior:

| Breakpoint | Layout |
|------------|--------|
| **Mobile** (<768px) | Single-column. Conversation view is default. Mission control is a full-screen overlay triggered by a bottom-nav icon. Approval cards appear as slide-up sheets. |
| **Tablet** (768-1279px) | Single-column with collapsible mission control sidebar. |
| **Desktop** (≥1280px) | Side-by-side: conversation left, mission control right. |

**Mobile-priority surfaces:** On mobile, the following are always accessible:
- Chat thread (full-width)
- Approval quick-action cards (with Approve/Reject buttons sized for touch)
- Active task status (compact cards)
- Notification list

Hidden on mobile (desktop activities): memory browser, Gear management, system logs, full
settings.
```

**5.5.7 — Add after the existing accessibility section:**

```markdown
**Progressive Web App (PWA):**

Bridge ships as a Progressive Web App:
- Service worker for offline notification queuing and basic caching.
- Web app manifest enabling "Add to Home Screen" on mobile devices.
- Push notification support via the Push API (requires HTTPS for remote access, works on
  localhost for local deployments).

This provides a near-native mobile experience without building a separate app. Vite's PWA
plugin (`vite-plugin-pwa`) handles service worker generation and manifest creation.
```

---

## Patch 4: Add Progressive Onboarding Specification

**Severity**: Critical
**Review Finding**: #10 — Onboarding: The Setup Wall
**Target Section**: 5.5.6 (Authentication) — extend into new subsection 5.5.8

### Rationale

The first-run experience requires creating an account, configuring LLM providers, and understanding Scout vs. Sentinel — a steep climb before any value is delivered. The reviewer recommends a 5-minute onboarding that hides architecture concepts entirely and gets the user to their first successful interaction as fast as possible. The product manager patch (Patch 2) already adds a first-run experience specification; this patch extends it with the UX-specific concerns the reviewer raises: hiding dual-LLM complexity, trust level selection, notification configuration, and example prompts.

Note: If the product manager patch's Section 5.5.8 is already applied, this patch amends and extends that section. If not, this patch stands on its own.

### Changes

**Add/amend Section 5.5.8 (First-Run Experience):**

```markdown
#### 5.5.8 First-Run Experience

The first-run experience has exactly four steps. Total target time: under 3 minutes.

**Step 1: Create a Password (30 seconds)**

Single password field with confirmation. No username, no email. Minimum 8 characters.
The UI explains: "This password protects your Meridian instance."

**Step 2: Add Your AI Key (2 minutes)**

Single screen: "Meridian uses AI to understand your requests. Paste an API key from one
of these providers:" Show provider logos (Anthropic pre-selected as recommended, then
OpenAI, Google, Ollama). One key is enough — Meridian uses the same provider for both
planning and safety checking by default. Separate providers are an advanced setting.

Show estimated monthly cost: "Typical usage costs $5-15/month with cloud APIs. Free with
local models (Ollama)."

Do NOT mention Scout, Sentinel, or any internal component names. Do NOT ask for two keys.

Include a direct link to the selected provider's API key page. Validate the key immediately
with a lightweight API call. Show clear error messages for invalid keys, network issues,
or insufficient credits.

**Step 3: Choose Your Comfort Level (30 seconds)**

"How much should I check with you before doing things?"

- **Ask me about everything** — "I'll ask before doing anything that could change your
  files or access the internet." (Supervised — default)
- **Ask me about risky things only** — "I'll handle routine tasks on my own and ask about
  anything unusual." (Balanced)
- **I trust you, just do it** — "I'll handle everything except financial transactions and
  irreversible actions." (Autonomous)

One-sentence explanation for each. Changeable anytime in settings. Offer optional quick
approval bundles: "Pre-approve common actions? [Allow file operations in workspace]
[Allow web searches]" — each creates Sentinel Memory entries (see 5.3.8).

**Step 4: First Message**

Drop the user directly into the conversation view. Show a brief welcome message (2-3
sentences) and 3-4 suggested starter prompts as clickable chips:

- "What can you do?"
- "List the files in my Downloads folder"
- "Search the web for today's top news"

Suggested prompts are chosen from actions the currently installed Gear can handle, ensuring
they succeed on the first try. The first suggested prompt ("What can you do?") triggers a
fast-path response explaining capabilities in plain language.

**Empty State**

If the user navigates to mission control before sending a message:
- Active tasks: "No tasks running. Start by sending a message."
- Scheduled jobs: "No scheduled tasks yet. Try: 'Check the weather every morning.'"
- Memory: "I haven't learned anything about you yet. As we work together, I'll remember
  your preferences."

Empty states teach the user what will eventually fill each space.
```

---

## Patch 5: Add User-Facing Vocabulary Specification

**Severity**: High
**Review Finding**: #3 — Trust and Transparency: The Explanation Gap
**Target Section**: 5.5 (Bridge) — new subsection 5.5.9

### Rationale

The architecture uses internal component names (Scout, Sentinel, Journal, Gear, Axis) that are appropriate for the architecture document but would be meaningless jargon if surfaced in the UI. The reviewer argues that no user should need to know what "Sentinel" is to approve a file deletion. Without explicit guidance, implementation will default to surfacing architecture names. This patch defines the mapping between internal concepts and user-facing language.

Note: The product manager patch (Patch 7) covers similar ground. This patch extends it with the UI/UX designer's more specific recommendations around natural language plan summaries and learning visibility.

### Changes

**Add Section 5.5.9:**

```markdown
#### 5.5.9 User-Facing Language

Internal component names and architecture concepts are never exposed in the default Bridge
UI. All user-visible text uses plain English descriptions of what is happening, not how it
is happening.

| Internal Concept | User-Facing Language |
|-----------------|---------------------|
| Scout is planning | "Thinking..." or "Figuring out how to do this..." |
| Sentinel is validating | "Checking safety..." (brief, often sub-second) |
| Sentinel rejected the plan | "This was flagged: [reason in plain language]" |
| needs_user_approval | "I need your OK before proceeding" |
| Gear is executing | "Working on it..." or specific: "Searching the web...", "Reading files..." |
| Gear execution failed | "Something went wrong: [plain reason]. Want me to try a different approach?" |
| Journal is reflecting | Nothing visible. Reflection is async and invisible to the user. |
| Journal learned something | Subtle indicator on the completed task card: "Noted: [memory content]" |
| Sentinel Memory | Not surfaced by name. Approvals are simply "remembered." |
| ExecutionPlan / steps | Not surfaced. The "Details" panel shows steps as a simple numbered list. |
| fast path / full path | Not surfaced. The user sees a response (fast) or progress stages (full). |
| Gear | "skill" or "tool" in user-facing text. "Gear" is used in developer docs only. |
| risk level | Never shown as "low/medium/high/critical" labels. Instead, color indicators (green/yellow/orange/red) on step items. |

**Natural language plan summaries:** Scout includes a `summary` field in every
`ExecutionPlan` — a 1-2 sentence plain-language description of what the plan will do.
Bridge displays this summary in approval dialogs and task cards, never the raw plan JSON.
A "Details" toggle is available for users who want to see structured plan data.

**Sentinel explanations:** Sentinel's rejection or approval-request reasons are displayed
in plain language:
- Instead of: `{ verdict: "needs_user_approval", reasoning: "Step 3 invokes shell.execute which is a critical-risk action type per policy" }`
- Show: "This task needs to run a terminal command (npm install). I want to make sure that's OK with you."

**Learning visibility:** When Journal learns something from a completed task, the task card
in mission control shows a small, dismissible "What I learned" section:
"Noted: you prefer TypeScript over JavaScript. [Undo] [Edit]"
This makes learning visible without cluttering the conversation.

**Developer mode** (see 5.5.11) enables the display of internal component names, raw plans,
Sentinel validation details, and Gear logs. This is opt-in and off by default.
```

---

## Patch 6: Add Natural Language Summary to ExecutionPlan

**Severity**: High
**Review Finding**: #3 — The Explanation Gap (plan opacity)
**Target Section**: 5.2.2 (Execution Plan Format)

### Rationale

The `ExecutionPlan` interface has no mechanism for human-readable explanation. Plans are structured JSON intended for Axis and Sentinel, but Bridge needs a plain-language summary for approval dialogs, task cards, and progress displays. Without this, the UI must either show raw JSON (unintelligible to non-developers) or fabricate summaries separately (duplicating Scout's understanding). The fix is simple: Scout generates a summary as part of the plan.

### Changes

**5.2.2 — Add `summary` to the ExecutionPlan interface documentation:**

After the `ExecutionPlan` interface block, add:

```markdown
Scout is instructed to include a `summary` field in every plan — a 1-2 sentence
plain-language description of what the plan will accomplish, suitable for display in the
Bridge approval dialog and task cards. Example:

```json
{
  "id": "plan-01",
  "jobId": "job-01",
  "summary": "I'll create a new folder, set up a Node.js project, install your testing tools, and create a starter test file. This requires running some terminal commands.",
  "steps": [ ... ]
}
```

The `summary` field is free-form (not a required field for Axis) but Scout's system prompt
instructs it to always include one. Bridge falls back to a generic description based on
the Gear and actions used if `summary` is absent.
```

---

## Patch 7: Add Step-by-Step Progress and Error Communication

**Severity**: High
**Review Finding**: #4 — Error Communication: The Partial Failure Black Hole, #5 — Streaming and Long-Running Task UX
**Target Section**: 5.5 (Bridge) — new subsection 5.5.10

### Rationale

The architecture describes step-level retry and replanning after failure but specifies nothing about how partial failure, progress, or replanning is communicated to the user. For multi-step plans, the user needs to know: what has already executed (and its side effects), what failed and why, what is being retried, and how long it's likely to take. The reviewer also identifies that long-running tasks have no background management UX — the user is tab-locked watching a spinner. This patch specifies the progress communication model.

### Changes

**Add Section 5.5.10:**

```markdown
#### 5.5.10 Task Progress and Error Communication

**Task cards (full-path tasks):**

When a task enters the full path, it is represented in both the conversation view and
mission control as a task card. The conversation shows a compact inline card; mission
control shows the full expanded card.

Task card contents:
- Task name/description (from the plan's `summary` field)
- Step tracker (collapsible, like a shipping order tracker):
  ```
  Setting up your project:
    [done]    Created project directory
    [done]    Initialized npm project
    [failed]  Installing dependencies — network timeout
    [waiting] Creating config files
    [waiting] Writing test file

  Retrying with a different approach...
  ```
- Elapsed time and progress percentage (if Gear reports it via `progress()`)
- Quick actions: [Cancel]

**Failure communication:**

When a step fails, the task card shows:
1. A brief, non-technical explanation: "Installing dependencies failed because the package
   registry couldn't be reached."
2. A "See Details" link for technical error output (stderr, exit code, stack trace).
3. Side-effect disclosure: If completed steps had side effects, explicitly state them:
   "Note: Steps 1 and 2 already completed. Two files were created in ~/projects/new-app."
4. If the plan included rollback instructions for completed steps: "[Undo changes] [Keep
   and retry]"
5. If Scout is replanning, briefly explain what changed: "Trying an alternative: downloading
   packages from a mirror."

**Timeout communication:**

When a step is taking longer than expected:
- Show elapsed time and timeout limit: "Installing dependencies... (45s / 5m timeout)"
- At 50% of timeout: "This is taking longer than usual. [Keep waiting] [Cancel this step]"

**Background task model:**

Full-path tasks are "background-first." The user does not need to watch the conversation to
track progress:
- Task completion triggers an in-app notification and (if the tab is not focused) a browser
  push notification.
- Task failure triggers an in-app notification + browser push.
- Approval requests trigger in-app + browser push + external notification (if configured).
- Clicking a notification takes the user directly to the task card in mission control, not
  to the chat message where the task was initiated.

The conversation thread is never blocked by a running task. The user can send new messages,
start new tasks, and context-switch freely while tasks execute in the background.
```

---

## Patch 8: Add Notification Hierarchy and Smart Defaults

**Severity**: High
**Review Finding**: #8 — Notification Overload
**Target Section**: 5.5.5 (Notification System)

### Rationale

The architecture describes three notification layers but provides zero guidance on which events trigger which channels, how to prevent spam, or what the defaults are. Without this, a system running scheduled tasks and learning new Gear can easily generate 50+ notifications per day, causing users to disable everything — and losing the ability to get their attention when it matters.

### Changes

**5.5.5 — Add after the existing notification layers description:**

```markdown
**Default notification triggers:**

| Event | In-App | Push | External | Priority |
|-------|--------|------|----------|----------|
| Approval needed | Yes | Yes | Yes (if configured) | Urgent |
| Task failed | Yes | Yes | No | High |
| Task completed | Yes | No | No | Normal |
| Scheduled task failed | Yes | Yes | No | High |
| Scheduled task succeeded | Silent (viewable in history) | No | No | Low |
| Learning event (Journal) | Silent (viewable in task card) | No | No | Low |
| System health warning | Yes | Yes | No | High |
| Gear draft ready for review | Yes | No | No | Normal |

**Notification preferences:** Bridge provides a notification preferences screen (accessible
during onboarding and in settings) where the user sets channel preferences per event type.
The matrix above is the default.

**Quiet hours:** Configurable "do not disturb" window (e.g., 11 PM - 7 AM). During quiet
hours, only Urgent notifications (approval requests) break through. Everything else queues
for the next active period.

**Digest mode:** For low-priority notifications, offer a daily digest: "Today: 12 tasks
completed, 2 new things learned, 1 new skill created." This replaces many individual
notifications with one summary. Opt-in, off by default.
```

---

## Patch 9: Add Memory Profile Page Specification

**Severity**: Medium
**Review Finding**: #9 — Memory Management UX
**Target Section**: 5.4.6 (User Transparency)

### Rationale

The architecture describes memory management as "browse all memories, filtered by type, date, or keyword" with View, Edit, Delete, Export, Pause operations. The reviewer argues this is a database admin interface, not a user feature. Non-technical users do not think in terms of "episodic memory" vs. "semantic memory." The reviewer recommends a profile-based presentation and conversational memory interaction.

### Changes

**5.4.6 — Replace the existing content with:**

```markdown
#### 5.4.6 User Transparency

All memories are visible and manageable by the user through Bridge in two ways:

**Conversational memory interaction (primary):**

Users interact with memory naturally through the chat:
- "What do you know about me?" — Shows a curated summary of key semantic memories.
- "What have you learned to do?" — Shows procedural memories and Journal-created Gear.
- "Forget my old phone number" — Deletes the relevant semantic memory entry.
- "What did we do last Tuesday?" — Shows relevant episodic memories.
- "Stop remembering things for now" — Pauses memory recording.

This is the primary memory interaction path. It requires no new UI surfaces and matches
how humans interact with memory.

**Profile page (secondary — in mission control):**

For users who want to browse and manage memories directly, Bridge provides a structured
profile page (not a raw database table):

- **About You**: Key facts about the user — preferences, environment details, contacts.
  Each entry is editable and shows its confidence level and source. Example: "Prefers
  TypeScript (based on 12 interactions) [Edit] [Delete]" vs. "Uses VS Code (mentioned
  once, low confidence) [Edit] [Delete]"
- **Skills Learned**: Procedural memories and Journal-created Gear, with plain-language
  explanations of what each skill does. Example: "RSS Digest — fetches your favorite
  news feeds and summarizes the top stories."
- **Recent History**: Timeline of significant interactions, searchable and filterable.
- **Privacy Controls**: Pause learning, export all data (JSON/Markdown), delete
  everything.

The profile page does NOT use the terms "episodic memory," "semantic memory," or
"procedural memory." These are internal architecture concepts. The profile page is
organized by user-meaningful categories (facts about you, skills, history).

**Memory transparency card:** After each task that triggers Journal reflection, the
completed task card shows a small, dismissible "What I learned" section with [Undo]
and [Edit] actions. This makes learning visible at the moment it happens, without
requiring the user to visit the profile page.
```

---

## Patch 10: Add Loading States and Empty States Specification

**Severity**: Medium
**Review Finding**: #12.2 — Loading States, #12.3 — Empty States
**Target Section**: 5.5 (Bridge) — note within 5.5.10 or as part of the user-facing language section

### Rationale

The architecture describes what happens when everything works but not what the user sees while waiting. Every state transition needs a loading state. Similarly, empty states for new users are not specified. Empty states are not placeholder text — they are the most important onboarding tool.

### Changes

**Add to the Bridge section (after task progress specification):**

```markdown
**Loading states:**

Every system state transition has a corresponding user-visible loading state:

| System State | User Sees |
|-------------|-----------|
| Message sent, waiting for Scout | Typing indicator (animated dots) |
| Scout planning | "Thinking..." with subtle animation |
| Sentinel validating | "Checking safety..." (brief, often <1 second) |
| Gear executing | Step-by-step progress tracker (see 5.5.10) |
| Journal reflecting | Nothing (invisible, async) |
| LLM API unreachable | "Having trouble connecting. Retrying..." with countdown timer |
| LLM API slow (>10s) | "Taking longer than usual..." |

Loading states never show internal component names. "Scout is generating an execution
plan" is a debug-mode message, not a user-facing one.

**Empty states:**

Every UI surface has a meaningful empty state that teaches the user what will fill it:

| Surface | Empty State |
|---------|-------------|
| Conversation | Welcome message + 3-4 clickable starter prompts |
| Active tasks (mission control) | "No tasks running. Start by sending a message." |
| Completed tasks | "No completed tasks yet." |
| Scheduled jobs | "No scheduled tasks yet. Try asking: 'Check the weather every morning.'" |
| Memory / profile | "I haven't learned anything about you yet. As we work together, I'll remember your preferences." |
| Gear list (beyond builtins) | "I come with basic tools. As you use me, I'll build new skills to help you better." |
```

---

## Patch 11: Add Developer Mode Specification

**Severity**: Medium
**Review Finding**: #3 — The Explanation Gap (need for debug visibility), #13.1 — Gear Review
**Target Section**: 5.5 (Bridge) — new subsection 5.5.11

### Rationale

The user-facing language patch (Patch 5) hides architecture internals from normal users. But power users and Gear developers need visibility into the pipeline for debugging and understanding. A developer mode provides this without polluting the default experience.

### Changes

**Add Section 5.5.11:**

```markdown
#### 5.5.11 Developer Mode

Bridge supports an opt-in developer mode (toggled in Settings → Advanced) that exposes
architecture internals for debugging and Gear development:

| Feature | Normal Mode | Developer Mode |
|---------|------------|----------------|
| Progress stages | "Thinking..." / "Running..." | "Scout: planning (claude-sonnet-4-5)..." |
| Task result | Formatted response only | Response + raw execution plan JSON + Sentinel validation result |
| Error messages | Plain language | Full error with component name, error code, stack trace |
| Cost display | Estimated cost per task | Token breakdown: input/output/cached per LLM call, per model |
| Gear execution | Hidden | Gear ID, action name, parameters, stdout/stderr, execution time |
| Approval dialog | "Meridian wants to [action]" | Full step details with risk level and Sentinel policy match |
| System log | Not visible | Live-streaming log panel with component name filter |
| Gear review | "New skill: RSS Digest. It can..." | Full manifest JSON, source code viewer, permission analysis |

Developer mode is persistent per-session (stored in session data) and indicated by a subtle
badge in the Bridge header. It does not affect system behavior — only what is displayed.
```

---

## Patch 12: Add Gear Review UX for Non-Developers

**Severity**: Medium
**Review Finding**: #13.1 — The Gear Review Problem
**Target Section**: 5.6.4 (Gear Lifecycle — Journal-generated Gear)

### Rationale

Journal creates Gear and flags it for user review. The architecture says "User reviews and approves" but does not specify what "review" means for a non-developer who cannot read TypeScript or evaluate JSON Schema manifests. The reviewer recommends presenting Gear in human terms with permissions described plainly.

### Changes

**5.6.4 — Add after the Journal-generated Gear lifecycle diagram:**

```markdown
**Gear review UX:**

When Bridge presents a Journal-generated Gear draft for user review, it shows:

1. A plain-language description of what the Gear does: "I created a new skill: **RSS
   Digest**. It can fetch your favorite news feeds and summarize the top stories."
2. A plain-language permissions summary: "It needs these permissions: read websites,
   write files in your workspace."
3. Three actions:
   - **Activate** — promotes the draft Gear to active status.
   - **Delete** — removes the Gear and records the rejection in Journal.
   - **View Code** — opens the source code and manifest (for developers only).

The permissions summary translates the manifest's `permissions` object into plain language:
- `network.domains: ["rss.example.com"]` → "Access the website rss.example.com"
- `filesystem.write: ["workspace/digests/*"]` → "Write files in your workspace"
- `shell: true` → "Run terminal commands" (highlighted with a warning indicator)
```

---

## Patch 13: Add Sentinel Memory UX (Trust Settings)

**Severity**: Medium
**Review Finding**: #13.2 — The Sentinel Memory Management Problem
**Target Section**: 5.3.8 (Sentinel Memory — user management through Bridge)

### Rationale

The architecture says users can "review and manage Sentinel Memory through Bridge (view all stored decisions, revoke any decision, set expiry)." The reviewer points out this is another admin interface masquerading as a feature. The recommendation: present it as "trust settings" — things Meridian is and isn't allowed to do.

### Changes

**5.3.8 — Add to or amend the user management description:**

```markdown
**Bridge presentation of Sentinel Memory:**

Sentinel Memory is presented in Bridge as "Trust Settings" (never called "Sentinel Memory"
in the UI). The page shows two sections:

**Things I can do without asking:**
- Delete files in /tmp — [Revoke] (expires in 23h)
- Push to git repositories — [Revoke]
- Send email to @company.com — [Revoke]

**Things I'm not allowed to do:**
- POST to external APIs — [Remove block]

Each entry shows when it was set and its expiry (if any). Users can revoke any permission
or remove any block. A "Reset all" button clears all stored decisions, returning to the
default policies.

This framing is user-meaningful ("what can my assistant do?") rather than architecture-
meaningful ("Sentinel Memory approval decision records").
```

---

## Patch 14: Add Multiple Conversation Threads

**Severity**: Medium
**Review Finding**: #13.3 — The Multi-Conversation Problem
**Target Section**: 5.5.2 (Frontend Architecture)

### Rationale

The architecture describes a single conversation thread. Users will want to context-switch between unrelated tasks without polluting a single infinite thread. Even ChatGPT has separate conversations. Without threads, finding a specific past interaction requires scrolling through everything.

### Changes

**5.5.2 — Add after the dual-mode interface specification:**

```markdown
**Conversation threads:**

Bridge supports multiple conversation threads. Each thread has its own conversation
context. Jobs are associated with their originating thread.

- Users can create new threads from the conversation view.
- A thread list/switcher is accessible from the conversation sidebar.
- The most recent thread is shown by default.
- Threads have auto-generated titles (based on the first message, similar to ChatGPT)
  that can be renamed.
- A "Quick question" thread type is available for one-off fast-path queries that the user
  does not want mixed into their main working thread.

Mission control shows tasks from all threads, with a thread indicator on each task card.
Journal retrieves memories across all threads (memory is not thread-scoped).
```

---

## Patch 15: Add Dark Mode Specification

**Severity**: Low
**Review Finding**: #12.1 — Dark Mode
**Target Section**: 5.5.2 (Frontend Architecture)

### Rationale

Not mentioned in the architecture. For a developer-targeted tool that runs on personal devices (potentially used at night), dark mode is table stakes. Tailwind makes this trivial with `dark:` class variants.

### Changes

**5.5.2 — Add to the frontend architecture section:**

```markdown
**Theme:** Bridge ships with dark mode as the default theme, with a light mode toggle in
settings. Tailwind's `dark:` variant classes are used throughout. Theme preference is
stored in the user's session and respects the system's `prefers-color-scheme` media query
on first visit.
```

---

## Patch 16: Add Keyboard Shortcuts

**Severity**: Low
**Review Finding**: #12.4 — Keyboard Shortcuts
**Target Section**: 5.5.2 (Frontend Architecture)

### Rationale

For a developer-oriented tool, keyboard shortcuts are essential for efficient use. The architecture should specify that Bridge implements a keyboard shortcut system.

### Changes

**5.5.2 — Add to the frontend architecture section:**

```markdown
**Keyboard shortcuts:**

Bridge implements a keyboard shortcut system with a command palette:

| Shortcut | Action |
|----------|--------|
| `/` | Focus chat input |
| `Cmd+K` / `Ctrl+K` | Open command palette (search tasks, threads, settings) |
| `Cmd+Enter` / `Ctrl+Enter` | Send message |
| `Escape` | Dismiss dialog/modal, close command palette |
| `Cmd+.` / `Ctrl+.` | Cancel current task |
| `Cmd+Shift+M` / `Ctrl+Shift+M` | Toggle between conversation and mission control |

Additional shortcuts are discoverable through the command palette. All shortcuts are
rebindable in settings.
```

---

## Patch 17: Add Voice Input UX Specification

**Severity**: Low
**Review Finding**: #11 — Voice Input UX
**Target Section**: 5.5.3 (Input Modalities)

### Rationale

Voice is listed as an input modality but has no UX specification. The reviewer identifies critical gaps: how to handle approval by voice (don't), transcription confirmation, and honest scoping. Voice in a web app will never match Siri/Alexa; it should be positioned honestly as an alternative input method, not a voice assistant.

### Changes

**5.5.3 — Add after the voice row in the modalities table:**

```markdown
**Voice input UX:**

- **Push-to-talk with transcript confirmation**: User holds a microphone button, speaks.
  Bridge displays the transcript and waits for the user to confirm ("Send this?") before
  processing. This prevents transcription errors from triggering unintended actions.
- **No voice approvals**: Approval actions are always visual (tap/click). Voice users see
  the approval card on screen and tap Approve/Reject. Do not attempt to parse spoken
  approval intent — the risk of false positives is too high for security-critical actions.
- **Voice output**: Text-to-speech for responses is a future consideration, not a launch
  requirement.
- **Scope**: Voice input is positioned as "You can speak your requests instead of typing
  them." It is not positioned as a voice assistant experience.
```

---

## Patch 18: Add Undo Semantics

**Severity**: Low
**Review Finding**: #12.5 — Undo/Redo Semantics
**Target Section**: 5.5 (Bridge) or 5.6 (Gear)

### Rationale

Meridian takes real-world actions (writes files, sends emails, calls APIs). There is no undo model specified. The reviewer recommends distinguishing undoable from non-undoable actions and communicating this to the user.

### Changes

**Add to Bridge or Gear section:**

```markdown
**Undo semantics:**

After each completed task, Bridge indicates whether the actions are reversible:

- **Undoable actions**: File writes (previous version is kept for the session), file
  deletes (moved to `workspace/trash/` for 24 hours, not permanently deleted),
  configuration changes (previous value is stored). Bridge shows: "Done. [Undo]"
- **Non-undoable actions**: Sent emails, external API calls, shell commands with external
  effects. Bridge shows: "Done. (This action can't be undone.)"

Undo is best-effort and scoped to Meridian's own actions. It does not attempt to reverse
external side effects (API calls, sent messages).

The `file-manager` built-in Gear implements soft-delete (move to trash) rather than
permanent deletion by default. The `shell` Gear does not support undo — shell commands are
non-reversible by nature.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|-------------------|
| 1 | Add dual-mode interface (Chat + Mission Control) | Critical | 5.5.2 |
| 2 | Add approval UX specification and trust tiers | Critical | 5.3.4, 5.3.5, 5.3.8 |
| 3 | Add mobile responsiveness requirement + PWA | Critical | 5.5.2, 5.5.7 |
| 4 | Add progressive onboarding (4-step, <3 minutes) | Critical | 5.5.8 (new) |
| 5 | Add user-facing vocabulary (hide architecture names) | High | 5.5.9 (new) |
| 6 | Add natural language summary to ExecutionPlan | High | 5.2.2 |
| 7 | Add step-by-step progress and error communication | High | 5.5.10 (new) |
| 8 | Add notification hierarchy with smart defaults | High | 5.5.5 |
| 9 | Add memory profile page (replace database browser) | Medium | 5.4.6 |
| 10 | Add loading states and empty states | Medium | 5.5 |
| 11 | Add developer mode | Medium | 5.5.11 (new) |
| 12 | Add Gear review UX for non-developers | Medium | 5.6.4 |
| 13 | Add Sentinel Memory UX (trust settings framing) | Medium | 5.3.8 |
| 14 | Add multiple conversation threads | Medium | 5.5.2 |
| 15 | Add dark mode specification | Low | 5.5.2 |
| 16 | Add keyboard shortcuts / command palette | Low | 5.5.2 |
| 17 | Add voice input UX specification | Low | 5.5.3 |
| 18 | Add undo semantics | Low | 5.5 / 5.6 |

### Findings Intentionally Not Patched

| Finding | Reason |
|---------|--------|
| **#6 — Information density / progressive disclosure layers** | The three-layer disclosure model (primary → on-demand → deep) is a good UX principle but is already addressed by the combination of Patch 1 (dual-mode interface), Patch 4 (onboarding), and Patch 11 (developer mode), which together create the progressive disclosure architecture the reviewer describes. A separate patch would duplicate these. |
| **#1 — Chat paradigm (full wireframe-level specification)** | The reviewer calls for wireframes and detailed interaction patterns. This patch addresses the structural architecture changes; detailed wireframes belong in a separate UX specification document, not the architecture document. |
| **#15 — Companion UX specification document** | The reviewer recommends a full companion document with user journeys and wireframes. This is a project deliverable, not an architecture patch. The patches above add the structural requirements that the architecture was missing; the detailed UX spec should be a separate document (`docs/ux-specification.md`) created during implementation. |

### Overlap with Other Patches

Several findings overlap with the product manager review patches:

| UI/UX Finding | Product Manager Patch | Resolution |
|--------------|----------------------|------------|
| Onboarding (#10) | PM Patch 2 (first-run experience) | This patch (4) extends PM Patch 2 with UX-specific details (trust levels, approval bundles, empty states). Apply both; this patch amends PM Patch 2. |
| User-facing vocabulary (#3) | PM Patch 7 (user-facing language) | This patch (5) extends PM Patch 7 with plan summaries, Sentinel explanations, and learning visibility. Apply both; this patch amends PM Patch 7. |
| Developer mode (#3) | PM Patch 12 (developer mode) | This patch (11) and PM Patch 12 are essentially identical. Apply either one. |
| Batch approval | PM Patch 9 (batch approval) | This patch (2) includes batch approval as part of the broader approval UX. PM Patch 9 can be considered a subset. |
