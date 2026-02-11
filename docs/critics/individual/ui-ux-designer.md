# Meridian UX/UI Critical Review

> **Reviewer**: Senior UI/UX Designer (15+ years, developer tools, dashboards, AI products)
> **Documents Reviewed**: `architecture.md` (v1.2), `idea.md`
> **Date**: 2026-02-07
> **Verdict**: The architecture is technically impressive but almost entirely silent on user experience. What exists reads like a backend engineer's sketch of what a frontend "probably needs." The result is a system that will be powerful to build but punishing to use.

---

## Executive Summary

Meridian's architecture document is 2,077 lines long. Approximately 80 of those lines address the user interface. That ratio tells you everything about the project's current UX maturity. The Bridge section (5.5) reads like a feature checklist, not an interaction design. There is no user journey mapping, no consideration of cognitive load, no hierarchy of information, no progressive disclosure strategy, and no acknowledgment that the system's internal complexity must be aggressively hidden from the person using it.

The architecture describes a system with six named components, three memory types, four approval verdicts, eight job states, three Gear origins, three notification layers, six built-in Gear, numerous deployment configuration options, and a dual-LLM trust boundary. The user, meanwhile, just wants to say "check my email" and have it work. The gap between internal complexity and expected simplicity is the central UX challenge of this project, and the architecture document does not engage with it at all.

What follows is a section-by-section critique with specific recommendations.

---

## 1. The Chat Paradigm Limitation

### The Problem

The architecture states: "The UI is a single scrolling conversation thread (similar to chat interfaces)." This is the most consequential design decision in the entire document, and it is stated as an afterthought in a parenthetical.

Chat is the wrong primary metaphor for a task automation platform. Chat works when the dominant interaction is conversational: ask a question, get an answer. Meridian is not that. Meridian is a system that runs multi-step jobs in the background, maintains persistent memory, manages plugins, requires security approvals, and executes on schedules. Chat is one mode of interaction, not the container for all interaction.

Consider what happens after the user says "Set up a new Node project with testing, deploy it to my VPS, and send me the URL when it's done." The system will:

1. Plan multiple steps (Scout)
2. Potentially request approval (Sentinel)
3. Execute over many minutes (Gear)
4. Possibly fail partway and replan
5. Reflect and learn (Journal)
6. Create new Gear for future use

All of this needs to be communicated. In a chat thread, it becomes an interminable scroll of status updates, approval dialogs, progress bars, error messages, and finally a result. The user scrolls past 40 system messages to find the URL. This is the Slack problem: when everything is a message, nothing is findable.

### What Breaks

- **Long-running tasks disappear**: A task that takes 15 minutes gets buried under subsequent messages. The user must scroll to find its result.
- **Parallel tasks create chaos**: If two jobs run concurrently, their status updates interleave in the chat. Which progress bar belongs to which job?
- **Approvals get lost**: An approval request at 2 PM, buried under messages from a 3 PM conversation, sits unanswered. The job blocks indefinitely.
- **No spatial organization**: A chat thread is one-dimensional (time). Tasks have status, priority, and dependencies. You cannot represent a job queue in a timeline.
- **History becomes unusable**: After a week of active use, the chat history is hundreds of messages. Finding "that deployment I did last Tuesday" requires scrolling or search, not the natural spatial memory humans use.

### Recommendation: Dual-Mode Interface

Design Meridian's UI around two primary modes, not a single chat thread:

**Mode 1: Conversation View (Chat)**
The chat thread, but stripped to its purpose: human-to-assistant dialogue. Show user messages and final assistant responses. Status updates, approval requests, and progress indicators live elsewhere (see below). The chat is the "front stage" -- clean, readable, scannable. If a task is in progress, show a single inline status card, not a stream of updates.

**Mode 2: Mission Control (Dashboard)**
A spatial, status-oriented view of everything happening. This is where jobs, approvals, memory, and Gear live. Think Linear's board view or Vercel's deployment dashboard. Key areas:

- **Active Jobs**: Cards showing currently executing tasks with real-time progress. Click to expand full execution log.
- **Pending Approvals**: A prominent, always-visible badge/count. Clicking opens a focused approval flow (not buried in chat).
- **Recent Completions**: Last N completed jobs with their outcomes. One-click to see full details.
- **Scheduled Jobs**: Upcoming cron tasks with next-run times.
- **System Health**: Component status at a glance.

The user can toggle between these modes, or on wider screens, see both simultaneously (chat on the left, mission control on the right). The key insight: chat is for intent and dialogue; the dashboard is for status and control. Mixing them degrades both.

---

## 2. Approval Flow UX: The Approval Fatigue Problem

### The Problem

The architecture's default risk policies (Section 5.3.5) require user approval for:
- Writing/modifying files outside workspace
- Deleting any files
- POST/PUT/DELETE network requests
- Shell command execution
- Sending messages (email, chat)
- System configuration changes
- Financial transactions

For a system designed to "execute tasks autonomously," this is a significant amount of interruption. Consider a simple task: "Draft a summary of today's news and email it to my team." This triggers:

1. Web search (GET, probably auto-approved)
2. Web fetch for article content (GET, probably auto-approved)
3. File write to save the draft (approval if outside workspace)
4. Email send (approval required)

To the architecture's credit, approval operates at the plan level, not the step level. Sentinel's `ValidationResult` (Section 5.3.3) returns a single `verdict` for the entire plan, and the approval flow (Section 5.3.4) shows one `NEEDS_USER_APPROVAL` prompt routed through Bridge — not separate prompts per step. So the above scenario would produce a single approval request for the plan, not four separate interruptions.

However, even one approval per plan adds up. A user who issues 10 action-requiring commands per day sees 10 approval prompts in their first week (before Sentinel Memory accumulates precedents). The result is predictable: approval fatigue sets in. Sentinel Memory mitigates this over time (previously approved actions are auto-approved), and fast-path queries skip Sentinel entirely, but the first-week experience of a power user will still feel heavy.

### What Breaks

- **Approval request at 3 AM**: The user scheduled a task. Sentinel flags it at 3 AM. In theory, Sentinel Memory (Section 5.3.8) should auto-approve actions with established precedent. But for new scheduled tasks — the first time the pattern runs — the task blocks until the user wakes up. The architecture does not provide a way to pre-approve a scheduled task's plan template at creation time.
- **Approval without context**: While approval is plan-level (which is good), the architecture does not specify how the plan is presented to the user. Sentinel returns a `ValidationResult` with per-step `StepValidation` entries containing free-form fields, but there is no specification for translating this into a human-readable approval dialog. "shell.execute: npm install" is clear. "network.post: api.example.com/v2/batch" is not.
- **No trust escalation path**: The architecture has a binary model — either Sentinel auto-approves (via cached decisions or Sentinel Memory), or it escalates to the user. There are no intermediate trust levels (e.g., "auto-approve low/medium risk, prompt only for high/critical") as a user-configurable setting.
- **First-week friction**: Sentinel Memory is empty on day one. Every action type the user encounters for the first time requires explicit approval. The architecture does not describe any "seed" mechanism or onboarding flow that pre-populates common approval patterns.

### Recommendation: Approval UX Design and Trust Tiers

The architecture already gets the core model right: approval is plan-level, not step-level (Section 5.3.4). What is missing is the UX layer on top of this model:

**1. Plan Preview UX**: The architecture routes `NEEDS_USER_APPROVAL` through Bridge but does not specify how Bridge presents this. Design the approval dialog as a human-readable plan summary with a step checklist:
```
Setting up a new Node project with testing

Here's my plan:
  [✓] Create directory ~/projects/new-app         (low risk)
  [!] Initialize npm project (npm init -y)         (needs OK - runs a command)
  [!] Install dependencies (vitest, typescript)    (needs OK - runs a command)
  [✓] Create tsconfig.json                         (low risk)
  [✓] Create initial test file                     (low risk)

2 steps need your approval (terminal commands).
[Approve Plan] [See Details] [Reject]
```

The user approves or rejects the plan as a whole. Sentinel's per-step `StepValidation` entries provide the detail, but the approval action is singular. The architecture supports this; the UX needs to be specified.

**2. Trust Levels**: Introduce three user-selectable trust profiles that configure Sentinel's escalation behavior:
- **Supervised**: Prompt for every plan that touches approval-required actions (current implicit default)
- **Balanced**: Auto-approve plans where all steps are low/medium risk; prompt only for high/critical (recommended after first week)
- **Autonomous**: Auto-approve everything except critical risk (for experienced users who have built up Sentinel Memory)

This is a UX wrapper around Sentinel's existing policy system (Section 5.3.5). Show a one-time onboarding screen explaining these levels. Let the user change anytime.

**3. Scheduled Task Pre-Approval**: When a user creates a scheduled task, show the plan template and let them pre-approve the entire pattern. "Every time this runs, it will do X, Y, Z. Approve for all future runs?" Store this as a Sentinel Memory entry. This prevents the 3 AM blocking problem for new task patterns that haven't yet built up precedent.

**4. Sentinel Memory Seeding**: During onboarding, offer common approval bundles: "Allow file operations in workspace? Allow git commands? Allow web searches?" This pre-populates Sentinel Memory so the first-week experience is not a wall of approval prompts.

---

## 3. Trust and Transparency: The Explanation Gap

### The Problem

The architecture mentions "audit trails" and "memory transparency" but does not address the fundamental question: how does the user understand what is happening and why?

Meridian has a complex internal pipeline: Scout plans, Sentinel validates, Gear executes, Journal reflects. For a technical user, viewing the raw execution plan JSON is feasible. For a non-technical user (and the idea document explicitly targets personal productivity, smart home, creative projects -- not just developers), "Scout produced an execution plan with 5 steps using file-manager Gear" is meaningless jargon.

The architecture uses internal component names (Scout, Sentinel, Journal, Gear, Axis) throughout the architecture document. While the Bridge section does not explicitly mandate that these names appear in the UI, it also does not specify an alternative user-facing vocabulary. There is a real risk that implementation will default to using architecture names as UI labels. No user should need to know what "Sentinel" is to approve a file deletion.

### What Breaks

- **Plan opacity**: Scout's execution plan is structured JSON with fields like `gear`, `action`, `parameters`, `riskLevel`. There is no specification for how this translates to human-readable explanation.
- **Sentinel reasoning is hidden**: Sentinel returns a verdict with optional free-form reasoning. But where does the user see this? In what format? At what reading level?
- **Journal reflections are invisible**: The architecture says Journal "reflects" after tasks. The user never sees this happen. They do not know what was learned or why. Memory entries appear silently.
- **Component jargon risk**: The architecture does not specify user-facing terminology separate from internal component names. Without explicit guidance, implementation will likely surface "Scout is planning..." "Sentinel is validating..." "Gear is executing..." directly. These would mean nothing to a non-developer user.

### Recommendation: Human-Readable Narrative Layer

**1. Define user-facing vocabulary**: The user should never see "Scout," "Sentinel," "Journal," or "Gear" in the interface unless a developer/debug mode is enabled. These are internal architecture names. Instead:
- "Scout is planning" becomes "Figuring out how to do this..."
- "Sentinel is validating" becomes "Checking safety..."
- "Awaiting approval" becomes "I need your OK before proceeding"
- "Gear is executing" becomes "Working on it..." or "[Specific action: Sending email...]"
- "Journal is reflecting" becomes nothing. Reflection is invisible to the user. They see the outcome: "I learned that you prefer TypeScript" as a small toast or sidebar note.

Reserve the internal names for a developer/debug mode that can be toggled in settings.

**2. Natural Language Plan Summaries**: When showing an execution plan for approval, do not show JSON or structured data. Scout should generate a human-readable summary as part of the plan output. Add a `summary` field to `ExecutionPlan` that reads like: "I'll create a new folder, set up a Node.js project, install your testing tools, and create a starter test file. This requires running some terminal commands."

Show a "Details" toggle for users who want to see the structured plan.

**3. Sentinel Explanations in Plain Language**: Sentinel's rejection or approval-request reasons should be translated to user-friendly language:
- Bad: `{ verdict: "needs_user_approval", reasoning: "Step 3 invokes shell.execute which is a critical-risk action type per policy" }`
- Good: "This task needs to run a terminal command (`npm install`). I want to make sure that's OK with you."

**4. Learning Visibility**: When Journal learns something, show a subtle, non-intrusive indicator: "Noted: you prefer dark mode for reports" in a "What I learned" section of the completed job card. Do not pollute the chat with learning notifications.

---

## 4. Error Communication: The Partial Failure Black Hole

### The Problem

The architecture describes step-level retry and replanning after failure (Section 4.5, step 9): "If a step fails, Axis routes back to Scout for replanning." But there is zero specification for how partial failure is communicated to the user.

Consider a 5-step plan where step 3 fails:

- Steps 1-2 completed successfully (files were written, APIs were called)
- Step 3 failed (network timeout)
- Steps 4-5 never executed
- Scout is replanning

The user's questions:
- Did anything happen yet? (Yes, steps 1-2 ran.)
- What broke? (Step 3 timed out.)
- Can I undo what already happened? (Maybe, if rollback was specified.)
- What is happening now? (Scout is replanning.)
- How long will this take? (Unknown.)
- Should I just start over? (Depends.)

None of these questions have answers in the architecture.

### What Breaks

- **Silent partial execution**: Steps 1-2 ran and had side effects. The user does not know this.
- **Invisible replanning**: Scout is trying a different approach. The user sees... nothing? A spinner? "Working on it"?
- **No rollback communication**: The architecture mentions that Scout can include a `rollback` field in steps, but there is no UX for showing what was rolled back.
- **Timeout ambiguity**: The default step timeout is 5 minutes. If step 3 is timing out, the user stares at a progress indicator for 5 minutes with no explanation.

### Recommendation: Progressive Failure Communication

**1. Step-by-Step Progress**: For multi-step plans, show a collapsible step tracker (like a shipping order tracker):
```
Setting up your project:
  [done]    Created project directory
  [done]    Initialized npm project
  [failed]  Installing dependencies -- network timeout
  [waiting] Creating config files
  [waiting] Writing test file

Retrying step 3 with a different approach...
```

This gives the user immediate context: what succeeded, what failed, what is pending.

**2. Failure Explanation Cards**: When a step fails, show a brief, non-technical explanation:
- "Installing dependencies failed because the package registry could not be reached. Retrying in 30 seconds."
- Include a "See Details" link for technical error output.

**3. Side-Effect Warnings**: If steps with side effects have already executed before a failure, explicitly tell the user:
- "Note: Steps 1 and 2 already completed. Two files were created in ~/projects/new-app."
- If the plan included rollback instructions, show: "I can undo the changes if you want. [Undo] [Keep and retry]"

**4. Timeout UX**: When a step is taking longer than expected, do not just show a spinner. Show elapsed time and the timeout limit: "Installing dependencies... (45s / 5m timeout)". If elapsed time exceeds 50% of timeout, show: "This is taking longer than usual. [Wait] [Cancel this step]"

**5. Replan Transparency**: When Scout replans, briefly explain what changed: "The original approach timed out. Trying an alternative: downloading packages from a mirror."

---

## 5. Streaming and Long-Running Task UX

### The Problem

The architecture mentions "token-by-token streaming" for responses. This works for conversational fast-path responses (the ChatGPT pattern). It does not work for tasks that take 5, 15, or 60 minutes.

The architecture describes tasks like "build entire software projects" (from the idea doc), scheduled email checks, RSS digest generation, and smart home automation. These are not streaming text completions. They are background processes.

The architecture has no concept of background task management from the user's perspective. The only UI description is "Job queue / status sidebar."

### What Breaks

- **Tab-lock**: If the user must watch a chat thread to see task progress, they cannot close the browser tab. For a system designed to "work autonomously in the background," this defeats the purpose.
- **No notification for completion**: The architecture lists notification channels but does not specify when they fire. Does the user get a push notification when a 15-minute task completes? When it fails? When it needs approval?
- **No progress granularity**: The Gear API includes `progress(percent, message)`, but there is no specification for how this surfaces in the UI. Is it a progress bar? A percentage? Where?
- **Multiple concurrent tasks**: If three tasks are running simultaneously, the chat thread is incomprehensible. Status updates from three different jobs interleave.

### Recommendation: Background-First Task Model

**1. Tasks Are Not Chat Messages**: When a task enters the full path (Scout -> Sentinel -> Gear), it should leave the chat thread and become a task card. The chat shows a single inline reference: "Working on: Set up Node project [View progress]". The progress details live in the Mission Control view.

**2. Task Cards**: Each active task gets a card showing:
- Task name/description
- Current step (with the step tracker from Section 4)
- Elapsed time
- Progress percentage (if Gear reports it)
- Quick actions: [Cancel] [Pause]

**3. Notification Triggers**: Define explicit notification rules:
- Task completed: in-app notification + browser push (if tab is not focused)
- Task failed: in-app notification + browser push + optional external (email/Slack)
- Approval needed: in-app notification + browser push + external (if configured)
- Scheduled task result: in-app notification (configurable)
- No notification for: intermediate step completion, reflection, auto-approved actions

**4. Return-to-Task**: When the user clicks a completed task notification, take them directly to the task result (not the chat message where it was initiated).

---

## 6. Information Density: The Identity Crisis

### The Problem

The architecture describes the following UI surfaces:

- Conversation thread
- Job queue / status sidebar
- Memory browser
- Gear management
- Settings and configuration
- System logs
- Approval dialogs
- Notification center

This is the surface area of a full DevOps dashboard, not a personal assistant. The architecture does not specify which of these are primary, which are secondary, and which should be hidden by default.

If every surface is visible simultaneously, the UI looks like Grafana. If they are all hidden behind navigation, the user never discovers them. Neither outcome is acceptable.

### What Breaks

- **Cognitive overload**: A new user opens Meridian and sees a chat box, a sidebar with "Jobs," "Memory," "Gear," "Logs," and "Settings." They wanted to say "remind me to buy milk." The interface communicates: "This is complicated software."
- **Feature discovery failure**: The memory browser is a powerful feature. If it is buried three clicks deep, no one uses it. If it is always visible, it clutters the interface for the 95% of interactions that do not need it.
- **No information hierarchy**: The architecture treats all surfaces as equally important. They are not. The conversation is primary. Approvals are urgent. Everything else is secondary.

### Recommendation: Progressive Disclosure Architecture

**Layer 1 -- Primary (Always Visible)**:
- Chat input
- Conversation thread (cleaned up per Section 1)
- Approval badge (count of pending approvals)
- Active task indicators (compact)

**Layer 2 -- On-Demand (One Click Away)**:
- Mission Control dashboard (tasks, approvals, schedules)
- Notification center
- Quick settings (trust level, notification preferences)

**Layer 3 -- Deep (Settings/Admin)**:
- Memory browser
- Gear management
- System logs
- Full configuration
- Audit log viewer
- LLM provider settings

New users see Layer 1 and nothing else. Power users progressively discover Layers 2 and 3 through contextual prompts ("You have 47 memories stored. Want to review them? [Open Memory Browser]").

---

## 7. Mobile Responsiveness

### The Problem

Not mentioned once in the entire architecture document. Not in the Bridge section, not in the accessibility section, not in future considerations. This is a critical omission.

The architecture describes a system that sends notifications, requests approvals, and runs autonomously. The user will not always be sitting at their desk when these events occur. The approval flow in particular demands mobile access: if Sentinel flags a task at 2 PM and the user is on their phone, they need to approve from their phone or the task blocks.

### What Breaks

- **Approval blocking**: User is away from desktop. Approval request sits unanswered for hours.
- **Notification without action**: User gets a push notification on their phone but cannot act on it without opening a desktop browser.
- **Chat interface on mobile**: The single scrolling thread actually works reasonably on mobile (it is the one thing chat is good at). But the sidebar panels (jobs, memory, Gear, logs) do not.

### Recommendation: Mobile-First Approval, Responsive Everything

**1. Responsive layout is mandatory from day one**: The Bridge SPA must be responsive. This is not a future consideration. Use Tailwind's responsive utilities (which are already in the stack) from the first commit.

**2. Mobile-priority surfaces**: On mobile, show:
- Chat thread (full width)
- Approval quick-action cards (swipe to approve/reject)
- Active task status (compact cards)
- Notification list

Hide on mobile: memory browser, Gear management, system logs, full settings. These are desktop activities.

**3. Progressive Web App (PWA)**: Add this to the technical requirements. Service worker for offline notification queuing, add-to-homescreen for quick access. This is trivial with Vite's PWA plugin and gives mobile users a native-like experience without building a separate app.

**4. Approval from notification**: Push notifications should include action buttons: [Approve] [Reject] [View Details]. The user should be able to approve without opening the full UI.

---

## 8. Notification Overload

### The Problem

The architecture describes three notification layers — in-app toast, browser push, and external webhooks (Section 5.5.5) — where the external layer can route to email, Slack, Discord, or other messaging apps via Gear. But it provides zero guidance on:
- Which events trigger which channel
- How the user configures preferences
- How to prevent notification spam
- Default notification settings

A system that checks email every 30 minutes, runs scheduled tasks, learns new Gear, and requires approvals can easily generate 50+ notifications per day. Without careful design, users will disable all notifications within a week, and the system loses its ability to get their attention when it actually matters.

### What Breaks

- **Channel flooding**: Every task completion, every learning event, every approval triggers notifications across all configured channels. The user's Slack becomes a Meridian spam channel.
- **Notification fatigue**: After 50 "Task completed" notifications, the user ignores the one that says "Task failed: your production deploy had an error."
- **No priority differentiation**: A "learned your editor preference" notification has the same visual weight as "approval needed: sending email to your entire team."

### Recommendation: Notification Hierarchy with Smart Defaults

**1. Event Classification**:
| Event | Default Channel | Priority |
|-------|----------------|----------|
| Approval needed | In-app + Push + External | Urgent |
| Task failed | In-app + Push | High |
| Task completed | In-app only | Normal |
| Learning event | Silent (viewable in history) | Low |
| Scheduled task succeeded | Silent (viewable in history) | Low |
| Scheduled task failed | In-app + Push | High |
| System health warning | In-app + Push | High |
| Gear draft ready for review | In-app only | Normal |

**2. Notification Preferences UI**: A simple matrix where the user sets channel preferences per event type. Default to the table above. Place this in the first-run setup wizard (not buried in settings).

**3. Quiet Hours**: Configurable "do not disturb" window. During quiet hours, only Urgent notifications break through. Everything else queues for the next active period.

**4. Digest Mode**: For low-priority notifications, offer a daily digest: "Today: 12 tasks completed, 2 new things learned, 1 Gear created." This replaces 15 individual notifications with one summary.

---

## 9. Memory Management UX

### The Problem

The architecture describes memory transparency: "Browse all memories, filtered by type, date, or keyword." It then lists the operations: View, Edit, Delete, Export, Pause.

This is a database admin interface. The user is expected to browse a table of episodic, semantic, and procedural memories, understand what each type means, and manually curate entries. This is not how personal assistants should surface memory.

Real users do not want to "browse episodic memories filtered by date." They want to say "What do you know about my project preferences?" or "Forget that I told you my old address."

### What Breaks

- **Terminology barrier**: "Episodic memory," "semantic memory," "procedural memory" are cognitive science terms. Users do not think in these categories.
- **Scale problem**: After a month of active use, Journal could have hundreds of memories. A flat list with filters is unusable at scale.
- **Edit UX undefined**: What does it mean to "edit" a procedural memory? The content field is LLM-generated natural language. Does the user rewrite it? What validates the edit?
- **Invisible learning**: The user does not know what Meridian remembers about them unless they go looking. This creates trust anxiety: "What does it know? Is it remembering something wrong?"

### Recommendation: Conversational Memory, Not a Database Browser

**1. Memory Through Conversation**: The primary way to interact with memory should be through the chat:
- "What do you know about me?" -- Shows a curated summary of key semantic memories
- "What have you learned to do?" -- Shows procedural memories / created Gear
- "Forget my old phone number" -- Deletes the relevant semantic memory
- "What did we do last Tuesday?" -- Shows relevant episodic memories

This is natural, requires no new UI surfaces, and matches how humans interact with memory.

**2. Memory Transparency Card**: After each task that triggers reflection, show a brief, dismissible card in the completed task view: "I noted: [memory content]. [Undo] [Edit]". This makes learning visible without being intrusive.

**3. Profile Page (Not Database Browser)**: Replace the memory "browser" with a structured profile page:
- **About You**: Key facts (preferences, environment, contacts) -- editable
- **Skills Learned**: Procedures and Gear Meridian has built -- browsable with explanations
- **Recent History**: Timeline of significant interactions -- searchable
- **Privacy Controls**: Pause learning, export data, delete everything

This is how LinkedIn/Notion present user data: structured, human-readable, not a raw table.

**4. Memory Confidence Indicator**: The architecture includes a `confidence` field on semantic memories. Surface this to the user: "I think you prefer TypeScript (based on 12 interactions)" vs "I'm not sure if you use VS Code or Cursor (mentioned once)." This builds trust.

---

## 10. Onboarding: The Setup Wall

### The Problem

First-run experience requires:
1. Creating an account with a strong password
2. Configuring at least one LLM provider (API key)
3. Optionally configuring a second provider for Sentinel
4. Understanding the concept of Scout, Sentinel, Gear
5. Setting trust/approval preferences
6. Optionally configuring notification channels

For a self-hosted system targeting Raspberry Pi users (who are tinkerers, but not necessarily AI experts), this is a steep climb. The architecture mentions a "setup wizard" (Section 5.5.6) but only in the context of authentication. There is no described onboarding flow for the rest.

### What Breaks

- **API key confusion**: Many users will not have Anthropic/OpenAI API keys. They need guidance on which provider to choose, how to get a key, and what it will cost.
- **Dual-LLM confusion**: "You need to configure TWO AI providers? Why?" The concept of Scout vs. Sentinel is an architecture concept, not a user concept.
- **Terminology overload**: Setup asks for "Scout provider," "Sentinel provider," "primary model," "secondary model." The user has not even sent their first message yet.
- **No value before configuration**: The user does zero setup and gets zero value. There is no "try before you configure" path.

### Recommendation: Progressive Onboarding in Five Minutes

**Step 1 (30 seconds): Create Account**
Password only. No configuration yet.

**Step 2 (2 minutes): Add Your AI Key**
Single screen: "Meridian uses AI to understand your requests. Paste an API key from one of these providers:" Show logos for Anthropic, OpenAI, Google, Ollama. One key is enough. Meridian uses the same provider for both Scout and Sentinel by default. Show estimated monthly cost: "Typical usage costs $5-15/month."

Do NOT mention Scout or Sentinel. Do not ask for two keys. The single-provider setup with information barriers is the "balanced" configuration from Section 5.3.6. Good enough for day one.

**Step 3 (1 minute): Choose Your Comfort Level**
"How much should I check with you before doing things?"
- **Ask me about everything** (Supervised -- default)
- **Ask me about risky things only** (Balanced)
- **I trust you, just do it** (Autonomous)

One-sentence explanation for each. Changeable anytime.

**Step 4 (30 seconds): Notifications**
"How should I reach you when I need your attention?"
- Browser notifications: [Enable]
- Email: [Add email] (optional)
- That is it. Slack/Discord are advanced settings.

**Step 5: First Message**
Drop the user directly into the chat. Show a welcome message: "Hi! I'm Meridian. I can help you with tasks, answer questions, and learn your preferences over time. Try asking me something."

Show 3-4 example prompts as clickable suggestions: "What can you do?", "Remind me to check email every morning", "Help me organize my downloads folder."

**Advanced Configuration**: Accessible from settings. Separate Scout/Sentinel providers, model selection, Gear management, memory settings. These are discovered over time, not front-loaded.

---

## 11. Voice Input UX

### The Problem

The architecture lists voice as an input modality (Web Speech API + Whisper) and says nothing else. Voice interaction has fundamentally different UX requirements than text, and the architecture ignores all of them.

### What Breaks

- **Approval via voice**: How does a user approve a Sentinel request by voice? "Approve" is ambiguous in conversation. A spoken "yes" could be part of a response, not an approval action.
- **Long-form voice**: The user dictates a complex task. Transcription errors create wrong commands. Where is the confirmation step?
- **Voice feedback**: The architecture describes streaming text output. For voice users, this needs text-to-speech output or at minimum a visual summary.
- **Always-on listening**: Not mentioned, probably not intended, but users of voice assistants (Alexa, Siri) expect it. If Meridian requires a push-to-talk interaction in a web browser, the voice UX is worse than existing alternatives.

### Recommendation: Voice as Secondary, Not Primary

**1. Push-to-talk with transcript confirmation**: User holds a mic button, speaks. Meridian shows the transcript and says "Send this?" before processing. This prevents transcription errors from triggering unintended actions.

**2. No voice approvals**: Approvals are always visual. A voice user sees the approval card on screen and taps Approve/Reject. Do not try to parse spoken approval intent -- the risk of false positives is too high for security-critical actions.

**3. Voice output (optional, future)**: Text-to-speech for responses. This is a nice-to-have, not a launch requirement. Mark it as such.

**4. Honest scope**: Voice input in a web app will never match Siri/Alexa. Do not over-promise. Position it as: "You can speak your requests instead of typing them." Not: "Meridian is a voice assistant."

---

## 12. Missing UX Fundamentals

The architecture document omits several UX fundamentals that should be specified before implementation begins.

### 12.1 Dark Mode
Not mentioned. For a tool that developers will use (and that runs on a personal device potentially used at night), dark mode is table stakes. The Tailwind CSS stack makes this trivial (`dark:` variants). Specify dark mode as default with a light mode toggle, not the reverse. AI products with dark interfaces feel more "alive" and technical; light defaults feel like productivity software.

### 12.2 Loading States
The architecture describes what happens when everything works. It does not describe what the user sees while waiting. Every state transition needs a loading state:
- Message sent, waiting for Scout: show typing indicator
- Scout planning: show "Thinking..." with subtle animation
- Sentinel validating: show "Checking safety..." (brief, often sub-second)
- Gear executing: show step-by-step progress (see Section 4)
- Journal reflecting: show nothing (this is invisible to user)
- LLM API unreachable: show "Having trouble connecting. Retrying..." with a retry timer

### 12.3 Empty States
What does the user see on first launch after onboarding?
- Empty chat: Welcome message + example prompts (see Section 10)
- Empty job queue: "No tasks running. Start by sending a message."
- Empty memory: "I haven't learned anything about you yet. As we work together, I'll remember your preferences."
- No Gear installed beyond builtins: "I come with basic capabilities. As you use me, I'll build new skills to help you better."

Empty states are not just placeholder text. They are the most important onboarding tool. Every empty state should teach the user what will eventually fill that space.

### 12.4 Keyboard Shortcuts
For a developer-oriented tool, keyboard shortcuts are essential:
- `/` to focus chat input (Slack convention)
- `Cmd+K` / `Ctrl+K` command palette (Linear/Vercel convention)
- `Cmd+Enter` to send message
- `Escape` to dismiss dialogs/modals
- `Tab` / `Shift+Tab` for approval quick-actions
- `Cmd+.` to cancel current task

The architecture should specify that Bridge implements a keyboard shortcut system (likely via a command palette pattern).

### 12.5 Undo/Redo Semantics
The architecture describes a system that takes real-world actions (writes files, sends emails, calls APIs). There is no undo model.

This needs design thought:
- **Undoable actions**: File writes (keep previous version), file deletes (trash/recycle, not permanent), configuration changes (revert)
- **Non-undoable actions**: Sent emails, API calls, shell commands with external effects
- **Communication**: After each action, show: "Done. [Undo]" for undoable actions. For non-undoable actions: "Done. (This action cannot be undone.)"

---

## 13. Specific Interaction Design Issues

### 13.1 The Gear Review Problem
Journal creates Gear and flags it for user review. What does "review" mean for a non-developer user? They cannot read TypeScript code. They cannot evaluate a JSON Schema manifest.

**Recommendation**: Show Gear in human terms:
- "I created a new skill: **RSS Digest**. It can fetch your favorite news feeds and summarize the top stories."
- "It needs these permissions: read websites, write files in your workspace."
- [Activate] [Delete] [View Code] (last option for developers only)

### 13.2 The Sentinel Memory Management Problem
Users can "review and manage Sentinel Memory through Bridge (view all stored decisions, revoke any decision, set expiry on decisions, clear all decisions)." This is another admin interface masquerading as a feature.

**Recommendation**: Present Sentinel Memory as "trust settings":
- "Things I'm allowed to do without asking:"
  - Delete files in /tmp [Revoke]
  - Push to git repos [Revoke] (expires in 23h)
  - Send email to @company.com [Revoke]
- "Things I'm not allowed to do:"
  - POST to external APIs [Remove block]

Frame it as permissions, not "memory decisions."

### 13.3 The Multi-Conversation Problem
The architecture describes a single conversation thread. But users will want to context-switch:
- "Let me ask about something else" mid-task
- "Go back to that project we were discussing"
- Multiple unrelated tasks in the same day

A single infinite thread makes context-switching impossible. Even ChatGPT has separate conversations.

**Recommendation**: Support multiple conversations (threads). Each thread has its own context window. Jobs are associated with their originating thread. Allow a "Quick question" mode that creates a temporary fast-path-only thread for simple queries that should not pollute the main working thread.

---

## 14. Summary of Critical Recommendations

| Priority | Recommendation | Impact |
|----------|---------------|--------|
| **P0** | Dual-mode interface (Chat + Mission Control) | Prevents the chat thread from becoming unusable |
| **P0** | Approval UX design + trust tiers (architecture has plan-level approval; needs UX spec and trust level configuration) | Prevents approval fatigue from day one |
| **P0** | Mobile-responsive layout | Enables approvals and monitoring from any device |
| **P0** | Progressive onboarding (5-minute setup) | Eliminates the setup wall for new users |
| **P1** | Define user-facing vocabulary (separate from architecture names) | Makes the system accessible to non-developers |
| **P1** | Background task cards with step tracking | Makes long-running tasks comprehensible |
| **P1** | Notification hierarchy with smart defaults | Prevents notification spam |
| **P1** | Error communication with step tracker | Makes partial failures understandable |
| **P1** | Empty states and loading states | Completes the UX for every system state |
| **P1** | Trust level profiles + Sentinel Memory seeding | Reduces first-week approval fatigue |
| **P2** | Conversational memory interface | Replaces database browser with natural interaction |
| **P2** | Dark mode from launch | Matches user expectations for developer/AI tools |
| **P2** | Multiple conversation threads | Enables context-switching between tasks |
| **P2** | Keyboard shortcuts / command palette | Matches developer tool expectations |
| **P2** | PWA support | Near-native mobile experience without a native app |
| **P3** | Gear review in human language | Makes Journal-generated Gear accessible to non-devs |
| **P3** | Voice input with transcript confirmation | Prevents voice transcription errors from causing harm |
| **P3** | Undo semantics for reversible actions | Reduces anxiety about autonomous execution |

---

## 15. Closing Thoughts

Meridian's architecture is meticulous about the backend: security boundaries, data isolation, sandboxing, information barriers. This is good engineering. But it reveals a blind spot common in architectures written by backend-first teams: the assumption that once the system works correctly, the interface will follow naturally.

It will not. The interface IS the product. The user will never see Axis routing messages, Sentinel's information barrier, or Journal's reflection pipeline. They will see a chat box, some buttons, and hopefully a system that feels simple despite being complex underneath.

The architecture needs a companion document: a UX specification with user journeys, wireframes, and interaction patterns for every state the system can be in. The ~80 lines currently dedicated to Bridge should be 600. The interface deserves the same rigor as the security model.

The hardest UX problem Meridian faces is not any single interaction. It is the tension between autonomy and control. Users want the system to "just do things" but also want to feel safe and informed. Every interruption (approval, error, notification) erodes the feeling of autonomy. Every silent action erodes the feeling of control. The interface must walk this line constantly, and the architecture document does not yet acknowledge that this line exists.

Build the UI as carefully as you build the sandbox. The sandbox protects the system from bad actors. The UI protects the user from the system's complexity. Both are critical infrastructure.
