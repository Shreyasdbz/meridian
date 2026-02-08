# Privacy Review: Meridian Architecture

**Reviewer**: Independent Privacy Advocate & Digital Rights Analyst
**Document Reviewed**: `docs/architecture.md` v1.2 (2026-02-07)
**Review Date**: 2026-02-07
**Methodology**: Line-by-line analysis against GDPR (EU 2016/679), CCPA/CPRA (California), ePrivacy Directive, OWASP LLM Top 10, and general privacy engineering best practices

---

## Executive Summary

Meridian presents itself as a privacy-first, self-hosted AI assistant where "privacy is a right." The architecture document contains genuinely thoughtful privacy engineering in several areas -- encrypted secrets, local storage, no telemetry, user-controlled memory, full audit logging of API transmissions, and a local-model path for zero external data sharing. These are real, positive commitments that distinguish it from cloud-hosted alternatives.

However, this review identifies **13 findings ranging from high to informational** that reveal areas where the architecture's privacy controls could be strengthened or its communication sharpened. The most significant tension is between the "all data stays on your device" framing and the operational reality that core LLM processing requires external API transmission -- a tension the architecture acknowledges but could address more prominently. Several additional findings relate to underspecified privacy controls for specific data modalities, incomplete regulatory compliance posture, and technical privacy measures whose limitations deserve documentation.

None of these findings are unique to Meridian -- they are endemic to the LLM-powered application space. But Meridian explicitly positions itself as the privacy-respecting alternative. A higher standard of scrutiny is therefore appropriate and invited.

**Overall Assessment**: Meridian's privacy posture is significantly stronger than cloud-hosted alternatives. The architecture explicitly addresses the external API tension, provides a genuine fully-local path, and includes audit controls that most competitors lack. The findings below identify areas where the gap between stated principles and operational reality can be further narrowed through clearer communication, additional controls, and more complete coverage of data modalities.

---

## Severity Classification

| Severity | Definition |
|----------|------------|
| **HIGH** | Significant privacy risk that could result in uncontrolled data exposure or likely regulatory concern |
| **MEDIUM** | Missing controls or underspecified behavior that creates privacy uncertainty |
| **LOW** | Minor gaps, best-practice deviations, or improvement opportunities |
| **INFORMATIONAL** | Observations that do not represent current risk but warrant tracking |

---

## Finding 1: The Privacy Framing Tension

**Severity: HIGH**

### The Claim

Section 2 (Core Principles):

> "Privacy as a right -- All data stays on the user's device. LLM API calls transmit the minimum context necessary. No telemetry, no phoning home."

### The Tension

Core Principle #2 is a compound statement: the first sentence asserts local data storage, while the second and third sentences explicitly acknowledge external LLM API transmission and commit to minimizing it. Section 7.1 reinforces this in its opening principle: "All data is stored on the user's device. Nothing is sent externally except to LLM APIs for processing, and only the minimum necessary context." The architecture does not hide this tension -- it addresses it directly, and Section 7.3 point 5 further commits to full audit logging of every API call including exact content sent.

However, the lead sentence -- "All data stays on the user's device" -- is what readers will remember, and it is technically inaccurate for any deployment using external LLM APIs. This matters because Meridian positions itself against platforms with weak privacy postures. The distinction between persistent storage (genuinely local) and processing (requires external transmission in default configuration) deserves more prominent treatment than a qualifier in the same sentence.

When a user says "Draft an email to my doctor about my test results," the following data leaves the device:

1. The user's message and retrieved memory context (to Scout's LLM provider)
2. The execution plan, which contains structured step parameters including action targets like email addresses (to Sentinel's LLM provider -- potentially a different company)
3. Reflection content, including outcome analysis and extracted learnings (to Scout's LLM provider -- the Reflector uses "a capable model, same as Scout or a model configured for code generation" per Section 5.4.3, not a separate third provider)

That is at most two separate companies receiving data derived from a single user interaction -- not three as one might assume, since Journal shares Scout's provider by default (the config.toml in Section 10.4 configures separate providers only for Scout and Sentinel, with Journal having only an embedding provider).

Under GDPR Article 5(1)(a) (transparency), data processing must be transparent to the data subject. Under GDPR Article 13, the user must be informed about the recipients of personal data. While the architecture does document these flows, the Core Principles framing could be clearer about the processing-vs-storage distinction.

### Recommendation

- Rephrase the lead sentence to distinguish storage from processing: "All persistent data is stored locally on your device. Task processing requires sending portions of your data to the LLM API providers you configure. You can eliminate external data transmission entirely by using local models."
- Add a first-run disclosure in Bridge that explicitly lists which providers will receive data, what categories of data they will receive, and links to each provider's data handling policy.
- Display a visual indicator in the UI when data is being transmitted externally vs. processed locally.

---

## Finding 2: "Minimum Context Principle" Could Be Strengthened

**Severity: MEDIUM**

### The Claim

Section 7.1 and 7.3:

> "Only the information Scout needs for the current task is included."

Section 5.2.3 specifies the context sent: system prompt, last 20 messages, top-5 semantically similar memories, and active job state. Section 11.1 further specifies explicit token budgets: ~2,000 tokens for the system prompt, up to 4,000 for recent conversation, and up to 2,000 for retrieved memories.

### The Problem

The minimum context principle is defined with concrete, configurable numbers -- this is a strength. However, the operative definition of "minimum" is driven by semantic relevance to the LLM's task, which is not the same as data minimization in the GDPR sense.

Consider: a user asks "What's the weather like?" The semantic search might retrieve a memory like "User lives at 42 Oak Street, Portland" because it is contextually relevant. That memory -- containing a precise home address -- is now sent to the LLM API provider. The minimum context principle did not prevent PII transmission; it arguably facilitated it by retrieving contextually relevant personal information.

The default of 20 recent messages is also generous. A conversation could easily contain sensitive information in messages 5-15 that has no bearing on the current query at message 20.

Under GDPR Article 5(1)(c), the data minimization principle requires that personal data be "adequate, relevant and limited to what is necessary in relation to the purposes for which they are processed." Semantic similarity to the current query is a reasonable proxy for relevance but is not identical to legal necessity. The architecture's numerical limits (configurable message count, configurable memory results, explicit token budgets) provide the mechanism for enforcement, but the defaults could be tighter.

### Recommendation

- Implement data classification-aware retrieval: memories tagged as "Confidential" (per Section 7.2) should require a higher relevance threshold before inclusion, or should be excluded from context unless the task explicitly involves that data category.
- Consider lower defaults for context messages (e.g., last 10 instead of 20) and memory results (e.g., 3 instead of 5).
- Consider a "context preview" feature that shows the user exactly what will be sent to the LLM before the API call is made, at least for tasks involving Confidential-tier data.

---

## Finding 3: LLM-Based PII Stripping is Unreliable

**Severity: HIGH**

### The Claim

Section 5.4.7 (Memory Privacy):

> "The Reflector strips PII (emails, phone numbers, addresses) from semantic and procedural memories before storage, replacing them with references to the user's identity record."

Section 6.2 (LLM02 mitigation):

> "PII stripping: The Reflector removes PII from long-term memories."

### The Problem

PII stripping is described as an LLM-driven process (the Reflector uses an LLM call per Section 5.4.3). LLM-based PII detection is demonstrably unreliable, particularly for:

1. **Context-dependent PII**: "My neighbor Bob" is PII in context but no NER model would flag "Bob" in isolation. "The house on the corner with the red door" is an indirect address.
2. **Non-standard formats**: International phone numbers, non-Western name formats, national ID numbers from different jurisdictions.
3. **Implicit PII**: "I take insulin every morning" reveals a health condition. "I pick up my kids from Lincoln Elementary at 3 PM" reveals children's school location and schedule. These are special category data under GDPR Article 9.
4. **Nicknames and references**: "Tell my wife" followed later by a name establishes a relationship. The PII is the relationship graph, not any individual datum.
5. **Compound inference**: Individual non-PII facts can combine to uniquely identify a person. "Left-handed Python developer at a 12-person startup in Lisbon" is likely unique.

Academic literature consistently shows that even state-of-the-art NER systems achieve 85-92% recall on standard PII categories and far less on context-dependent PII. An LLM doing PII stripping as a side task during reflection will likely perform comparably at best.

The architecture specifies no validation of the stripping, no measurement of its effectiveness, and no fallback when it fails.

### Recommendation

- Do not claim PII "stripping" as a privacy control. At best, call it "PII reduction" and explicitly document its limitations to users.
- Implement a defense-in-depth approach: combine LLM-based stripping with regex-based pattern matching for structured PII (emails, phones, SSNs, credit cards) as a second pass.
- Allow users to review memories before they are committed to long-term storage, not just after. A "memory staging" area with a review period would give users the opportunity to catch PII the system missed.
- For special category data (health, biometrics, political opinions, religious beliefs -- GDPR Article 9), consider not storing semantic memories at all without explicit user opt-in per category.
- Track and report PII stripping effectiveness metrics so users can make informed decisions.

---

## Finding 4: LLM Provider Data Handling Could Be Better Surfaced

**Severity: MEDIUM**

### The Claim

Section 7.3 (LLM API Data Handling):

> "Users choose their LLM provider with full awareness of each provider's data handling policies."

### The Problem

The architecture does take meaningful steps toward provider transparency: Section 7.3 point 5 commits to logging "every API call to external LLMs in the audit trail, including the exact content sent (viewable by the user, stored locally)." This is a genuinely strong transparency control that most competitors lack. Section 7.3 point 3 also commits to not recommending providers based on cost over privacy.

However, the statement that users choose providers with "full awareness" of their data handling policies implies a level of informed consent that the system does not actively facilitate beyond audit logging. Concretely:

1. **Policies differ materially**: As of early 2026, Anthropic's API terms state that API inputs are not used for training by default. OpenAI's API terms require an explicit opt-out for certain usage. Google's Gemini API terms differ again. These are not equivalent, but Meridian treats them identically during provider selection.

2. **Policies change**: Provider data handling policies are updated regularly. A user who configured their provider a year ago may be operating under materially different terms. Meridian has no mechanism to notify users of policy changes.

3. **Sub-processors**: LLM providers use sub-processors (cloud hosting providers, safety review teams, content moderation systems). Data shared with the primary provider may be further shared. The architecture does not surface this chain.

4. **Data residency**: For EU users, sending data to a US-based LLM provider raises GDPR Chapter V (international transfer) concerns. The Schrems II decision invalidated Privacy Shield, and the successor EU-US Data Privacy Framework is under ongoing legal challenge. Meridian does not surface data residency information.

5. **No DPA framework**: Under GDPR Article 28, when personal data is processed by a third party, a Data Processing Agreement is required. Meridian's architecture does not help users understand whether their LLM provider's terms constitute an adequate DPA.

### Recommendation

- At minimum, display a standardized privacy summary card for each LLM provider during configuration, covering: training data usage, retention period, sub-processors, data residency, DPA availability.
- Implement a provider privacy rating or classification visible in the UI (e.g., "This provider retains prompts for 30 days for safety review").
- Add a periodic check that surfaces when a configured provider's data handling terms have been updated, prompting the user to review.
- For EU users, flag providers without EU data residency options and explain the GDPR Chapter V implications.
- Document clearly that use of external LLM APIs constitutes data sharing with third parties and that the user should evaluate whether a DPA is needed for their jurisdiction and use case.

---

## Finding 5: Embedding Inversion Risk is Understated

**Severity: MEDIUM**

### The Claim

Section 6.2 (LLM08 mitigation):

> "No embedding inversion: Stored embeddings use dimensionality-reduced representations that resist reconstruction of original text."

### The Problem

The body text uses the measured phrase "resist reconstruction," which is defensible. However, the section header -- "No embedding inversion" -- makes a stronger categorical claim that the body does not support. This header language is what readers will take away.

1. **Inversion attacks are real and improving**: Research papers from 2023-2025 (Vec2Text by Morris et al., Text Embeddings Reveal Almost as Much as Text by various groups) have demonstrated that text embeddings from models like OpenAI's `text-embedding-ada-002` can be inverted to recover significant portions of original text content using iterative refinement techniques. "Resist reconstruction" is accurate; "No embedding inversion" overstates the guarantee.

2. **Dimensionality reduction helps but is not a guarantee**: The architecture mentions `nomic-embed-text` (768 dimensions) and `all-MiniLM-L6-v2` (384 dimensions) as local options. Lower-dimensional embeddings are harder to invert, but they still encode substantial semantic content.

3. **External embedding is the real risk**: The architecture allows embeddings to be generated via external APIs (OpenAI, Anthropic) when local embedding is not configured. In this case, the full text is sent to the API for embedding generation. The stored embedding's inversion resistance is irrelevant -- the plaintext was already transmitted.

4. **Constrained device fallback**: Section 11.2 notes that Raspberry Pi deployments may "skip local embeddings and use API-based embedding" due to resource constraints. The least powerful devices -- presumably chosen for privacy via self-hosting -- get the weakest privacy protection for embeddings.

### Recommendation

- Rename the section header from "No embedding inversion" to something like "Embedding inversion resistance" that matches the body text's more measured claim.
- Make local embedding the strong default across all deployment targets. If a Raspberry Pi cannot run `nomic-embed-text`, recommend `all-MiniLM-L6-v2` at 80 MB rather than falling back to external APIs.
- If external embedding APIs are used, log this prominently in the audit trail and surface it in the privacy dashboard.
- Encrypt the vector database (`journal-vectors.db`) at rest, just as other databases are described as encrypted.

---

## Finding 6: Audit Logs Contain Sensitive Metadata

**Severity: MEDIUM**

### The Claim

Section 7.5 (Right to Deletion):

> "Audit logs are retained (they contain no user content, only action records)."

### The Problem

The `AuditEntry` interface (Section 6.6) includes:

```typescript
action: string;    // e.g., "plan.approved", "file.write", "secret.accessed"
target?: string;   // What was acted upon
details: Record<string, unknown>;
```

Action records *are* user content when the actions themselves reveal sensitive information. Examples:

- `{ action: "file.write", target: "/home/user/medical-records/diagnosis-2026.pdf" }` -- reveals health data exists
- `{ action: "web-search", target: "divorce lawyer Portland Oregon" }` -- reveals legal situation
- `{ action: "message.send", target: "therapist@mentalhealth.com" }` -- reveals mental health treatment
- `{ action: "file.read", target: "/home/user/finances/bankruptcy-filing.docx" }` -- reveals financial distress
- `{ action: "network.post", target: "api.pregnancytracker.com" }` -- reveals health status

Under GDPR Recital 26, any information that can be used to identify or characterize a natural person is personal data, regardless of whether it is labeled as "content" or "metadata." The claim that audit logs contain "no user content" is legally incorrect under this standard.

Furthermore, if audit logs survive a Right to Deletion request (Section 7.5, item 6), they continue to contain this sensitive metadata after the user has explicitly requested all their data be deleted. This may violate GDPR Article 17 (Right to Erasure) unless the retention can be justified under one of the Article 17(3) exceptions (e.g., legal obligation, public interest). For a self-hosted personal assistant, these exceptions are difficult to argue.

### Recommendation

- Acknowledge that audit log entries constitute personal data and may contain sensitive metadata.
- On a Right to Deletion request, either: (a) delete audit logs entirely, or (b) anonymize them by replacing specific targets and details with generalized categories (e.g., `target: "/home/user/medical-records/diagnosis.pdf"` becomes `target: "[file-path-redacted]"`).
- If audit log retention is deemed necessary for security purposes, document the legal basis clearly and limit retention to the minimum necessary period, not a blanket 1 year.
- Allow users to configure audit log verbosity -- a "privacy mode" that records action types without specific targets.

---

## Finding 7: Memory Export May Contain Un-Stripped PII

**Severity: MEDIUM**

### The Claim

Section 5.4.6 (User Transparency):

> "Export: Download all memories in a portable format (JSON/Markdown)."

### The Problem

The architecture describes PII stripping in the Reflector (Section 5.4.7) but provides no guarantee that exported data has been successfully stripped. Given Finding 3 (PII stripping unreliability), exported memory files will likely contain PII that was supposed to have been removed.

This matters because exported data leaves the controlled Meridian environment. A user who exports their memories and stores them in a cloud service, shares them for debugging, or includes them in a bug report may inadvertently disclose PII that they believed had been stripped.

Under GDPR Article 20 (Right to Data Portability), the data subject has the right to receive their personal data in a structured, commonly used format. But the export mechanism should clearly communicate what the data contains, not imply a level of PII sanitization that may not have occurred.

### Recommendation

- Display a clear warning during export: "Exported memories may contain personal information including names, addresses, and other identifiers. Review the export before sharing."
- Offer two export modes: "full export" (all data as-is) and "sanitized export" (an additional PII-scrubbing pass using both LLM and pattern-matching, with the caveat that sanitization is imperfect).
- Include metadata in the export file itself indicating the date, scope, and any sanitization applied.

---

## Finding 8: Voice Data Handling is Unspecified

**Severity: MEDIUM**

### The Claim

Section 5.5.3 (Input Modalities):

> "Voice: Web Speech API for recording, Whisper API (or local whisper.cpp) for transcription"

### The Problem

Voice data requires careful privacy handling. A voice recording can reveal characteristics such as emotional state, accent (potentially revealing ethnicity/nationality), and health indicators. When used for the purpose of uniquely identifying a natural person, voice data constitutes biometric data under GDPR Article 9 (special categories). Even when Meridian uses voice only for transcription (not identification), the raw audio inherently contains these sensitive characteristics during transmission and processing.

The architecture specifies:
- **Nothing** about how voice recordings are stored
- **Nothing** about when voice recordings are deleted
- **Nothing** about whether raw audio is sent to external APIs (Whisper API is an OpenAI service)
- **Nothing** about whether the user is informed that their voice may be transmitted externally
- **Nothing** about whether voice recordings persist after transcription
- **Nothing** about what happens if transcription fails (is the audio retained for retry?)

If the Whisper API (external) is used, raw audio leaves the device. This is a more severe privacy event than text transmission because audio cannot be de-identified after the fact and may capture ambient conversations (third parties who did not consent).

### Recommendation

- Specify the complete voice data lifecycle: recording, storage, transmission, transcription, deletion.
- Make local transcription (whisper.cpp) the strong default. External Whisper API should require explicit opt-in with a clear disclosure that audio will be sent to OpenAI.
- Delete raw audio immediately after successful transcription. If transcription fails, delete audio after a maximum of N retries.
- Never persist raw audio to disk unless the user explicitly enables it.
- Display a clear indicator when voice input is being sent to an external service.
- Consider that recording ambient audio may capture third parties' speech. The architecture should address consent for bystanders, even if only to acknowledge the limitation.

---

## Finding 9: Image and Video Privacy Handling is Absent

**Severity: MEDIUM**

### The Claim

Section 4.1 shows Image/Video as an input modality. Section 5.5.3 describes:

> "Images: File upload or clipboard paste, sent as base64 or file reference"
> "Video: File upload, processed frame-by-frame or via video understanding APIs"

### The Problem

The architecture says very little about privacy handling for visual data. This is a significant omission because images and video can contain:

1. **Faces**: When used for identification purposes, facial data constitutes biometric data under GDPR Article 9. Even when Meridian is not performing facial recognition, images containing faces transmitted to external LLM APIs expose this data to the provider's processing.
2. **Documents**: Photographed documents (passports, medical records, financial statements) contain concentrated PII.
3. **Location data**: EXIF metadata in images contains GPS coordinates, timestamps, and device information.
4. **Background content**: Whiteboards, screens, papers on desks, other people in frame.
5. **License plates, street signs**: Identifying information about locations and potentially about third parties.

When images are sent to external LLM APIs for understanding (which is the primary way multimodal understanding works with current architecture), all of this data is transmitted to the provider. Unlike text, images cannot easily be "minimized" -- you generally cannot send a partial photograph and retain usefulness.

The "video understanding APIs" mentioned are entirely unspecified. Which APIs? What data do they receive? Are frames extracted locally or sent as raw video? How much video is retained?

### Recommendation

- Add a dedicated section on visual data privacy, at the same level of detail as the text data handling.
- Strip EXIF metadata from images before any processing or storage.
- Warn users when images containing detected faces are about to be sent to external APIs.
- Specify the complete lifecycle for uploaded images and video: storage location, retention period, deletion after processing.
- Consider implementing local image pre-processing (OCR for documents, face detection for warnings) before external transmission.
- For video, specify whether full video files or extracted frames are sent externally, and provide frame-rate/resolution controls to minimize data transmitted.

---

## Finding 10: Gear Data Exfiltration Within Allowed Permissions

**Severity: LOW**

### The Claim

Section 5.6 extensively describes the Gear permission model: declared filesystem paths, declared network domains, sandboxed execution.

### The Problem

The architecture is aware of this risk -- Section 6.1's threat model explicitly lists "Malicious Gear | Exfiltrate data | Unauthorized network access, file exfiltration" as a known adversary, and Section 5.6.1 commits to "every action a Gear takes is logged and auditable." These are meaningful controls.

However, the permission model, while necessary, is not sufficient to prevent data exfiltration by a Gear that has both legitimate filesystem read access and legitimate network access. A Gear that has both permissions can exfiltrate any file it can read to any server within its allowed domains.

Example: A `gmail-integration` Gear has:
- `filesystem.read: ["workspace/**"]` (to read attachments)
- `network.domains: ["api.gmail.com", "oauth2.googleapis.com"]`

This Gear could read any file in workspace and POST it to a Gmail draft (effectively exfiltrating to Google's servers), or send it as an email attachment. The permissions are all declared and approved, but the behavior is an exfiltration.

More subtly, a Gear could encode data in seemingly innocuous API calls -- query parameters, custom headers, timing patterns -- to its allowed domain. This is a covert channel that no manifest-based permission system can detect.

Sentinel validates execution plans, not Gear runtime behavior. Once Sentinel approves a plan that says "send email via gmail Gear," it has no visibility into what the gmail Gear actually transmits beyond what the audit log captures.

### Recommendation

- Acknowledge this limitation explicitly in the security architecture section. Manifest-based permissions reduce the attack surface but do not eliminate data exfiltration risk for Gear with both read and network permissions.
- Enhance Gear-level network traffic logging beyond action-level auditing: record the size and high-level content type of all network requests made by Gear, and surface anomalies.
- Consider a "data flow policy" layer that limits the volume of data a Gear can transmit relative to its input parameters. A Gear that reads 10 MB of files but only needs to send a 1 KB API request should be flagged if it transmits 10 MB.
- For user-installed and journal-generated Gear, implement a probationary period where network activity is monitored more closely.
- The code review process for the official Gear registry should specifically audit for data exfiltration patterns.

---

## Finding 11: Data Retention Defaults May Not Satisfy Data Minimization

**Severity: LOW**

### The Claim

Section 7.4 (Data Retention):

| Data Type | Default Retention |
|-----------|-------------------|
| Conversation messages | 90 days |
| Episodic memories | 90 days, then auto-summarized |
| Semantic memories | Indefinite |
| Procedural memories | Indefinite |
| Audit logs | 1 year |
| Gear execution logs | 30 days |

### The Problem

GDPR Article 5(1)(e) establishes the "storage limitation" principle: personal data must be "kept in a form which permits identification of data subjects for no longer than is necessary for the purposes for which the personal data are processed."

90 days of full conversation history is generous for a personal assistant. Most task-oriented interactions lose operational relevance within hours or days. Retaining 90 days of full messages means maintaining a detailed record of the user's activities, interests, and personal matters for three months.

"Indefinite" retention of semantic and procedural memories is particularly concerning. A semantic memory like "User is going through a divorce" (extracted from a conversation) persists forever by default. The purpose of this memory is to improve assistant responses, but the sensitivity of the information demands a proportionality analysis.

The auto-summarization after 90 days for episodic memories is a positive step, but summarization is not deletion. Summaries may retain enough detail to reconstruct sensitive information.

1 year of audit logs (which, per Finding 6, contain sensitive metadata) is a long default retention period.

### Recommendation

- Reduce default conversation retention to 30 days (sufficient for multi-turn tasks and follow-ups).
- Implement a "sensitivity-aware retention" policy: memories tagged with sensitive categories (health, financial, legal) default to shorter retention.
- Add an explicit "retention justification" in the UI for indefinitely-retained semantic memories, explaining why each is kept.
- Consider implementing "memory decay" -- semantic memories that have not been retrieved for a configurable period are surfaced for user review and potential deletion.
- Reduce default audit log retention to 90 days for routine entries, with 1 year only for security-relevant events.
- Provide a clear "data minimization mode" configuration that sets aggressive defaults for privacy-conscious users.

---

## Finding 12: Right to Deletion is Incomplete

**Severity: LOW**

### The Claim

Section 7.5 (Right to Deletion):

> "Users can request full data deletion at any time."

The section then lists what gets deleted and notes: "Audit logs are retained (they contain no user content, only action records)."

### The Problem

Beyond the audit log issue (Finding 6), the Right to Deletion specification has several gaps:

1. **Sentinel Memory**: Not mentioned in the deletion list. Sentinel Memory (`sentinel.db`) contains user approval decisions including action types and scopes (file paths, domains, command patterns). This is personal data that should be deleted on request.

2. **LLM provider retention**: Data already sent to external LLM providers cannot be recalled. The Right to Deletion implementation should inform the user that data previously transmitted to LLM APIs may be retained by those providers according to their own policies, and that Meridian cannot delete it on their behalf.

3. **Backups**: Section 8.4 describes automated daily backups retained for up to 3 months. Deleted data persists in backups unless backups are also purged. The deletion procedure does not mention backup handling.

4. **Semantic cache**: Section 11.1 describes a semantic response cache. Cached responses may contain data from deleted conversations. The cache should be flushed on deletion.

5. **Vector embeddings**: Section 7.5 states "Deletes all memory entries (episodic, semantic, procedural)," which arguably encompasses their associated vector embeddings in `journal-vectors.db`. However, this should be made explicit to avoid ambiguity, since the vector database is a separate file that could be overlooked in implementation.

6. **Log files**: Section 12.1 mentions file-based logs at `data/logs/meridian.log`. These may contain user activity information and should be purged on deletion.

### Recommendation

- Create a comprehensive deletion checklist that explicitly names every data store: `meridian.db`, `journal.db`, `journal-vectors.db`, `sentinel.db`, `audit.db`, `secrets.vault`, `workspace/`, semantic cache, log files, and backups.
- Explicitly inform users that data previously sent to external LLM APIs cannot be recalled, and provide links to each configured provider's data deletion request process.
- On full deletion, either purge all backups or mark them for accelerated expiry.
- Implement the deletion as a documented, tested, auditable process -- not an ad hoc collection of DELETE statements.

---

## Finding 13: Structural Privacy Governance Gaps

**Severity: LOW**

### Missing Elements

The architecture document, despite its thoroughness in technical design, is missing several standard privacy governance artifacts:

1. **Data Flow Diagrams for External APIs**: No visual or structured representation of exactly what data flows to which external service under which conditions. The text descriptions are scattered across multiple sections and require careful reconstruction. The interaction diagrams in Section 4.2 show internal component flows but not external data egress.

2. **Privacy Impact Assessment (PIA/DPIA)**: GDPR Article 35 requires a Data Protection Impact Assessment for processing that is "likely to result in a high risk to the rights and freedoms of natural persons." An autonomous AI agent that processes diverse personal data, accesses files, sends emails, and makes decisions on behalf of the user likely meets this threshold. No DPIA framework is referenced.

3. **Data Processing Agreement (DPA) Guidance**: Under GDPR Article 28, when a controller (the user) engages a processor (the LLM provider), a DPA is required. The architecture does not help users understand or fulfill this obligation.

4. **Consent Management**: The architecture describes a single authentication gate (password) but no granular consent mechanism. Under GDPR, different processing activities may require separate consent. For example: consent to send text to LLM APIs may not imply consent to send voice recordings to the same provider.

5. **Lawful Basis Analysis**: No discussion of the lawful basis for each processing activity under GDPR Article 6. For a self-hosted tool, the likely basis is "legitimate interests" (Article 6(1)(f)) or "consent" (Article 6(1)(a)), but this should be articulated.

6. **International Transfer Safeguards**: No mention of GDPR Chapter V requirements when data is sent to US-based LLM providers.

7. **Data Subject Rights Coverage**: Section 5.4.6 already implements several GDPR data subject rights through the memory management UI: access/view (Article 15), rectification/edit (Article 16), portability/export (Article 20), and a form of restriction via the pause feature (Article 18). These are strengths. However, the right to objection (Article 21) -- opting out of specific processing activities like Journal reflection while keeping other features active -- is not addressed. The existing rights implementations should also be documented explicitly as GDPR compliance features, which would strengthen Meridian's regulatory posture.

### Recommendation

- Create a standalone Privacy Architecture document or expand Section 7 significantly.
- Include a comprehensive data flow diagram showing all external data transmissions with data categories.
- Provide a DPIA template or checklist that users can complete for their specific deployment.
- Add a "Privacy Configuration" section in Bridge that allows granular consent for each data processing activity: text processing, voice processing, image processing, memory storage, external API usage.
- Document the assumed lawful basis for each processing category.
- Explicitly map the existing memory management features (view, edit, delete, export, pause) to their corresponding GDPR articles, and add the right to objection for specific processing activities.

---

## Positive Observations

This review would be incomplete without acknowledging what the architecture gets right:

1. **Local-first storage**: All persistent data in local SQLite databases is a genuinely strong privacy posture. It eliminates an entire category of server-side breach risks.

2. **No telemetry**: The commitment to zero telemetry, zero phoning home, and user-initiated-only update checks is exemplary and increasingly rare.

3. **Encrypted secrets**: AES-256-GCM with Argon2id key derivation is a solid implementation choice. Per-secret ACLs add meaningful access control.

4. **Memory transparency and control**: The ability to view, edit, delete, export, and pause memories is a strong implementation of user agency that already addresses multiple GDPR data subject rights.

5. **Local model option**: Supporting Ollama for fully offline operation provides a genuine zero-external-transmission path, which most competitors lack.

6. **Information barrier**: The Sentinel isolation design -- while primarily a security feature -- has privacy benefits by limiting how widely user data is disseminated within the system.

7. **Comprehensive audit trail**: The commitment to logging every external API call including exact content sent (Section 7.3 point 5) gives users unprecedented visibility into what data leaves their device.

8. **SearXNG integration**: Offering a privacy-respecting search engine as the default web search provider is a thoughtful choice.

9. **Explicit acknowledgment of API transmission**: Unlike many "privacy-first" platforms, the architecture explicitly addresses the tension between local storage and external LLM processing in its core principles, privacy section, and audit controls -- rather than ignoring it entirely.

---

## Summary of Findings

| # | Finding | Severity | GDPR Articles |
|---|---------|----------|---------------|
| 1 | Privacy framing tension: "all data local" phrasing vs. external API processing reality | HIGH | Art. 5(1)(a), Art. 13 |
| 2 | Minimum context principle defined with concrete limits but could integrate data classification | MEDIUM | Art. 5(1)(c) |
| 3 | LLM-based PII stripping is unreliable | HIGH | Art. 5(1)(f), Art. 25 |
| 4 | LLM provider data handling policies could be better surfaced to users | MEDIUM | Art. 13, Art. 28, Ch. V |
| 5 | Embedding inversion resistance is overstated in section header | MEDIUM | Art. 5(1)(f), Art. 32 |
| 6 | Audit logs contain sensitive metadata despite "no user content" claim | MEDIUM | Art. 17, Recital 26 |
| 7 | Memory export may contain un-stripped PII | MEDIUM | Art. 5(1)(f), Art. 20 |
| 8 | Voice data handling is unspecified | MEDIUM | Art. 9, Art. 13 |
| 9 | Image/video privacy handling is absent | MEDIUM | Art. 9, Art. 25 |
| 10 | Gear can exfiltrate data within allowed permissions (known threat, partially mitigated) | LOW | Art. 5(1)(f), Art. 32 |
| 11 | Data retention defaults too generous for data minimization | LOW | Art. 5(1)(c), Art. 5(1)(e) |
| 12 | Right to deletion is incomplete across data stores | LOW | Art. 17 |
| 13 | Missing standard privacy governance artifacts | LOW | Art. 25, Art. 35, Art. 28 |

---

## Closing Statement

Meridian is building something that the privacy community genuinely needs: a self-hosted AI assistant that takes user agency seriously. The architecture demonstrates real privacy thinking in many areas, and the local-first, no-telemetry, full-audit-trail commitments are meaningful differentiators. Notably, the architecture does not hide the tension between local storage and external API processing -- it addresses it directly in its core principles, provides audit controls for API transmissions, and offers a genuine fully-local path via Ollama.

The findings in this review are primarily about tightening existing controls, making implicit guarantees explicit, and extending the architecture's privacy thinking to underspecified areas (voice, image/video, audit metadata). The most impactful improvement would be sharpening the lead-sentence framing of Core Principle #2 so that the storage-vs-processing distinction is immediately clear, rather than requiring readers to parse a compound sentence.

The strongest version of Meridian is one that says: "All your data is stored on your device. When you use cloud LLM APIs, portions of your data are transmitted for processing -- here is exactly what is sent, to whom, and what they do with it, logged for your review. If that is unacceptable, here is how to run fully locally with zero external transmission." The architecture already supports this message; the framing should match it.
