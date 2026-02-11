# Architecture Patches: Privacy Advocate Review

> **Source**: `docs/critics/privacy-advocate.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (High > Medium > Low) then by section number.

---

## Patch 1: Sharpen Core Principle #2 Privacy Framing

**Severity**: High
**Review Finding**: #1 — The Privacy Framing Tension
**Target Section**: 2 (Executive Summary — Core Principles)

### Rationale

The lead sentence "All data stays on the user's device" is technically inaccurate for any deployment using external LLM APIs. The architecture already acknowledges API transmission in the same sentence and in Section 7, but the lead sentence is what readers remember. A medical query like "Draft an email to my doctor about my test results" causes data to leave the device to up to two separate LLM providers (Scout's and Sentinel's). Under GDPR Article 5(1)(a) (transparency), the storage-vs-processing distinction should be immediately clear, not buried in a compound sentence.

### Changes

**Section 2 — Core Principles, principle #2:**

Current:
> 2. **Privacy as a right** — All data stays on the user's device. LLM API calls transmit the minimum context necessary. No telemetry, no phoning home.

Proposed:
> 2. **Privacy as a right** — All persistent data is stored locally on your device. Task processing requires sending portions of your data to the LLM API providers you configure — Meridian transmits the minimum context necessary and logs every external transmission for your review. You can eliminate external data sharing entirely by using local models via Ollama. No telemetry, no phoning home.

**Section 7.1 — Core Privacy Principles, principle #1:**

Current:
> 1. **Local by default**: All data is stored on the user's device. Nothing is sent externally except to LLM APIs for processing, and only the minimum necessary context.

Proposed:
> 1. **Local by default**: All persistent data is stored on the user's device. When tasks require LLM processing, the minimum necessary context is transmitted to the user's configured LLM API providers. Every external API call is logged in the audit trail with exact content sent (viewable by the user). Users can run fully locally via Ollama for zero external transmission.

**Section 5.5 — Bridge Responsibilities, add a new bullet after the notification bullet:**

```markdown
- Display a visual indicator when data is being transmitted to external LLM APIs vs. processed locally
- Show a first-run disclosure during setup that lists which configured providers will receive data, what categories of data they receive, and links to each provider's data handling policy
```

---

## Patch 2: Acknowledge PII Stripping Limitations

**Severity**: High
**Review Finding**: #3 — LLM-Based PII Stripping is Unreliable
**Target Section**: 5.4.7 (Memory Privacy), 6.2 (LLM02 mitigation)

### Rationale

PII stripping is performed by an LLM during reflection. Academic literature shows even state-of-the-art NER systems achieve 85-92% recall on standard PII categories and far less on context-dependent PII (implicit health data, relationship graphs, compound inference). The architecture claims "stripping" with no validation, no measurement, and no fallback. Context-dependent PII like "I take insulin every morning" (revealing a health condition) or "left-handed Python developer at a 12-person startup in Lisbon" (likely unique) will regularly evade LLM-based detection.

### Changes

**5.4.7 — Replace the first bullet with:**

Current:
> - The Reflector strips PII (emails, phone numbers, addresses) from semantic and procedural memories before storage, replacing them with references to the user's identity record.

Proposed:
> - The Reflector applies **PII reduction** (not guaranteed stripping) to semantic and procedural memories before storage. This is a defense-in-depth measure with known limitations, not a security boundary:
>
>   **Two-pass PII reduction:**
>   1. **Pattern-based pass (deterministic):** Regex matching for structured PII — email addresses, phone numbers, SSNs, credit card numbers, IP addresses, and common credential patterns. Matched patterns are replaced with typed placeholders (e.g., `[EMAIL]`, `[PHONE]`).
>   2. **LLM-based pass:** The Reflector's LLM call identifies and replaces context-dependent PII (names, addresses, relationships, implicit identifiers) with references to the user's identity record.
>
>   **Known limitations (documented to users in Bridge):**
>   - Context-dependent PII ("my neighbor Bob") may not be detected.
>   - Implicit PII ("I take insulin every morning" reveals a health condition) is difficult for any automated system to reliably identify.
>   - Compound inference (multiple non-PII facts combining to uniquely identify a person) is not addressed by PII reduction.
>   - PII reduction effectiveness is not guaranteed. Users should review memories containing sensitive information.
>
>   **Memory staging:** New semantic and procedural memories enter a "staging" state visible in Bridge for a configurable review period (default: 24 hours) before being committed to long-term storage. During this period, the user can review, edit, or delete memories before they become part of Scout's retrieval context. Memories used for immediate retrieval during the staging period are marked as provisional.
>
>   **Special category data:** For memories that may contain GDPR Article 9 special category data (health, biometrics, political opinions, religious beliefs, trade union membership, sexual orientation), the user can configure per-category handling in Bridge: store normally, store with extra review, or never store. This is opt-in — by default, all memory categories are treated equally.

**6.2 — LLM02 mitigation, amend the PII stripping bullet:**

Current:
> - **PII stripping**: The Reflector removes PII from long-term memories.

Proposed:
> - **PII reduction**: The Reflector applies two-pass PII reduction (pattern-based + LLM-based) to long-term memories. This is a probabilistic control with known limitations (see Section 5.4.7). It reduces PII exposure but does not guarantee elimination.

---

## Patch 3: Classification-Aware Context Retrieval

**Severity**: Medium
**Review Finding**: #2 — Minimum Context Principle Could Be Strengthened
**Target Section**: 5.2.3 (Context Management)

### Rationale

The minimum context principle uses semantic relevance as the proxy for what to include in LLM context. But semantic relevance is not the same as GDPR data minimization. A weather query might retrieve "User lives at 42 Oak Street, Portland" because it's contextually relevant, transmitting a precise home address to the LLM provider. The default of 20 recent messages is generous — a conversation could contain sensitive information in earlier messages that has no bearing on the current query.

### Changes

**5.2.3 — Amend bullet 2 (Recent conversation):**

Current:
> 2. **Recent conversation**: Last N messages from the current conversation (configurable, default: 20).

Proposed:
> 2. **Recent conversation**: Last N messages from the current conversation (configurable, default: 10). A lower default reduces the likelihood of transmitting sensitive information from earlier in the conversation that is irrelevant to the current query.

**5.2.3 — Amend bullet 3 (Relevant memories):**

Current:
> 3. **Relevant memories**: Journal retrieves semantically similar past interactions via vector search (top-k, default: 5).

Proposed:
> 3. **Relevant memories**: Journal retrieves semantically similar past interactions via vector search (top-k, default: 3). Memories tagged as Confidential-tier (per Section 7.2) require a higher relevance threshold (>0.90 vs. default >0.75) before inclusion in context, ensuring that sensitive personal data is only transmitted when directly relevant to the task.

**5.2.3 — Add a new bullet after the four existing context bullets:**

```markdown
5. **Context preview (Confidential-tier tasks)**: When the assembled context includes
   Confidential-tier data (emails, calendar events, financial records per Section 7.2), Bridge
   can optionally show the user a preview of exactly what will be sent to the LLM before the
   API call is made. This is off by default for performance but can be enabled per data tier
   in Bridge settings.
```

---

## Patch 4: Surface LLM Provider Data Handling Policies

**Severity**: Medium
**Review Finding**: #4 — LLM Provider Data Handling Could Be Better Surfaced
**Target Section**: 7.3 (LLM API Data Handling)

### Rationale

Meridian commits to audit logging of all API calls (a strong control), but the statement that users choose providers with "full awareness" of data handling policies implies informed consent that the system doesn't actively facilitate. Provider policies differ materially (Anthropic's API terms don't use inputs for training by default; OpenAI requires opt-out for certain usage), change over time, and involve sub-processors and data residency implications. For EU users, sending data to US-based providers raises GDPR Chapter V concerns.

### Changes

**7.3 — Add after the existing five points:**

```markdown
6. **Provider privacy summary**: During provider configuration in Bridge, the system displays a
   standardized privacy summary card for each supported LLM provider, covering:
   - Whether API inputs are used for model training (and how to opt out if applicable)
   - Data retention period for API inputs
   - Data residency (where data is processed and stored)
   - Sub-processor disclosure
   - Link to the provider's full data handling policy and DPA (Data Processing Agreement)

   These summaries are maintained as a configuration file in the Meridian repository and updated
   with each release. Bridge displays a notice when a configured provider's summary was last
   updated more than 90 days ago, prompting the user to verify current terms.

7. **Data sharing disclosure**: Bridge clearly communicates that use of external LLM APIs
   constitutes data sharing with third parties. For deployments where GDPR applies, Bridge
   notes that the user should evaluate whether a DPA is needed for their use case and provides
   links to each configured provider's DPA request process.

8. **Data residency awareness**: For providers without EU data residency options, Bridge displays
   a note explaining that data will be processed outside the EU, with a reference to GDPR
   Chapter V (international transfers). This is informational — Meridian does not block any
   provider choice, but ensures the user makes an informed decision.
```

---

## Patch 5: Correct Embedding Inversion Claims

**Severity**: Medium
**Review Finding**: #5 — Embedding Inversion Risk is Understated
**Target Section**: 6.2 (LLM08 — Vector and Embedding Weaknesses)

### Rationale

The section header says "No embedding inversion" but the body text only claims embeddings "resist reconstruction." Research (Vec2Text, Morris et al.) demonstrates that embeddings from models like OpenAI's `text-embedding-ada-002` can be partially inverted. The header overstates the guarantee. Additionally, when external embedding APIs are used, the full plaintext is transmitted for embedding generation — the stored embedding's inversion resistance is irrelevant since the text was already sent externally.

### Changes

**6.2 — LLM08 section, replace the third bullet:**

Current:
> - **No embedding inversion**: Stored embeddings use dimensionality-reduced representations that resist reconstruction of original text.

Proposed:
> - **Embedding inversion resistance**: Stored embeddings use lower-dimensional representations (768 or 384 dimensions) that resist but do not prevent reconstruction of original text. Recent research (Vec2Text, 2023-2025) has demonstrated partial inversion of text embeddings — this is a risk-reduction measure, not a guarantee.
> - **Local embedding strongly recommended**: Local embedding generation (via Ollama) is the default and recommended configuration. When local embedding is used, memory content is never transmitted externally for embedding. If external embedding APIs are used (as a fallback on constrained devices), this is logged prominently in the audit trail and surfaced in Bridge's privacy dashboard — the full text is transmitted to the embedding provider, making inversion resistance of the stored embedding moot.
> - **Vector database encryption**: The vector embeddings (stored in `journal.db` per Section 8.2) are covered by the same encryption-at-rest mechanism as all other database files (see Section 6.4.1).

---

## Patch 6: Acknowledge Sensitive Metadata in Audit Logs

**Severity**: Medium
**Review Finding**: #6 — Audit Logs Contain Sensitive Metadata
**Target Section**: 6.6 (Audit Logging), 7.5 (Right to Deletion)

### Rationale

The `AuditEntry` interface includes `action`, `target`, and `details` fields. Action records *are* personal data when the actions reveal sensitive information: `{ action: "web-search", target: "divorce lawyer Portland Oregon" }` reveals a legal situation; `{ action: "network.post", target: "api.pregnancytracker.com" }` reveals health status. The claim that audit logs contain "no user content" is legally incorrect under GDPR Recital 26. If audit logs survive a Right to Deletion request, they continue to contain sensitive metadata.

### Changes

**6.6 — Amend the audit log description, add after existing bullets:**

```markdown
- **Audit entries are personal data.** Action records may contain sensitive metadata (file
  paths revealing health records, search queries revealing legal situations, network targets
  revealing personal circumstances). Under GDPR Recital 26, this constitutes personal data
  regardless of whether it is labeled as "content" or "metadata."
- **Audit log verbosity modes:** Users can configure audit log verbosity in Bridge:
  - **Full** (default): Records action type, specific target, and details. Maximum
    accountability.
  - **Reduced**: Records action type and risk level but replaces specific targets and details
    with generalized categories (e.g., `target: "/home/user/medical/..."` becomes
    `target: "[file-path]"`). Balances accountability with privacy.
  Users are informed of the tradeoff during setup.
```

**7.5 — Replace item 6:**

Current:
> 6. Audit logs are retained (they contain no user content, only action records).

Proposed:
> 6. Audit logs: On a full deletion request, audit log entries are **anonymized** — specific
>    targets and details are replaced with generalized categories (e.g., file paths become
>    `[file-path-redacted]`, URLs become `[url-redacted]`). The anonymized entries are retained
>    for the configured retention period to preserve the security audit trail. The action types
>    and timestamps are kept for accountability, but no entry can be linked back to specific
>    user content.

---

## Patch 7: Add Export PII Warning

**Severity**: Medium
**Review Finding**: #7 — Memory Export May Contain Un-Stripped PII
**Target Section**: 5.4.6 (User Transparency)

### Rationale

Given the acknowledged limitations of PII reduction (Patch 2), exported memory files will likely contain PII that was supposed to have been removed. A user who exports memories and stores them in a cloud service or shares them for debugging may inadvertently disclose PII they believed had been stripped.

### Changes

**5.4.6 — Amend the Export bullet:**

Current:
> - **Export**: Download all memories in a portable format (JSON/Markdown).

Proposed:
> - **Export**: Download memories in a portable format (JSON/Markdown). Two export modes:
>   - **Full export**: All memory data as-is, including any PII that was not caught by the
>     PII reduction process.
>   - **Sanitized export**: An additional PII-scrubbing pass (both pattern-based and LLM-based)
>     is applied to the export data, with the caveat that sanitization is imperfect.
>   Both modes display a clear warning: "Exported memories may contain personal information
>   including names, addresses, and other identifiers. Review the export before sharing with
>   others." Export files include metadata indicating the date, scope, and any sanitization
>   applied.

---

## Patch 8: Specify Voice Data Privacy Lifecycle

**Severity**: Medium
**Review Finding**: #8 — Voice Data Handling is Unspecified
**Target Section**: 5.5.3 (Input Modalities)

### Rationale

Voice recordings can reveal emotional state, accent, health indicators, and ambient conversations from non-consenting bystanders. The architecture specifies nothing about voice data storage, retention, deletion, or external transmission. If the Whisper API (external) is used, raw audio leaves the device — a more severe privacy event than text transmission because audio cannot be de-identified.

### Changes

**5.5.3 — Replace the Voice row in the Input Modalities table:**

Current:
> | Voice | Web Speech API for recording, Whisper API (or local whisper.cpp) for transcription |

Proposed:
> | Voice | Web Speech API for recording, local whisper.cpp for transcription (default), Whisper API as opt-in external alternative |

**5.5.3 — Add after the Input Modalities table:**

```markdown
#### 5.5.3.1 Voice Data Privacy

Voice data requires special handling because audio recordings inherently contain biometric
characteristics and may capture ambient speech from non-consenting bystanders.

**Voice data lifecycle:**

1. **Recording**: Audio is captured in-browser via the Web Speech API and held in memory only.
   Raw audio is never written to disk unless the user explicitly enables recording persistence.
2. **Transcription**: Local transcription via whisper.cpp is the default and recommended
   configuration. The audio never leaves the device.
3. **External transcription (opt-in)**: If the user explicitly enables external transcription
   (Whisper API / OpenAI), Bridge displays a clear disclosure: "Your voice recording will be
   sent to OpenAI for transcription. This audio may contain biometric characteristics and
   ambient speech." A visual indicator is shown whenever voice data is being sent externally.
4. **Deletion**: Raw audio is deleted from memory immediately after successful transcription.
   Only the text transcription is retained. If transcription fails, audio is held in memory
   for up to 3 retry attempts, then deleted regardless of outcome.
5. **No persistence**: Raw audio is never persisted to disk, included in Journal memories, or
   sent to LLM APIs. Only the text transcription enters the normal data pipeline.
6. **Bystander notice**: Bridge displays a note when voice input is first used: "Voice
   recording may capture speech from people nearby. Please be mindful of others' privacy."
```

---

## Patch 9: Add Image/Video Privacy Handling

**Severity**: Medium
**Review Finding**: #9 — Image and Video Privacy Handling is Absent
**Target Section**: 5.5.3 (Input Modalities)

### Rationale

Images and video can contain faces (biometric data under GDPR Article 9 when used for identification), photographed documents, EXIF metadata with GPS coordinates, and background content (whiteboards, screens, other people). The architecture says virtually nothing about privacy handling for visual data, and unlike text, images cannot easily be "minimized."

### Changes

**5.5.3 — Add after the Voice Data Privacy subsection:**

```markdown
#### 5.5.3.2 Image and Video Privacy

Images and video can contain concentrated personal data that is difficult to minimize.

**EXIF metadata stripping**: All uploaded images have EXIF metadata stripped before any
processing or storage. EXIF data can contain GPS coordinates, timestamps, device
information, and camera settings. Stripping is performed locally before the image enters
the data pipeline. The original EXIF data is not retained.

**Face detection advisory**: When images are about to be sent to external LLM APIs for
multimodal understanding, Bridge runs a lightweight local face detection check. If faces
are detected, the user is shown a notice: "This image appears to contain faces. Sending
it to [provider] will transmit this visual data externally." The user can proceed or
cancel. This is advisory only — no face recognition or identification is performed.

**Image/video lifecycle:**

1. **Storage**: Uploaded images and video are stored in `workspace/` with the same
   retention policy as other workspace files (configurable, default: 30 days).
2. **External transmission**: When images are sent to external LLM APIs for multimodal
   understanding, this is logged in the audit trail with the image file reference (not the
   full image data) and the destination provider.
3. **Deletion**: Images are deleted from workspace according to the retention policy.
   Deletion also removes any cached thumbnails or processed derivatives.

**Video handling**: Video is processed by extracting keyframes locally. Only the extracted
frames (as images) are sent to LLM APIs for understanding, not the full video file. The
frame extraction rate is configurable (default: 1 frame per 5 seconds) to minimize data
transmitted. The full video file remains local.

**Document images**: Images that appear to contain documents (detected via local OCR
heuristics) trigger a notice: "This image appears to contain a document. Consider whether
it contains sensitive information before sending it for processing."
```

---

## Patch 10: Acknowledge Gear Exfiltration Within Permissions

**Severity**: Low
**Review Finding**: #10 — Gear Data Exfiltration Within Allowed Permissions
**Target Section**: 6.1 (Threat Model), 5.6.1 (Design Philosophy)

### Rationale

A Gear with both legitimate filesystem read access and legitimate network access can exfiltrate any readable file to any allowed domain. The threat model already lists this adversary, and Gear auditing provides some mitigation, but the limitation of the manifest-based permission model should be explicitly documented so users understand the residual risk.

### Changes

**5.6.1 — Add after the three design principles:**

```markdown
**Known limitation — data exfiltration within declared permissions:** A manifest-based
permission model reduces the attack surface but cannot eliminate data exfiltration risk for
Gear that has both filesystem read access and network access. A Gear with both permissions
could read files within its allowed paths and transmit them to its allowed domains in ways
that are technically within its declared permissions but outside the user's intent.

**Mitigations:**
- All Gear network activity (request URL, response status, bytes transmitted) is logged in the
  audit trail and visible in Bridge.
- Gear that transmits significantly more data than its input parameters would suggest is flagged
  as anomalous in Bridge (e.g., a Gear that receives a 100-byte parameter but transmits 10 MB).
- The official Gear registry review process specifically audits for data exfiltration patterns.
- User-installed and Journal-generated Gear with both filesystem and network permissions are
  flagged with a "combined access" notice during installation/review.
```

---

## Patch 11: Tighten Data Retention Defaults

**Severity**: Low
**Review Finding**: #11 — Data Retention Defaults May Not Satisfy Data Minimization
**Target Section**: 7.4 (Data Retention)

### Rationale

GDPR Article 5(1)(e) requires data be kept no longer than necessary. 90 days of full conversation history is generous — most task-oriented interactions lose relevance within days. "Indefinite" retention of semantic memories containing sensitive information (e.g., "User is going through a divorce") lacks proportionality analysis. The 1-year audit log retention with sensitive metadata (per Patch 6) is also long.

### Changes

**7.4 — Amend the Data Retention table:**

Current:
> | Conversation messages | 90 days | Configurable, can delete individual messages |
> | Episodic memories | 90 days, then auto-summarized | Can delete, can disable auto-summarization |
> | Semantic memories | Indefinite | Can view, edit, or delete any entry |
> | Procedural memories | Indefinite | Can view, edit, or delete any entry |
> | Audit logs | 1 year | Cannot delete (integrity guarantee), can export |
> | Gear execution logs | 30 days | Configurable |

Proposed:
> | Conversation messages | 30 days | Configurable, can delete individual messages |
> | Episodic memories | 90 days, then auto-summarized | Can delete, can disable auto-summarization |
> | Semantic memories | Indefinite (with decay review) | Can view, edit, or delete any entry |
> | Procedural memories | Indefinite (with decay review) | Can view, edit, or delete any entry |
> | Audit logs | 1 year (routine) / 90 days (reduced mode) | Configurable. Anonymized on deletion request (see 7.5). |
> | Gear execution logs | 30 days | Configurable |

**7.4 — Add after the Data Retention table:**

```markdown
**Memory decay review:** Semantic and procedural memories that have not been retrieved for
a configurable period (default: 180 days) are surfaced in Bridge for user review. The user
can confirm (resetting the retrieval clock), edit, or delete these memories. This prevents
indefinite accumulation of potentially sensitive memories that are no longer useful.

**Sensitivity-aware retention:** Memories that the PII reduction system flags as containing
potentially sensitive categories (health, financial, legal) default to a shorter retrieval-
decay period (default: 90 days) before being surfaced for review.

**Data minimization mode:** For privacy-conscious users, Bridge offers a "data minimization"
configuration preset that sets aggressive defaults: 7-day conversation retention, 30-day
episodic retention, 90-day memory decay review, and reduced audit log verbosity.
```

---

## Patch 12: Complete the Right to Deletion Specification

**Severity**: Low
**Review Finding**: #12 — Right to Deletion is Incomplete
**Target Section**: 7.5 (Right to Deletion)

### Rationale

The deletion specification omits several data stores: Sentinel Memory (`sentinel.db`), backups, semantic response cache, vector embeddings (ambiguous), and log files. It also doesn't address data already sent to external LLM providers.

### Changes

**7.5 — Replace the existing deletion list with:**

```markdown
Users can request full data deletion at any time. This triggers a comprehensive deletion
process across all data stores:

1. Purges all conversation history from `meridian.db` (messages table).
2. Deletes all memory entries (episodic, semantic, procedural) from `journal.db`, including
   their associated vector embeddings and FTS5 index entries.
3. Deletes all Sentinel approval decisions from `sentinel.db`.
4. Clears the workspace (`data/workspace/`).
5. Removes all stored secrets from `secrets.vault`.
6. Resets all configuration to defaults.
7. Flushes the semantic response cache (Section 11.1).
8. Deletes application log files (`data/logs/`).
9. Audit logs are anonymized (see below), not deleted.
10. Backups: All automated backups are marked for immediate deletion. The user is informed
    that backups will be purged within 24 hours (to allow for a grace period in case the
    deletion was accidental).

**External data notice:** On completing deletion, Bridge displays a notice:
"Data stored on this device has been deleted. However, data previously sent to external LLM
API providers may be retained by those providers according to their own data handling
policies. Meridian cannot delete data held by third parties on your behalf." Bridge provides
links to the data deletion request process for each provider that was configured.

**Audit log handling:** Audit log entries are anonymized rather than deleted — specific
targets and details are replaced with generalized categories to preserve the security audit
trail structure while removing personal data. See Section 6.6 for details.

**Deletion verification:** After deletion completes, Axis runs an integrity check confirming
that all data stores have been purged. The result is displayed in Bridge.
```

---

## Patch 13: Add Privacy Governance Foundations

**Severity**: Low
**Review Finding**: #13 — Structural Privacy Governance Gaps
**Target Section**: 7 (Privacy Architecture) — add new subsections

### Rationale

The architecture is missing several standard privacy governance artifacts: external data flow diagrams, DPIA guidance, consent management for different processing activities, and explicit mapping of existing features to GDPR data subject rights. The existing memory management features already implement several rights — they should be explicitly documented as such.

### Changes

**Section 7 — Add new subsection 7.6 after Section 7.5:**

```markdown
### 7.6 Data Subject Rights Implementation

Meridian's existing features implement several GDPR data subject rights through Bridge:

| GDPR Right | Article | Meridian Implementation |
|------------|---------|------------------------|
| Right of access | Art. 15 | Memory browser: view all stored memories, filtered by type/date/keyword |
| Right to rectification | Art. 16 | Memory editor: correct or update any memory entry |
| Right to erasure | Art. 17 | Full deletion (Section 7.5), individual memory deletion |
| Right to restriction | Art. 18 | Pause memory recording for sensitive interactions |
| Right to data portability | Art. 20 | Memory export in JSON/Markdown format (Section 5.4.6) |
| Right to object | Art. 21 | Per-feature processing controls (see below) |

**Right to object — granular processing controls:** Bridge allows users to opt out of
specific processing activities independently:
- Disable Journal reflection entirely (no new memories created from interactions)
- Disable specific memory types (e.g., store procedural but not semantic memories)
- Disable voice input processing
- Disable image/video processing
- Disable external embedding (force local-only)

These controls allow the user to continue using Meridian with reduced functionality rather
than an all-or-nothing choice.
```

**Section 7 — Add new subsection 7.7:**

```markdown
### 7.7 External Data Flow Summary

The following table summarizes all data flows from the user's device to external services.
No data flows exist beyond those listed here.

| Destination | Data Sent | Triggered By | Audit Logged | Can Avoid |
|-------------|-----------|-------------|-------------|-----------|
| Scout LLM provider | System prompt, recent conversation (up to configured limit), retrieved memories, Gear catalog | Every full-path task; fast-path conversational queries | Yes — full content | Use local model via Ollama |
| Sentinel LLM provider | Execution plan only (required fields, no user message) | Every full-path task | Yes — full content | Use local model via Ollama |
| Reflector (Scout's provider) | Task result, execution logs, memory context | After journaled tasks | Yes — full content | Disable Journal reflection |
| Embedding provider | Memory text content | When creating/updating memories (if external embedding configured) | Yes — full content | Use local embedding (default) |
| Whisper API (if opted in) | Raw audio recording | Voice input (only if external transcription enabled) | Yes — file reference | Use local whisper.cpp (default) |
| Gear network targets | Varies per Gear action | During Gear execution | Yes — URL, status, bytes | Don't install Gear with network permissions |
| SearXNG instance | Search queries | Web search Gear usage | Yes | Self-host SearXNG (default Docker Compose) |

This table should be displayed in Bridge settings under a "Privacy" section so users can
review all external data flows at a glance.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Sharpen Core Principle #2 privacy framing | High | 2, 7.1, 5.5 |
| 2 | Acknowledge PII stripping limitations, add two-pass reduction + memory staging | High | 5.4.7, 6.2 |
| 3 | Classification-aware context retrieval, lower defaults | Medium | 5.2.3 |
| 4 | Surface LLM provider data handling policies in Bridge | Medium | 7.3 |
| 5 | Correct embedding inversion claims, strengthen local embedding default | Medium | 6.2 |
| 6 | Acknowledge sensitive metadata in audit logs, add verbosity modes | Medium | 6.6, 7.5 |
| 7 | Add export PII warning and sanitized export mode | Medium | 5.4.6 |
| 8 | Specify voice data privacy lifecycle | Medium | 5.5.3 |
| 9 | Add image/video privacy handling | Medium | 5.5.3 |
| 10 | Document Gear exfiltration limitation within allowed permissions | Low | 5.6.1, 6.1 |
| 11 | Tighten data retention defaults, add memory decay review | Low | 7.4 |
| 12 | Complete the Right to Deletion specification | Low | 7.5 |
| 13 | Add privacy governance foundations (rights mapping, data flow summary) | Low | 7 (new 7.6, 7.7) |

### Cross-References with Other Patches

Several patches from this review interact with patches from other critic reviews:

| This Patch | Other Patch | Interaction |
|-----------|-------------|-------------|
| #2 (PII reduction) | AI Researcher #4 (two-phase reflection) | Compatible. The pattern-based PII pass runs alongside the deterministic fact extraction from the AI researcher's Phase 1. Both add pre-LLM deterministic processing. |
| #3 (context retrieval defaults) | AI Researcher #9 (dynamic context budgets) | Compatible. Lower default counts (10 messages, 3 memories) work within the dynamic budget framework. Classification-aware retrieval adds a data-tier dimension to the budget allocation. |
| #5 (embedding inversion) | Database Engineer #4 (merge vector DB) | Compatible. After merging `journal-vectors.db` into `journal.db`, the encryption-at-rest from Database Engineer #3 automatically covers vector embeddings. |
| #6 (audit log metadata) | Database Engineer #6 (audit partitioning) | Compatible. Audit verbosity modes and anonymization on deletion work with monthly partitioned audit databases. Anonymization runs across all partitions. |
| #11 (retention defaults) | Database Engineer #11 (VACUUM strategy) | Compatible. Shorter retention defaults mean more frequent deletions, making the incremental auto-vacuum strategy more important for space reclamation. |
| #12 (right to deletion) | Database Engineer #5 (cross-consistency) | Compatible. The comprehensive deletion checklist aligns with the cross-database consistency model. Deletion cascades follow the same application-managed pattern. |
