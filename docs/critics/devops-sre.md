# DevOps/SRE Critical Review: Meridian Architecture

> **Reviewer perspective**: Senior SRE/DevOps engineer with experience running self-hosted
> open-source software on edge devices, managing container deployments, building CI/CD pipelines,
> and handling incidents for always-on systems.
>
> **Document reviewed**: `docs/architecture.md` v1.2, `docs/idea.md`
>
> **Date**: 2026-02-07
>
> **Verdict**: The architecture is ambitious and well-thought-out from a security and software
> design perspective. From an operational standpoint, it has significant gaps that will cause
> real pain for the target audience (self-hosters running on Raspberry Pis and small VPSes).
> The document reads like it was written by someone who has thought deeply about security
> boundaries and LLM safety but has not yet operated a service on a 4GB ARM device with an
> SD card that corrupts when it loses power.

---

## Severity Ratings

| Rating | Meaning |
|--------|---------|
| **P0 - Critical** | Will cause data loss, outages, or security exposure in production. Must address before v1.0. |
| **P1 - High** | Will cause significant user pain or operational incidents. Should address before v1.0. |
| **P2 - Medium** | Will cause friction or confusion. Address in the first few releases. |
| **P3 - Low** | Nice to have, quality-of-life improvement. Can be deferred. |

---

## 1. Installation Complexity: Four Methods, Four Failure Surfaces

**Severity: P1**

The architecture offers four installation methods:

1. `curl | sh` install script
2. `npm install -g @meridian/cli`
3. `docker run`
4. `docker compose up`

Each of these has fundamentally different failure modes, dependency chains, and upgrade paths:

- **curl | sh** depends on platform detection (ARM64 vs x64 vs Apple Silicon), binary
  distribution, and assumes the user has `curl`, `sh`, and write access to wherever the
  binary lands. On a fresh Raspberry Pi OS install, this is fine. On a locked-down VPS,
  it may need `sudo`. On macOS, Gatekeeper may quarantine the binary.
- **npm global install** requires Node.js 20+ already installed. On a Pi, the default
  `apt` Node.js is usually v18 or older. The user needs to set up NodeSource or `nvm`
  first. This is a hidden prerequisite that will generate support tickets.
- **Docker** requires Docker to be installed and running. On a Pi, Docker's ARM64 images
  sometimes lag behind x64. The `better-sqlite3` native module needs to be compiled for
  the correct architecture inside the container.
- **Docker Compose** adds another layer. The compose file includes SearXNG, which is
  a second container. On a 4GB Pi, this means two containers competing for RAM before
  Meridian even starts doing work.

**The real question**: Who is testing all four installation methods on all target platforms
(Pi 4 ARM64, Pi 5 ARM64, Mac Mini Intel, Mac Mini Apple Silicon, Ubuntu VPS x64, Debian VPS
x64) on every release? That is at minimum 24 test matrix cells. Without CI covering this
matrix, one or more installation paths will silently break on a release and users will file
bug reports that the maintainers cannot reproduce.

**Recommendations**:
- Pick ONE blessed installation method per target platform and document it prominently. For Pi,
  that should be Docker or the install script. For Mac, npm or the install script. For VPS,
  Docker Compose.
- Build a CI matrix that tests at least one install method per platform per release. Use
  GitHub Actions ARM64 runners or QEMU for Pi testing.
- The `curl | sh` script should be versioned and tested, not a static file that bitrots. Pin
  the script to the release tag.
- Document minimum Node.js version prominently and provide a one-liner to install the right
  version alongside the npm install command.

---

## 2. Update Mechanism: "No Automatic Updates" Is a Security Liability

**Severity: P0**

The architecture states:

> "No automatic background checks. No data is sent beyond the HTTP request itself."
> Updates are "user-initiated."

This is philosophically aligned with the privacy-first ethos, and I respect the principle. But
operationally, this is dangerous for a system that:

1. Has an encrypted secrets vault with API keys for Anthropic, OpenAI, Google, etc.
2. Runs sandboxed code (Gear) that, if the sandbox has a bug, could escape.
3. Exposes an HTTP API (Bridge) that, if it has a vulnerability, is reachable from the
   local network at minimum.

When a critical CVE is discovered in Meridian (not "if" -- "when"), how do users learn about it?

- The architecture mentions "Security patches: Released immediately with a security advisory.
  Users are notified on next Bridge login." But "next Bridge login" could be days or weeks
  away for a system designed to run autonomously in the background. The whole point of Meridian
  is that it works without the user watching it.
- There is no push notification mechanism for security advisories. No RSS feed, no mailing
  list, no webhook.
- The Pi sitting under someone's desk running Meridian will cheerfully continue running a
  vulnerable version for months.

**Recommendations**:
- Implement a lightweight, privacy-respecting security advisory check. On startup (not
  continuously), Meridian checks a signed advisory endpoint (just a version number and
  severity, no telemetry). If a critical security patch exists for the running version,
  display a persistent banner in Bridge and optionally send a notification through the
  existing notification system (browser push, webhook).
- This is not telemetry. It is a one-way read of a public file, equivalent to checking a
  GitHub releases RSS feed. The distinction matters.
- Provide an official RSS/Atom feed and a mailing list for security advisories that users
  can subscribe to independently.
- Document a "security response" runbook: how the project will handle CVE disclosure,
  how quickly patches will be available, and what channels users should monitor.

---

## 3. Docker on Raspberry Pi: The RAM Math Does Not Work

**Severity: P1**

The architecture lists Raspberry Pi 4/5 with 4-8 GB RAM as the "primary target." The Docker
Compose file includes both the Meridian container and a SearXNG container.

Let us do the math for a 4GB Pi 4:

| Consumer | Estimated RAM |
|----------|---------------|
| Raspberry Pi OS (headless) | ~200-300 MB |
| Docker daemon | ~100-150 MB |
| Meridian container (Node.js + SQLite + worker pool) | ~300-500 MB |
| SearXNG container (Python + web server) | ~200-400 MB |
| sqlite-vec / embedding operations | ~100-300 MB (spikes during batch embedding) |
| Gear sandbox processes (2 concurrent workers) | ~256 MB each = ~512 MB |
| Kernel buffers, page cache, filesystem overhead | ~300-500 MB |
| **Total** | **~1.7-2.6 GB** |

That leaves 1.4-2.3 GB "free" on a 4GB Pi -- which sounds fine until you remember that:

- Linux will use most free RAM for page cache, which is reclaimable but causes latency spikes
  when reclaimed under pressure.
- The OOM killer will start targeting processes when memory is tight, and Docker containers
  are attractive targets.
- SD cards (common on Pis) have terrible random I/O performance, so swap is almost useless.
  An SSD helps, but the doc does not mention this as a prerequisite.
- Node.js V8 heap can fragment and hold onto memory even when not actively using it.

On an 8GB Pi 5, this is more comfortable. On a 4GB Pi 4, running Docker Compose with SearXNG
is asking for trouble.

**Recommendations**:
- Make SearXNG optional in the compose file with clear comments. Default to an API-based
  search Gear that does not require a local SearXNG instance.
- Document minimum RAM requirements honestly: 4GB for native install without Docker, 8GB for
  Docker Compose with SearXNG.
- For 4GB Pi deployments, recommend process-level sandboxing (no Docker) and API-based search.
  The architecture already mentions this preference in 11.2 but the compose file contradicts
  it by including SearXNG.
- Add memory limit declarations to the compose file (`mem_limit`/`deploy.resources.limits`)
  so containers cannot OOM the host.
- Strongly recommend SSD boot (not SD card) in the deployment documentation. SD card corruption
  is the number one cause of Raspberry Pi data loss in always-on deployments.

---

## 4. Backup/Restore: Not Crash-Consistent, Not Tested

**Severity: P0**

Section 8.4 states:

> "Automated backups: Daily backup of all SQLite databases to a configurable location."
> "Backup verification: After each backup, verify the SQLite integrity (PRAGMA integrity_check)."

Several critical questions are unanswered:

**How are backups taken?** There are two approaches for SQLite:

1. **File copy**: Copy the `.db` file. If a write is in progress during the copy, the backup
   is corrupted. With WAL mode enabled (as the architecture specifies), this is even more
   dangerous because you also need to copy the `-wal` and `-shm` files atomically with the
   main database file.
2. **SQLite Backup API** (`sqlite3_backup_init`/`step`/`finish`): This is the correct approach.
   It creates a consistent snapshot even while the database is being written to. The
   `better-sqlite3` library exposes this as `.backup()`.

The architecture does not specify which method is used. If someone implements file copy (the
naive approach), backups will occasionally be corrupted, and the `PRAGMA integrity_check` after
the backup will catch it -- but then what? The backup is bad, the previous backup was
yesterday, and you have lost up to 24 hours of data.

**Cross-database consistency**: Meridian has 5 SQLite databases plus a vault file. A backup
that captures `meridian.db` at time T and `journal.db` at time T+2s and `sentinel.db` at
time T+4s is not consistent. A job might be in `meridian.db` (status: completed) with its
memory entry missing from `journal.db` (because the journal backup happened before the
reflection completed). After restore, the system thinks a job is done but has no memory of it.

**Recommendations**:
- Mandate the SQLite Backup API for all database backups. Document this explicitly. Do not
  allow file copies as a backup method.
- Implement a backup coordinator that quiesces write activity (pauses the Axis worker pool),
  takes all backups in rapid succession, then resumes. This provides approximate cross-database
  consistency. Alternatively, use `BEGIN IMMEDIATE` transactions during backup to block writes.
- The `secrets.vault` file must also be backed up atomically. If it is mid-write during backup,
  the encrypted vault could be unreadable.
- Test backup/restore as part of CI. Create a database with known data, back it up, restore it,
  and verify the data matches. This is not optional.
- Consider a single-file export format (a tar.gz of all databases + vault + config) that is
  taken as a unit with all writes paused. This is the only way to guarantee cross-database
  consistency.

---

## 5. Migration Strategy: Forward-Only With No Tested Rollback

**Severity: P1**

> "Migrations are forward-only (no rollback -- backups serve this purpose)."

This is a common and defensible choice. However:

- **What happens when a migration has a bug?** The backup-before-migrate strategy is mentioned:
  the update mechanism says "Before updating, the current binary and data are backed up." But
  is this backup taken *after* the new binary is installed but *before* migrations run? Or
  before the binary update? The ordering matters enormously.
- **Are migration rollbacks tested?** If the answer is "restore from backup and run the old
  binary," has anyone tested that the old binary can actually read a database that was backed
  up from a state where the new migration partially ran before failing?
- **What about partial migration failures?** If migration 003 has 4 SQL statements and the
  third one fails, the `schema_version` table may or may not be updated depending on whether
  the migration is wrapped in a transaction. SQLite supports transactional DDL, which is good,
  but the architecture does not explicitly state that each migration runs in a transaction.
- **Schema version 5 databases exist in the wild.** Six months from now, when you are on
  schema version 12, a user who has been running version 0.1 decides to update. Migrations
  001 through 012 must all run sequentially and correctly. Is this tested?

**Recommendations**:
- Explicitly state that each migration runs inside a single SQLite transaction. If any
  statement fails, the entire migration is rolled back and the schema version is unchanged.
- The backup must be taken *after* the new binary is installed but *before* migrations run.
  Document this ordering.
- In CI, test the full migration chain: create a database at schema version 1, run all
  migrations through to the latest, verify the result. Do this for every release.
- Provide a `meridian db check` command that validates the database schema matches the expected
  version without modifying anything. This helps users diagnose migration issues.
- Consider keeping the last-known-good binary alongside the new one so `meridian rollback`
  actually works without the user needing to manually download an old release.

---

## 6. Log Management: JSON Logs on Constrained Storage

**Severity: P2**

> "File: data/logs/meridian.log with daily rotation (configurable, default: 7 days retained)."

JSON structured logging is the right choice for a system like this. However:

- **What is the realistic log volume?** A single job generates log entries for: message
  received, job created, dispatched to Scout, Scout responded, dispatched to Sentinel, Sentinel
  responded, dispatched to Gear, Gear started, Gear completed, result returned, Journal
  reflection started, Journal reflection completed. That is ~12 log entries per job at `info`
  level. At `debug` level, add API call details, token counts, timing data -- easily 30+ entries
  per job. At ~500 bytes per JSON log line, 100 jobs/day at info level = ~600 KB/day. At debug
  level with heavy usage, you could easily hit 10-50 MB/day.
- **On a 32GB SD card** (the minimum listed for Pi), 7 days of debug logs at 50 MB/day = 350 MB.
  That is ~1% of the disk, which is not catastrophic but adds up alongside databases, backups,
  workspace files, and the workspace downloads directory.
- **Is 7 days enough for debugging?** If a user notices something went wrong 10 days ago, the
  logs are gone. The audit log is retained for 1 year, but it contains action records, not
  debug traces. The gap between "what action happened" (audit) and "why did it fail" (debug
  logs) means that debugging old issues requires reproduction.

**Recommendations**:
- Default to `info` level logging. Make `debug` level opt-in and loudly warn that it increases
  storage usage significantly.
- Implement log size-based rotation in addition to time-based. A maximum of 100 MB of total
  log storage (configurable) prevents logs from filling the disk regardless of volume.
- Consider compressing rotated log files (gzip). JSON compresses extremely well (~10:1 ratio),
  turning 350 MB of rotated logs into ~35 MB.
- Provide a `meridian logs --export` command that bundles recent logs, relevant audit entries,
  and system information into a single file for sharing with maintainers (with sensitive data
  redacted).

---

## 7. Process Management: How Does Meridian Actually Run?

**Severity: P1**

The architecture mentions:

- Graceful shutdown on SIGTERM/SIGINT
- Crash recovery on restart
- Docker `restart: unless-stopped`

But it does not address how Meridian runs as a persistent service outside of Docker:

- **On a Pi or VPS without Docker**: How does Meridian start on boot? There is no mention of a
  systemd unit file. The user is presumably expected to create their own, or the install script
  creates one. But the install script is not documented in detail.
- **Crash loops**: What happens when Meridian crashes on startup (e.g., corrupted database,
  missing dependency, port already in use)? With Docker's `restart: unless-stopped`, it will
  restart and crash again, ad infinitum, burning CPU and filling logs. With systemd, the
  default behavior is to restart up to 5 times in 10 seconds and then give up, which is better
  but not great.
- **Resource limits**: The architecture mentions Gear resource limits (memory, CPU, timeout) but
  says nothing about limits on the main Meridian process itself. On a 4GB Pi, if the Node.js
  process leaks memory and grows to 2GB, everything else on the system suffers.
- **File descriptor limits**: Each SQLite database, each log file, each Gear sandbox process,
  each WebSocket connection consumes file descriptors. The default `ulimit -n` on many Linux
  systems is 1024. With 5 databases + logs + sockets + Gear processes, you can approach this
  limit under load.

**Recommendations**:
- Ship a systemd unit file as part of the install script. Include:
  - `Restart=on-failure` with `RestartSec=5s` and `StartLimitIntervalSec=60` /
    `StartLimitBurst=5` to prevent crash loops.
  - `MemoryMax=` set to 75% of system RAM to prevent the Meridian process from OOMing the host.
  - `LimitNOFILE=65536` to avoid file descriptor exhaustion.
  - `WatchdogSec=30` with corresponding systemd watchdog integration in Axis (the architecture
    mentions an internal watchdog, but it does not integrate with systemd's watchdog protocol).
  - `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=/path/to/meridian/data` for
    systemd-level sandboxing of the main process.
- For Docker, add `mem_limit` and `cpus` to the compose file.
- Document the Node.js `--max-old-space-size` flag for constraining V8 heap size on low-RAM
  devices.
- Implement a self-diagnostic on startup that checks: port availability, database readability,
  disk space, available RAM, file descriptor limits. Report problems clearly before attempting
  to start.

---

## 8. Monitoring: Prometheus on a Pi Is Enterprise Cosplay

**Severity: P2**

> "Axis exposes internal metrics via a /api/metrics endpoint (Prometheus format, opt-in)"

Prometheus metrics are a reasonable inclusion for VPS and power-user deployments. But for the
primary target audience (someone running this on a Pi), the question is: who is running
Prometheus? And Grafana to visualize it? That is two more services (or containers) on an
already memory-constrained device.

The practical monitoring story for a self-hosted Pi user is:

1. Open the Bridge UI.
2. Look at the health status.
3. Maybe check the logs.

If Prometheus is the *only* way to see system metrics (beyond the health endpoint), then 90%
of users have no operational visibility.

**Recommendations**:
- Build a lightweight system status dashboard directly into Bridge. Show: memory usage, disk
  usage, CPU load, database sizes, job queue depth, recent errors, LLM API latency, LLM cost
  today/this week/this month. No Prometheus needed.
- Keep Prometheus metrics for power users who already have a monitoring stack, but do not
  design the observability story around it.
- Add a `/api/status` endpoint (distinct from `/api/health`) that returns detailed system
  metrics in JSON for programmatic access without Prometheus.
- The existing health endpoint (Section 12.3) returns component statuses but no system-level
  metrics (RAM, disk, CPU). It should include these.

---

## 9. Secret Rotation: Reminder Without Enforcement Is a Post-It Note

**Severity: P2**

> "Rotation reminders: The system tracks secret age and can remind users to rotate
> old credentials."

This is better than nothing but raises operational questions:

- **What happens when an API key expires mid-job?** The architecture describes graceful
  degradation for LLM API unreachability (queue, retry, backoff) but does not specifically
  address authentication failures (HTTP 401/403). An expired API key returns a 401, not a
  connection error. Does the retry logic distinguish between "server is down" and "your
  credentials are invalid"? It should -- retrying a 401 with the same expired key is pointless
  and wastes the user's time while jobs pile up.
- **Rotation for what secrets?** The vault stores API keys for LLM providers, potentially
  email credentials, webhook tokens, etc. Each has a different rotation cadence and different
  consequences for expiry. A blanket "remind after N days" does not capture this.
- **No automated rotation**: For some secrets (e.g., Meridian's own session tokens, HMAC
  signing keys), automated rotation is feasible and should be implemented. The HMAC signing
  key generated at install time, for instance -- if it is never rotated, a compromise of that
  key at any point in the system's lifetime allows message forgery permanently.

**Recommendations**:
- Distinguish between retriable errors (5xx, network timeouts) and non-retriable errors
  (401, 403) in the retry logic. On a 401, immediately notify the user that the credential
  is invalid and pause jobs that depend on it. Do not retry.
- Implement automated rotation for internal secrets (HMAC signing key, session signing key).
  Rotate monthly. Support key rollover (accept both old and new key during a transition window).
- For external API keys, categorize them by expected lifetime (LLM API keys are typically
  long-lived, OAuth tokens are short-lived) and adjust reminder cadences accordingly.
- Provide a `meridian secrets check` command that tests all stored credentials by making a
  lightweight API call to each provider and reports which ones are valid, expired, or rate-limited.

---

## 10. Multi-Database Consistency: The Hardest Problem Nobody Mentioned

**Severity: P1**

Meridian uses 5 SQLite databases plus an encrypted vault file:

| Database | Owner | Purpose |
|----------|-------|---------|
| `meridian.db` | Axis | Jobs, config, schedules, gear registry |
| `journal.db` | Journal | Episodic, semantic, procedural memories |
| `journal-vectors.db` | Journal | Vector embeddings |
| `sentinel.db` | Sentinel | Approval decisions |
| `audit.db` | Axis | Append-only audit log |
| `secrets.vault` | Axis | Encrypted secrets |

This isolation is architecturally sound for security (Sentinel's data is isolated from
Scout's, etc.). But it creates a distributed consistency problem without a distributed
transaction mechanism.

**Failure scenarios**:

1. **Job completes, Journal reflection crashes**: `meridian.db` says job is done, `journal.db`
   has no reflection entry, `audit.db` has the completion event. On restart, how does the system
   know that Journal reflection needs to run? The job is already `completed`.
2. **Sentinel approves, system crashes before Gear executes**: `sentinel.db` records the
   approval, `meridian.db` has the job in `validating` state (crash happened before status
   update to `executing`). On restart, crash recovery resets to `pending` -- does Sentinel
   re-validate? Or does the system know to check `sentinel.db` for an existing approval?
3. **Journal creates a Gear, system crashes before gear table is updated**: The Gear source
   code exists in `workspace/gear/` (filesystem), but `meridian.db`'s `gear` table does not
   reference it. Orphaned Gear artifact.
4. **One database is corrupted, others are fine**: `journal.db` fails `PRAGMA integrity_check`.
   The user restores `journal.db` from yesterday's backup. But `meridian.db` references
   episode IDs from today. Now there are dangling references.

**Recommendations**:
- Implement a reconciliation process that runs on startup. It cross-checks:
  - Jobs in `executing` state have corresponding Gear execution records.
  - Jobs in `completed` state have either a Journal reflection or a `journalSkip: true` flag.
  - Gear entries in `meridian.db` have corresponding files in `workspace/gear/`.
  - Sentinel decisions reference valid plan IDs.
- Log reconciliation mismatches as warnings and take corrective action (re-queue missed
  reflections, clean up orphaned files).
- Accept that perfect cross-database consistency is impossible without 2PC (which is
  overkill here) and design for eventual consistency. The reconciliation process is the
  key mechanism.
- Document the failure modes and recovery procedures. Users need to understand that restoring
  a single database from backup can cause inconsistencies with other databases.
- Consider whether `journal-vectors.db` really needs to be a separate database. It is
  owned by Journal just like `journal.db`. Keeping them in the same file would eliminate
  one consistency boundary. The `sqlite-vec` extension should work as an additional table
  in `journal.db`.

---

## 11. Disk Space Management: Unbounded Growth Everywhere

**Severity: P1**

The workspace directory structure:

```
workspace/
  downloads/
  gear/
  projects/
  temp/
```

There is no mention of:

- **Download cleanup**: If a Gear downloads a 500 MB file, when is it deleted? If Gear runs
  daily and downloads something each time, the downloads directory grows without bound.
- **Temp directory cleanup**: Temp files from crashed Gear executions will accumulate. There
  is no mention of a periodic temp cleanup.
- **Gear artifact size**: Journal-generated Gear accumulates in `workspace/gear/`. If the user
  never reviews and deletes draft Gear, this grows indefinitely.
- **Database growth**: The architecture mentions 90-day episodic memory retention and 1-year
  audit log retention. But SQLite does not reclaim space from deleted rows automatically --
  it requires `VACUUM`. The architecture mentions "Database vacuuming... run during idle
  periods" (Section 11.2) but does not specify how often or what triggers it.
- **Backup storage**: 7 daily + 4 weekly + 3 monthly backups of 5 databases. If each database
  is 50 MB, that is 14 * 250 MB = 3.5 GB of backups. On a 32 GB SD card, that is over 10%
  of total storage just for backups.

Section 11.2 mentions "Alert when disk usage exceeds 80%. Pause non-critical operations at
90%." This is reactive, not proactive. By the time disk hits 80%, the user has already lost
headroom.

**Recommendations**:
- Implement explicit retention policies for workspace directories:
  - `temp/`: Clean files older than 24 hours automatically.
  - `downloads/`: Clean files older than 7 days unless referenced by a memory or Gear.
  - `gear/` (drafts): Notify user after 30 days of unreviewed drafts. Auto-delete after 90 days.
- Run `VACUUM` on each database monthly or when deleted rows exceed 20% of total rows.
- Track the size of each data directory in the Bridge status dashboard. Let the user see
  what is consuming space.
- Implement a `meridian cleanup` command that shows what can be cleaned and how much space
  it would free, then asks for confirmation.
- For backups, calculate actual backup sizes and warn if backup storage exceeds a configurable
  threshold (default: 2 GB). Consider incremental backups (SQLite's backup API supports this
  at the page level, though `better-sqlite3` may not expose it directly).

---

## 12. Health Check Depth: Looks Healthy, Is Not

**Severity: P2**

The health endpoint (Section 12.3) returns:

```json
{
  "status": "healthy",
  "components": {
    "scout": { "status": "healthy", "provider": "anthropic" },
    "sentinel": { "status": "healthy", "provider": "openai" }
  }
}
```

**What does "healthy" mean for Scout and Sentinel?** Merely that the component is loaded?
That the provider is configured? Or that a test API call succeeded? The difference matters:

- If "healthy" means "configured," then Scout shows as healthy even when the Anthropic API
  is down or the API key has expired. The user sees green status and wonders why no jobs
  are completing.
- If "healthy" means "last API call succeeded," that is better but can be stale. The last
  call might have been an hour ago.
- If "healthy" means "we just made a test call," that costs money (LLM API charges) and
  adds latency to the health check.

Similarly, the health check does not mention:

- Database connectivity (can all 5 databases be opened and queried?).
- Disk space status.
- Memory pressure.
- Gear sandbox readiness (can a sandbox be created?).
- Backup recency (when was the last successful backup?).
- Certificate expiry (if TLS is configured).

**Recommendations**:
- Implement tiered health checks:
  - **Shallow** (`/api/health`): Fast, no external calls. Checks process is alive, databases
    are openable, disk has >10% free. This is what Docker/systemd/load-balancers hit.
  - **Deep** (`/api/health?deep=true`): Checks LLM API reachability (a lightweight call like
    listing models, not a generation), database integrity, sandbox creation, backup recency.
    Takes a few seconds. Not for automated polling, but for user-initiated diagnostics.
- Include last-known-good timestamps for each component: "scout: healthy, last successful
  API call 3 minutes ago."
- Include disk and memory metrics in the health response.

---

## 13. Incident Response: No Debug Bundle, No Diagnostics

**Severity: P1**

When things go wrong at 3 AM on someone's Pi, what can they do?

The architecture provides:

- Job inspector in Bridge UI (requires Bridge to be functional).
- Replay mode (requires the system to be running).
- Dry run mode (requires the system to be running).
- Logs in `data/logs/` (requires SSH access and command-line skills).
- Audit log in `audit.db` (requires SQLite knowledge to query directly).

**What is missing**:

- **CLI diagnostics**: There is no `meridian doctor` or `meridian diagnose` command that can
  run when the web UI is broken or inaccessible. If Bridge will not start, the user has no
  diagnostic tools except reading raw log files and database files.
- **Debug bundle**: There is no way to generate a tarball of sanitized diagnostics (recent logs,
  system info, database schema versions, configuration without secrets, last N audit entries,
  error counts) that the user can attach to a GitHub issue.
- **Remote diagnostics**: For a headless Pi, the user needs to SSH in. If they cannot SSH (or
  do not know how), they are stuck.
- **Error codes**: The architecture does not mention structured error codes. When a user
  reports "it said failed," a maintainer needs to know *which* failure mode. Every error class
  should have a unique code (e.g., `AXIS_DB_OPEN_FAILED`, `SCOUT_API_TIMEOUT`,
  `GEAR_SANDBOX_CREATE_FAILED`) that can be searched in documentation.

**Recommendations**:
- Implement `meridian doctor` that checks: Node.js version, database integrity, disk space,
  port availability, configuration validity, secret vault readability, LLM API connectivity,
  Docker availability (if relevant). Outputs a report in both human-readable and JSON format.
- Implement `meridian debug-bundle` that creates a `.tar.gz` of sanitized diagnostics. Strip
  all secrets, API keys, and user message content. Include: last 1000 log lines, system info,
  database schema versions, configuration (sanitized), error counts by type, disk/memory
  usage, uptime, last 100 audit entries (action types only, no details).
- Assign unique error codes to all failure modes. Document them on a public error reference
  page.
- In the Bridge UI, when an error occurs, display the error code with a link to documentation
  for that specific error.

---

## 14. Missing: Main Process Resource Governance

**Severity: P1**

The architecture is meticulous about Gear resource limits:

> "maxMemoryMb: 256 MB, maxCpuPercent: 50%, timeoutMs: 300000"

But says nothing about limiting the main Meridian process itself. This is like putting locks
on all the cabinet doors but leaving the front door wide open.

**Missing controls**:

| Resource | Risk | Status |
|----------|------|--------|
| **Main process memory** | Node.js V8 heap can grow unbounded due to memory leaks, large context assembly, or vector operations. On a 4GB Pi, an unconstrained Node.js process can OOM the entire system. | **Not addressed** |
| **OOM killer behavior** | On Linux, when memory is exhausted, the OOM killer picks a victim. Without `oom_score_adj`, it might kill SearXNG or Docker instead of Meridian, leaving the system in a weird half-alive state. | **Not addressed** |
| **File descriptor limits** | 5 SQLite databases (open connections) + log files + WebSocket connections + Gear sandbox IPC + HTTP connections. Under load, file descriptor exhaustion causes cryptic "EMFILE: too many open files" errors. | **Not addressed** |
| **systemd watchdog** | The architecture mentions a 10-second event loop watchdog, but this is internal only. If the process hangs completely (deadlock, V8 GC pause), nobody restarts it. systemd's `WatchdogSec` with `sd_notify` provides external watchdog support. | **Not addressed** |
| **CPU governor** | On a Pi, the default CPU governor may be `ondemand` or `powersave`, which throttles CPU frequency. Under sustained LLM API wait + Gear execution load, this can cause unexpected latency. | **Not addressed** |
| **Swap configuration** | On a Pi with limited RAM, swap can prevent OOM but destroys performance on SD cards. The architecture says nothing about whether swap is expected, recommended, or dangerous. | **Not addressed** |
| **Kernel parameters** | `vm.swappiness`, `vm.dirty_ratio`, `fs.file-max`, `net.core.somaxconn` -- these matter on constrained devices and the architecture does not mention any of them. | **Not addressed** |

**Recommendations**:
- Set `--max-old-space-size` on the Node.js process. Default to 1024 MB on 4GB systems,
  2048 MB on 8GB+ systems. Make it configurable.
- Ship a sysctl configuration file for Pi/Linux deployments with recommended kernel parameters.
- In the systemd unit file, set `OOMScoreAdjust=-100` to make Meridian less likely to be
  OOM-killed compared to other processes.
- Integrate with systemd watchdog: periodically call `sd_notify(0, "WATCHDOG=1")` from the
  Axis event loop. Set `WatchdogSec=30` in the unit file. If Axis hangs, systemd restarts it.
- Document swap recommendations: if using SSD, 2GB swap is fine. If using SD card, swap off
  is better (accept OOM kills over SD card destruction from swap thrashing). If using zram
  (compressed in-memory swap), 1GB zram is a good middle ground.

---

## 15. Miscellaneous Operational Concerns

### 15.1 Time Synchronization

**Severity: P3**

Meridian uses UUID v7 (time-sortable), ISO 8601 timestamps, cron scheduling, and
24-hour cache expiry. All of these depend on accurate system time. A Raspberry Pi has no
hardware real-time clock by default. If it boots without network access, the system clock
can be wildly wrong until NTP syncs.

**Recommendation**: On startup, check if the system clock is obviously wrong (e.g., year <
2026) and warn the user. Consider requiring NTP synchronization as a prerequisite for
scheduled job execution.

### 15.2 Power Loss on Raspberry Pi

**Severity: P2**

Pis get unplugged. Power outages happen. SD cards do not have power-loss protection. SQLite
in WAL mode with `synchronous=NORMAL` (the default for `better-sqlite3`) can lose the last
few transactions on power loss. With `synchronous=FULL`, writes are slower but safer.

**Recommendation**: Default to `synchronous=FULL` for `audit.db` and `secrets.vault`
(integrity matters more than performance). Use `synchronous=NORMAL` for other databases where
some data loss is tolerable. Document this tradeoff.

### 15.3 SD Card Wear

**Severity: P2**

SQLite WAL mode with frequent writes (every job, every reflection, every audit entry) generates
significant write amplification. SD cards have limited write endurance. An always-on system
writing to an SD card can wear it out in 1-2 years.

**Recommendation**: Strongly recommend SSD boot or USB-attached SSD for the data directory.
Provide instructions for moving the `data/` directory to an external SSD while keeping the
OS on SD card. Monitor write volume and warn if it seems excessive.

### 15.4 IPv6 / Dual-Stack

**Severity: P3**

The architecture mentions binding to `127.0.0.1` but says nothing about IPv6. Some systems
are IPv6-only or dual-stack. If a user's Pi has IPv6 but the application only binds IPv4
localhost, things get confusing.

**Recommendation**: Bind to `[::1]` as well, or use a dual-stack socket. Document the
behavior.

### 15.5 Concurrent Meridian Instances

**Severity: P2**

What happens if a user accidentally starts Meridian twice? Two processes writing to the same
SQLite databases. SQLite's locking will prevent corruption (WAL mode allows concurrent reads
but only one writer), but the second instance will get `SQLITE_BUSY` errors constantly.

**Recommendation**: Use a PID file or advisory lock on the data directory. On startup, check
for an existing lock. If found, refuse to start with a clear error message.

---

## Summary of Recommendations by Priority

### P0 - Must Fix Before v1.0

| # | Issue | Section |
|---|-------|---------|
| 1 | Implement crash-consistent backup using SQLite Backup API with cross-database quiescence | 4 |
| 2 | Add a privacy-respecting security advisory check mechanism | 2 |

### P1 - Should Fix Before v1.0

| # | Issue | Section |
|---|-------|---------|
| 3 | Pick blessed installation method per platform; build CI test matrix | 1 |
| 4 | Honest RAM requirements; make SearXNG optional; add compose memory limits | 3 |
| 5 | Wrap migrations in transactions; test full migration chains in CI | 5 |
| 6 | Ship systemd unit file with resource limits and watchdog integration | 7 |
| 7 | Implement startup reconciliation for cross-database consistency | 10 |
| 8 | Implement workspace cleanup policies and `VACUUM` scheduling | 11 |
| 9 | Build CLI diagnostics (`meridian doctor`, `meridian debug-bundle`) | 13 |
| 10 | Set Node.js heap limits; document swap/OOM/fd recommendations | 14 |

### P2 - Fix in Early Releases

| # | Issue | Section |
|---|-------|---------|
| 11 | Implement log size caps and compression | 6 |
| 12 | Build system status dashboard in Bridge (not Prometheus-dependent) | 8 |
| 13 | Distinguish 401 from 5xx in retry logic; implement internal secret rotation | 9 |
| 14 | Implement tiered health checks (shallow + deep) | 12 |
| 15 | Default to `synchronous=FULL` for audit and vault databases | 15.2 |
| 16 | Recommend SSD; document SD card wear risks | 15.3 |
| 17 | Implement PID file / advisory lock to prevent concurrent instances | 15.5 |

### P3 - Defer

| # | Issue | Section |
|---|-------|---------|
| 18 | System clock sanity check on startup | 15.1 |
| 19 | IPv6 / dual-stack support | 15.4 |

---

## Closing Remarks

The Meridian architecture is clearly the product of careful security thinking. The dual-LLM
trust boundary, the information barrier, the sandboxed Gear model -- these are well-designed.
The OWASP coverage is thorough. The OpenClaw lessons-learned section shows genuine learning
from a real-world failure.

Where the architecture falls short is in the boring, unglamorous operational details that
determine whether a system actually stays running on someone's Raspberry Pi for months at a
time. Backup consistency, disk space management, process supervision, crash recovery across
multiple databases, SD card endurance, resource governance -- these are not exciting problems,
but they are the problems that cause 3 AM pages and data loss.

The gap is understandable -- the document is v1.2 and the project has no code yet. But these
operational concerns should be addressed in the architecture *before* implementation begins,
because retrofitting backup consistency and cross-database reconciliation into an existing
codebase is significantly harder than designing for them upfront.

The most important single recommendation: **test your backup and restore path end-to-end in
CI before shipping v1.0**. Every other problem on this list is recoverable if you have
reliable backups. Without them, a single power outage or disk failure means the user loses
their assistant's memory, their secrets vault, and their trust in the platform.
