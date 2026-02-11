# Architecture Patches: Open-Source Maintainer Review

> **Source**: `docs/critics/open-source-maintainer.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Add Phased Delivery Plan

**Severity**: Critical
**Review Finding**: #1 — Scope vs. Contributor Reality, #12 — Competitive Landscape ("Ship something before the competition catches up")
**Target Section**: 16 (Future Considerations) — restructure into a phased roadmap

### Rationale

The architecture describes a 7-package system with substantial complexity across every component, but there is zero source code. The reviewer's strongest recommendation is to cut scope ruthlessly for v0.1, shipping the smallest system that demonstrates the core value proposition — including Sentinel, because the dual-LLM trust boundary IS the differentiator. Everything not needed for that first release should be explicitly deferred. The current "Future Considerations" section lists features vaguely without tying them to milestones. A phased roadmap sets expectations for contributors and users, prevents scope creep, and signals that the project is shipping, not just designing.

### Changes

**Add new Section 16 "Delivery Roadmap" (replace the existing Section 16 "Future Considerations"):**

```markdown
## 16. Delivery Roadmap

This section defines what ships when. Features not listed in a milestone are explicitly deferred.
The milestones are scoped for 1-2 developers with AI-assisted development.

### 16.1 Milestone 1: Core Loop (v0.1)

**Goal**: A working system that demonstrates the core value proposition — user sends a message,
Scout plans, Sentinel validates, Gear executes, user sees a result. The dual-LLM trust boundary
must be present from the first release.

**In scope:**

| Component | What Ships | What Is Deferred |
|-----------|-----------|-----------------|
| **Shared** | Core types, message signing, validation utilities | — |
| **Axis** | Job queue (in-process + SQLite persistence), message router, basic scheduling (immediate + cron), graceful shutdown | Event bus, step-level parallelism, circuit breaker |
| **Scout** | Single-provider LLM integration (Anthropic), execution plan generation, fast path vs. full path routing | Adaptive model selection (use primary model only), multi-provider support |
| **Sentinel** | Plan validation against default risk policies, user approval flow | Sentinel Memory (auto-approve from precedent), composite-action analysis |
| **Bridge** | Text-only web UI (React SPA), Fastify API, WebSocket streaming, password authentication, session management | Voice input, video input, TOTP, browser push notifications, WCAG 2.1 AA (target, not blocking) |
| **Gear** | Process-level sandboxing, manifest validation, 3 built-in Gear: `file-manager`, `web-fetch`, `shell` | Container sandboxing, Gear signing/verification, `web-search` (requires SearXNG), `scheduler`, `notification` |
| **Journal** | — (not in v0.1) | All memory types, reflection pipeline, Gear Synthesizer |

**v0.1 explicitly omits Journal.** Without Journal, the system has no long-term memory — each
conversation is stateless beyond the current session. This is acceptable for v0.1 because the
core value proposition (safe task execution with independent validation) does not require memory.
Scout still receives the current conversation as context.

**Key property:** A user can install Meridian, send a natural language command, watch Scout plan
it, see Sentinel approve or reject it, and get a result — all within a single session.

### 16.2 Milestone 2: Memory & Learning (v0.2)

**Goal**: The system remembers. Journal is introduced, giving Meridian persistent context across
sessions and the ability to improve over time.

**Adds:**
- Journal with episodic, semantic, and procedural memory
- Hybrid retrieval (vector + FTS5)
- Reflection pipeline (two-phase, per AI researcher patch)
- Sentinel Memory (auto-approve from precedent decisions)
- Additional built-in Gear: `web-search`, `scheduler`, `notification`
- Multi-provider LLM support (OpenAI, Ollama)
- Adaptive model selection (primary/secondary)

### 16.3 Milestone 3: Growth (v0.3)

**Goal**: The system grows its capabilities. Gear Synthesizer enables Meridian to create new
Gear from experience. The Gear developer experience is polished enough for community
contributions.

**Adds:**
- Gear Synthesizer (composition-only scope per AI researcher patch)
- Gear SDK with scaffold command and local test harness
- Container-level sandboxing (Docker)
- Gear signing and verification
- MCP server wrapping (`meridian gear wrap`)
- Voice input (Web Speech API + Whisper)
- TOTP two-factor authentication
- Browser push notifications

### 16.4 Future Considerations

These are not part of the initial three milestones but are anticipated as the project matures:

- **Multi-user support**: Per-user auth, memory isolation, job queues, RBAC.
- **Messaging platform integration**: Telegram, Discord, Slack as Bridge plugins.
- **Gear marketplace**: Curated, signed registry with automated scanning and human review for
  high-permission Gear. Deferred until there are at least 20 community Gear packages. Use a
  curated `awesome-meridian` list on GitHub until then.
- **Full local LLM support**: Ollama/llama.cpp/vLLM for Scout and Sentinel on-device.
- **Agent-to-agent communication**: Federated Meridian instances.
- **Proactive behavior**: Anticipating user needs, governed by configurable proactivity levels.
```

---

## Patch 2: Add License Declaration

**Severity**: Critical
**Review Finding**: #5 — License and Legal Considerations
**Target Section**: 2 (Executive Summary) — add after Core Principles

### Rationale

The architecture document does not mention a project license. The reviewer calls this a "critical omission" — the license must be chosen before any code is written because changing licenses after contributors submit code requires consent from every contributor. For a security-focused self-hosted platform, the license choice has strategic implications: MIT/Apache-2.0 maximizes adoption but allows commercial appropriation without contribution; AGPL-3.0 forces service providers to contribute back but may deter enterprise contributors.

### Changes

**Section 2 — Add after the "Key Differentiators" table:**

```markdown
### License

Meridian is licensed under **Apache-2.0** for maximum adoption and contributor accessibility.

**Rationale:**
- Apache-2.0 includes an explicit patent grant, protecting contributors and users.
- No blanket enterprise bans (unlike AGPL, which many enterprises prohibit).
- Broad compatibility with other open-source licenses.
- The Contributor License Agreement (CLA) preserves the option to offer a commercial license
  for enterprise features (multi-user, managed hosting) in the future without requiring
  retroactive contributor consent.

**CLA requirement:** All contributors must sign a Contributor License Agreement before their
first PR is merged. The CLA grants the project the right to sublicense contributions, enabling
future licensing flexibility without affecting the open-source license of the existing codebase.
The CLA does not transfer copyright — contributors retain ownership of their contributions.

**What this means in practice:**
- Anyone can use, modify, and distribute Meridian freely, including for commercial purposes.
- Anyone can build a hosted service using Meridian without contributing changes back.
- The project can offer a commercially licensed "enterprise edition" with additional features
  (multi-user, SSO, managed hosting) if sustainability requires it (see Section 16.4).
- The core security components (Sentinel, Gear sandboxing, secrets management) remain
  Apache-2.0 forever — security should be a public good.
```

---

## Patch 3: Soften OpenClaw Framing

**Severity**: High
**Review Finding**: Additional Observations — "Lessons from OpenClaw" framing risks
**Target Section**: 3 (Lessons from OpenClaw)

### Rationale

The reviewer notes that while the security analysis is legitimate engineering rationale, the "What OpenClaw Got Wrong" framing creates two risks: (1) it sets extremely high expectations — any security vulnerability in Meridian will be called hypocritical, and (2) it creates adversarial dynamics with a 145K-star community. The CVEs and technical analysis are more powerful when framed as industry-wide patterns. The "Lessons Applied" table and technical content remain unchanged.

### Changes

**Section 3 — Rename the section and amend subsection headings:**

Current:
> ## 3. Lessons from OpenClaw

Proposed:
> ## 3. Lessons from Existing AI Agent Platforms

Current:
> ### 3.2 What OpenClaw Got Wrong

Proposed:
> ### 3.2 Common Failure Patterns

**Section 3 — Amend the introductory paragraph:**

Current:
> OpenClaw (formerly ClawdBot, then MoltBot) is an open-source AI agent platform that gained 145,000+ GitHub stars in early 2026. Its rapid adoption exposed critical architectural and security flaws that Meridian explicitly addresses. This section catalogs what OpenClaw got right, what went wrong, and how Meridian's architecture responds.

Proposed:
> The AI agent ecosystem has grown rapidly, with platforms like OpenClaw (145,000+ GitHub stars) demonstrating both the demand for autonomous AI assistants and the security challenges that come with them. This section analyzes the architectural patterns and failure modes observed across existing platforms — using OpenClaw as a concrete, well-documented case study — and explains how Meridian's architecture addresses each one.

**Section 3.3 — Amend the table heading:**

Current:
> | OpenClaw Failure | Root Cause | Meridian Mitigation |

Proposed:
> | Observed Failure | Root Cause | Meridian Mitigation |

---

## Patch 4: Add Gear Developer Experience

**Severity**: High
**Review Finding**: #3 — Gear Ecosystem Chicken-and-Egg, #12 — Competitive Landscape ("Prioritize MCP compatibility")
**Target Section**: 5.6 (Gear — Plugin System) — add new subsection 5.6.7

### Rationale

Meridian's value proposition depends on Gear, but Gear development requires a stable API, working sandbox, manifest validation, local test harness, documentation, and reference implementations — none of which exist yet. The reviewer identifies this as the classic platform chicken-and-egg problem: until the platform is stable enough for someone to build Gear, the ecosystem cannot grow; until the ecosystem grows, the platform has limited value. The fastest way to attract contributors to a plugin-based system is to make plugin development trivially easy.

### Changes

**5.6 — Add new subsection 5.6.7 after 5.6.6:**

```markdown
#### 5.6.7 Gear Developer Experience

The Gear ecosystem is Meridian's primary growth mechanism. Making Gear development trivially
easy is as important as making the Gear runtime secure.

**Scaffold command:**

```bash
meridian gear create my-gear
```

Generates a complete Gear project with:
- A stub MCP server with one example tool
- A `GearManifest` with minimal permissions
- A local test harness that runs the Gear in a mock sandbox
- A README explaining the manifest fields and how to add tools
- TypeScript types for `GearContext` and manifest validation

The scaffold produces a working Gear that can be tested locally in under 5 minutes without
running the full Meridian stack.

**Local test harness:**

```bash
meridian gear test ./my-gear
```

Runs the Gear in an environment that simulates the sandbox:
- Validates the manifest
- Checks that the Gear only accesses declared filesystem paths, network domains, and secrets
- Executes each declared action with sample parameters
- Reports any permission violations or manifest inconsistencies

The test harness is a standalone package (`@meridian/gear-sdk`) that can be installed and used
independently of the Meridian runtime. This allows Gear developers to work without installing
the full platform.

**Reference implementations:**

The three built-in Gear (`file-manager`, `web-fetch`, `shell`) serve as reference
implementations. Each demonstrates:
- Correct manifest structure with appropriate permission declarations
- Proper use of the `GearContext` API
- Error handling patterns
- Tests that verify sandbox compliance

**MCP server wrapping:**

Existing MCP servers can be wrapped as Gear without modification:

```bash
meridian gear wrap @modelcontextprotocol/server-filesystem
```

This discovers the MCP server's tools, generates a draft manifest with inferred permissions,
and registers it as available Gear (see Section 9.4). Users review and adjust the manifest
before activation.
```

---

## Patch 5: Right-Size Contribution Guidelines

**Severity**: High
**Review Finding**: #2 — Contribution Barriers, #4 — Documentation Burden, #7 — Testing Burden
**Target Section**: 15.2 (Contribution Guidelines)

### Rationale

The current contribution guidelines require "at least one review" for all changes, "two reviews" for security changes, and "tests for new functionality" on every PR. With one maintainer, the two-review requirement is unenforceable. The strict testing requirement will either be ignored (undermining credibility) or enforced (slowing development). The reviewer recommends right-sizing these guidelines for the current project stage while preserving the security intent.

### Changes

**15.2 — Replace the existing contribution guidelines:**

Current:
```markdown
### 15.2 Contribution Guidelines

- All code changes require a pull request with at least one review.
- Security-sensitive changes (Sentinel policies, sandbox implementation, auth) require two reviews.
- Every PR must include tests for new functionality.
- No new dependencies without explicit justification (security audit surface area).
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `security:`, `docs:`).
```

Proposed:
```markdown
### 15.2 Contribution Guidelines

These guidelines are designed for the project's current stage (solo maintainer, early
development). They will evolve as the contributor base grows.

**Current process:**
- All code changes require a pull request with maintainer review.
- No PR may break existing tests.
- Security-critical code (Sentinel validation, sandbox enforcement, authentication, secrets
  management) must include tests. Other code should include tests but this is not blocking —
  test backfilling is a welcome form of contribution.
- No new dependencies without explicit justification (security audit surface area).
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `security:`, `docs:`).

**Safe contribution zones** — areas where contributors can work without deep architectural
knowledge:
- Bridge UI components (purely visual, no security implications)
- Documentation improvements and corrections
- Built-in Gear following established patterns (use `file-manager` as a template)
- Test improvements and coverage additions
- CLI experience and error message improvements

**Future process (when the project has 3+ trusted committers):**
- Security-sensitive changes will require two reviews.
- A formal RFC process will be introduced for architectural changes.
```

---

## Patch 6: Add Governance Model

**Severity**: Medium
**Review Finding**: #6 — Governance Model
**Target Section**: 15 (Development Principles) — add new subsection 15.4

### Rationale

The reviewer identifies the absence of a governance model as a serious gap for a security-focused project. There is no documented process for merge access, architectural decisions, security disclosure, or project succession. The disconnect between the implicit BDFL model and contribution guidelines that imply a team will confuse contributors. The recommendation is to be explicit about the current model and plan for evolution.

### Changes

**Add Section 15.4 after 15.3 (or after the last current subsection in Section 15):**

```markdown
### 15.4 Governance

**Current model: Benevolent Dictator (BDFL)**

Meridian is currently maintained by a single developer. All architectural, security, and
release decisions are made by the maintainer. This is normal and appropriate for a project at
this stage.

**Decision-making:**
- Architectural decisions are documented in `docs/architecture.md` and updated via pull
  requests with rationale.
- Security decisions follow the architecture document's non-negotiable rules (Section 6).
  These rules cannot be weakened by any single contributor, including the maintainer, without
  a public RFC and community review period.
- Feature prioritization follows the delivery roadmap (Section 16). Changes to milestone scope
  require a documented rationale.

**Security disclosure:**
- Security vulnerabilities should be reported via email to [security contact — to be
  established before v0.1].
- The maintainer will acknowledge receipt within 48 hours and provide an initial assessment
  within 7 days.
- Critical vulnerabilities receive a patch within 72 hours of confirmation. Non-critical
  vulnerabilities are patched in the next scheduled release.
- Public disclosure follows a 90-day coordinated disclosure policy (or sooner if a patch is
  available).
- A `SECURITY.md` file in the repository root documents this process.

**Evolution plan:**
- At 3+ regular contributors: introduce a second committer with merge access and enable the
  two-review requirement for security changes.
- At 10+ regular contributors: formalize an RFC process for architectural changes and establish
  a core team with defined roles.
- At significant adoption: consider joining a foundation (Apache, Linux Foundation) for
  governance infrastructure, legal protection, and sustainability.

**Succession:** If the maintainer becomes unable to continue, [designated successor — to be
named] has access to the GitHub organization, npm packages, domain, and Docker Hub. This
information is documented privately and updated annually.

**Code of Conduct:** The project adopts the Contributor Covenant v2.1, documented in
`CODE_OF_CONDUCT.md` in the repository root.
```

---

## Patch 7: Simplify Release Strategy

**Severity**: Medium
**Review Finding**: #9 — Release Management
**Target Section**: 15.3 (Release Strategy)

### Rationale

The architecture specifies semver across packages, changesets, two release channels (stable and beta), and automated migration tooling. This is the release process of a mature project with a release manager. For a project with zero releases and one maintainer, coordinating semver across 7 packages is over-engineering. The reviewer recommends a single version number for the entire project, no beta channel initially, and deferring changesets.

### Changes

**15.3 — Replace the existing release strategy:**

Current:
```markdown
### 15.3 Release Strategy

- **Semantic Versioning**: `MAJOR.MINOR.PATCH`.
- **Release channels**: `stable` (default), `beta` (opt-in for early adopters).
- **Security patches**: Released immediately with a security advisory. Users are notified on next Bridge login.
- **Breaking changes**: Only in major versions, with a migration guide and automated migration tooling where possible.
```

Proposed:
```markdown
### 15.3 Release Strategy

**Current approach (pre-1.0):**

- **Single version**: The entire project ships under one version number (e.g., Meridian v0.1.0).
  Individual packages share this version. Independent package versioning is deferred until
  packages are useful standalone.
- **Single channel**: All releases go to `stable`. There is no beta channel — early versions
  are implicitly beta. A beta channel will be introduced when there is a stable channel worth
  protecting.
- **Manual changelogs**: Release notes are written manually with each release. Changesets or
  automated changelog generation will be introduced after the project has established a release
  cadence (5+ releases).
- **Security patches**: Released immediately with a security advisory. Users are notified on
  next Bridge login.
- **Breaking changes**: Expected and frequent during 0.x development. Each release includes a
  migration guide. Automated migration tooling is a goal but not a requirement before v1.0.

**Post-1.0 approach:**

Once the project reaches v1.0 (stable API, stable Gear format, production users):
- Adopt semantic versioning with coordinated package releases.
- Introduce a beta channel for early adopters.
- Require automated migration tooling for breaking changes.
- Evaluate changesets or similar tooling for changelog automation.
```

---

## Patch 8: Ship as Single Installable Unit

**Severity**: Medium
**Review Finding**: #9 — Release Management ("Ship as a single installable unit")
**Target Section**: 10.2 (Installation)

### Rationale

The reviewer recommends shipping as a single installable unit (`@meridian/cli`) even though packages are separate internally. Many successful projects (Next.js, Remix) do this. Users should not need to understand the internal package structure to install and run Meridian. The separate packages enforce important security boundaries (data isolation between components, preventing Sentinel from accessing Journal), so merging into a single package is not advisable — but the published surface should be a single entry point.

### Changes

**10.2 — Add after the existing installation options:**

```markdown
**Single entry point:** Regardless of installation method, Meridian presents as a single
application. Users install `@meridian/cli` (or the Docker image) — not individual packages.
The internal package separation enforces security boundaries (data isolation, component
independence) but is invisible to the user.

```bash
# All installation methods result in a single `meridian` command:
meridian setup          # First-run setup wizard
meridian start          # Start the server
meridian status         # Check system health
meridian stop           # Graceful shutdown
meridian backup         # Backup all databases
meridian restore <path> # Restore from backup
meridian export         # Export all data for migration
meridian update --check # Check for updates (no telemetry)
meridian gear create    # Scaffold a new Gear project
meridian gear wrap      # Wrap an existing MCP server as Gear
meridian gear test      # Test a Gear locally
```

The internal monorepo structure (Section 15.1) is a development concern. Published artifacts
are:
- `@meridian/cli` — The main application (npm)
- `@meridian/gear-sdk` — Standalone Gear development toolkit (npm)
- `meridian/meridian` — Docker image
```

---

## Patch 9: Acknowledge AI-Assisted Development

**Severity**: Medium
**Review Finding**: Additional Observations — AI-first development approach
**Target Section**: 15 (Development Principles) — add new subsection

### Rationale

The repository contains ~34 configuration files for AI coding assistants and 0 source files. This is an implicit signal that the project uses AI-assisted development. The reviewer recommends acknowledging this explicitly — contributors who arrive expecting a traditional development process will be confused by the extensive AI tooling. Frame it as a feature, not an oddity.

### Changes

**15 — Add new subsection 15.5 (after Governance):**

```markdown
### 15.5 AI-Assisted Development

Meridian is developed with AI coding assistants (Claude, GitHub Copilot) as a core part of
the development workflow. The repository includes configuration files for these tools to
maintain consistency with the project's architecture, code style, and security rules.

**What the AI configuration files do:**
- `.claude/rules/` — Document code conventions, architecture patterns, security rules, and
  testing expectations. These serve double duty as human-readable development guides.
- `.claude/agents/` and `.claude/skills/` — Define specialized workflows for common
  development tasks (implementing components, adding Gear, fixing issues).
- `.github/instructions/` and `.github/copilot-instructions.md` — Provide context for
  GitHub Copilot contributions.

**For contributors:**
- You do not need to use AI coding assistants to contribute. The configuration files are
  optional tooling, not requirements.
- If you do use AI tools, the configuration files help the AI understand the project's
  architecture and produce code that follows the established patterns.
- The `.claude/rules/` files are useful to read even if you are not using Claude — they
  are concise summaries of the architecture boundaries, code style, and security rules.
```

---

## Patch 10: Relax Early-Stage Testing Requirements

**Severity**: Medium
**Review Finding**: #7 — Testing Burden
**Target Section**: 13 (Testing Strategy) — add preamble

### Rationale

The testing strategy describes unit tests for 7 packages, integration tests with mock LLM providers, security tests (prompt injection, sandbox escape, auth), LLM output tests, and E2E Playwright tests. This is appropriate for the system being built but enormously expensive to maintain from day one. The reviewer recommends starting with integration tests (the most valuable early test is end-to-end message flow), backfilling unit tests as components stabilize, and not enforcing "every PR must have tests" at the start.

### Changes

**Section 13 — Add a preamble before 13.1:**

```markdown
## 13. Testing Strategy

**Phased testing approach:** The testing strategy below describes the full testing
infrastructure for a mature Meridian. Not all of it ships with v0.1. Testing investment
follows the delivery roadmap:

| Milestone | Testing Focus |
|-----------|--------------|
| v0.1 | Integration tests (message → plan → validate → execute → result), mock LLM provider utility, security tests for Sentinel validation and Gear sandboxing. Unit tests for Axis job scheduling. |
| v0.2 | Unit tests for Journal memory CRUD and retrieval. LLM output evaluation framework (Section 13.5). Prompt injection test suite. |
| v0.3 | E2E browser tests (Playwright). Gear Synthesizer output validation. Sandbox escape test suite. Full red-team test suite. |

**Principle:** No PR may break existing tests. Security-critical code must include tests.
All other testing requirements are goals, not gates — test backfilling is a valued
contribution.
```

---

## Patch 11: Address the Sustainability Question

**Severity**: Low
**Review Finding**: #11 — Sustainability
**Target Section**: 2 (Executive Summary) — add brief note; 16.4 (Future Considerations)

### Rationale

The reviewer identifies the lack of a sustainability plan as a long-term critical risk. For a security-focused project, abandonment is especially dangerous — stale installations with unpatched dependencies are worse than no installation. While a full business model is premature, acknowledging the question and outlining potential paths signals maturity and honesty to potential contributors and users.

### Changes

**16.4 (Future Considerations) — Add a sustainability subsection:**

```markdown
**Sustainability model:**

Meridian is currently a volunteer-maintained open-source project. Long-term sustainability
options under consideration:

- **Open core**: Core platform remains Apache-2.0 forever. Premium features (multi-user
  support, SSO, managed backup service, enterprise Gear) offered under a commercial license.
- **Hosted service**: Managed Meridian instances for users who prefer not to self-host.
- **Sponsorship**: GitHub Sponsors, Open Collective for community funding.
- **Support contracts**: Paid support and consulting for complex deployments.

No decision is required now. The Apache-2.0 license with CLA (Section 2) preserves all
options. The project will revisit sustainability when it has users and can evaluate which
model fits the community's needs.
```

---

## Patch 12: Include Generic Terms Alongside Theme Names

**Severity**: Low
**Review Finding**: Additional Observations — Naming theme as a contributor barrier
**Target Section**: Throughout (consistency measure), primarily Section 4

### Rationale

The navigation/cartography naming theme is memorable but adds a translation layer for contributors familiar with standard AI agent terminology ("planner," "validator," "memory," "UI," "plugin"). The architecture already does this in the Section 1 table, but is inconsistent elsewhere. The recommendation is to include generic terms in parentheses consistently, especially in diagrams and flow descriptions.

### Changes

**4.1 — Amend the component diagram labels to include generic terms:**

Current (example from diagram):
```
│    Scout    │
│  (Planner)  │
```

This pattern is already partially applied. Ensure it is applied consistently throughout all
diagrams and flow descriptions. Specifically:

**4.2 — Amend the interaction flow:**

Current:
```
User Input → Bridge → Axis → Scout (plan + model selection)
```

Proposed:
```
User Input → Bridge (UI/API) → Axis (runtime) → Scout (planner + model selection)
```

Current:
```
                                         Axis → Gear (execute)
```

Proposed:
```
                                         Axis → Gear (plugins, execute)
```

**Apply consistently:** Every first reference to a component in a section or subsection should
include the generic term in parentheses. Subsequent references in the same section can use the
theme name alone. This is a documentation style rule, not a code change.

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Add phased delivery plan (v0.1/v0.2/v0.3 roadmap) | Critical | 16 (rewritten) |
| 2 | Add license declaration (Apache-2.0 with CLA) | Critical | 2 |
| 3 | Soften OpenClaw framing to industry patterns | High | 3 |
| 4 | Add Gear developer experience (SDK, scaffold, test harness) | High | 5.6 (new 5.6.7) |
| 5 | Right-size contribution guidelines for current stage | High | 15.2 |
| 6 | Add governance model (BDFL, security disclosure, succession) | Medium | 15 (new 15.4) |
| 7 | Simplify release strategy (single version, no beta channel) | Medium | 15.3 |
| 8 | Ship as single installable unit | Medium | 10.2 |
| 9 | Acknowledge AI-assisted development methodology | Medium | 15 (new 15.5) |
| 10 | Relax early-stage testing requirements (phased approach) | Medium | 13 |
| 11 | Address sustainability question | Low | 16.4 |
| 12 | Include generic terms alongside theme names consistently | Low | 4 (throughout) |

### Cross-References with Other Patches

Several patches from this review interact with patches from other critic reviews:

| This Patch | Other Patch | Interaction |
|-----------|-------------|-------------|
| #1 (phased delivery) | AI Researcher #1 (scope down Gear Synthesizer) | Compatible and reinforcing. This patch defers Journal entirely from v0.1; the AI researcher patch scopes down the Synthesizer within Journal. Both apply: Journal arrives in v0.2 with the scoped-down Synthesizer arriving in v0.3. |
| #1 (phased delivery) | AI Tooling Engineer #1 (MCP-first) | Compatible. MCP wrapping (`meridian gear wrap`) is v0.3, but the built-in Gear in v0.1 can already be designed as MCP servers per the tooling engineer patch, ensuring the MCP-first architecture is in place from day one. |
| #4 (Gear developer experience) | AI Tooling Engineer #1 (MCP-first) | Complementary. The `meridian gear create` scaffold should generate an MCP server skeleton per the tooling engineer's MCP-first architecture. The `meridian gear wrap` command in this patch directly implements the tooling engineer's recommendation. |
| #5 (contribution guidelines) | AI Researcher #2 (evaluation framework) | Compatible. The relaxed testing requirements in this patch do not conflict with the evaluation framework — the evaluation framework is a v0.2 deliverable per the phased plan. |
| #7 (release strategy) | Database Engineer #9 (per-database migrations) | Compatible. Single project versioning simplifies the migration story — all databases are migrated together as part of a single release. |
| #10 (testing phase) | AI Researcher #2 (evaluation framework) | Directly aligned. The evaluation framework is explicitly placed in the v0.2 testing phase. |
| #11 (sustainability) | #2 (license) | The Apache-2.0 + CLA license choice enables all sustainability models described in the sustainability patch. |
