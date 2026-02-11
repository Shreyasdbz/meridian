# Architecture Patches: DevOps/SRE Review

> **Source**: `docs/critics/devops-sre.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Crash-Consistent Backup Using SQLite Backup API

**Severity**: Critical
**Review Finding**: #4 — Backup/Restore: Not Crash-Consistent, Not Tested
**Target Section**: 8.4 (Backup and Recovery)

### Rationale

The architecture specifies daily automated backups and `PRAGMA integrity_check` after backup, but does not specify the backup *mechanism*. File-copy of SQLite databases in WAL mode can produce corrupted backups (the `.db`, `-wal`, and `-shm` files must be captured atomically). The only safe approach is the SQLite Backup API (or `VACUUM INTO`). Cross-database consistency is also unaddressed: backing up `meridian.db` at time T and `journal.db` at time T+2s produces an inconsistent backup set. The `secrets.vault` file must also be backed up atomically. The reviewer rates this P0 because without reliable backups, every other failure mode becomes unrecoverable.

### Changes

**8.4 — Replace the existing backup section with:**

```markdown
### 8.4 Backup and Recovery

#### 8.4.1 Backup Mechanism

All database backups use the **SQLite Backup API** (`better-sqlite3`'s `.backup()` method) or
`VACUUM INTO` (SQLite 3.27.0+). **File-copy of `.db` files is never used for backups** — it
cannot guarantee consistency when WAL mode is active.

| Method | Behavior | When to Use |
|--------|----------|-------------|
| `VACUUM INTO` | Creates a defragmented, compacted snapshot. Acquires a shared read lock only. | Default backup method. Produces clean, compact backups. |
| `.backup()` API | Online incremental backup. Can run concurrently with reads and writes. | Fallback if `VACUUM INTO` is unavailable (older SQLite). |
| File copy | **Unsafe with WAL mode.** Can produce corrupted backups. | Never. |

#### 8.4.2 Near-Consistent Cross-Database Snapshots

Since Meridian uses multiple SQLite databases, a backup must capture all of them as close
to the same point in time as possible. The backup procedure:

1. **Quiesce**: Axis stops dispatching new jobs. Running jobs are allowed to finish (timeout:
   30 seconds, after which they are paused — not killed — and resumed after backup).
2. **Flush**: Axis waits for any in-flight database writes to complete across all databases.
3. **Backup sequence**: Back up all databases in rapid succession:
   `meridian.db` → `journal.db` → `sentinel.db` → current `audit-YYYY-MM.db`
4. **Vault backup**: Copy `secrets.vault` using an atomic file operation (write to temp file,
   fsync, rename). The vault file is small and written infrequently, so mid-write collision
   is unlikely but the atomic copy guarantees safety.
5. **Resume**: Axis resumes job dispatching.

The total quiesce window is typically <5 seconds for a healthy system. This provides
near-consistent snapshots. Perfect consistency across databases is impossible without a
distributed transaction mechanism (overkill for this system), but the quiesce window
minimizes the inconsistency window to milliseconds.

#### 8.4.3 Backup Schedule and Rotation

- **Automated backups**: Daily, during a configurable maintenance window (default: 03:00
  local time). The window is chosen to minimize user impact, but backups can also be
  triggered manually via `meridian backup` or the Bridge UI.
- **Backup rotation**: Keep 7 daily, 4 weekly, and 3 monthly backups. Configurable.
- **Backup verification**: After each backup, run `PRAGMA integrity_check` on each backup
  file. If any backup file fails integrity check, the backup is marked as failed, the
  previous good backup is retained, and the user is notified via Bridge.
- **Backup size tracking**: Track the size of backup sets and warn if total backup storage
  exceeds a configurable threshold (default: 2 GB). On constrained devices, consider
  reducing rotation depth.

#### 8.4.4 Restore

`meridian restore <backup-path>` restores ALL databases together from a backup set:
1. The current state is preserved as a pre-restore backup.
2. All databases are replaced from the backup set.
3. Axis runs the consistency scanner (Section 8.2.1) to detect and repair cross-database
   inconsistencies.
4. FTS5 indexes are rebuilt.
5. The system restarts.

Restoring a single database in isolation is supported (`meridian restore --db journal`)
but produces a warning that cross-database inconsistencies are expected, and runs the
consistency scanner immediately.

#### 8.4.5 CI Testing of Backup/Restore

The backup and restore path is tested in CI:
1. Create databases with known test data across all databases (jobs referencing episodes,
   Sentinel decisions referencing plans, audit entries referencing jobs).
2. Run the backup procedure.
3. Modify the live databases (add/update/delete records).
4. Restore from backup.
5. Verify: all data matches the pre-backup state, cross-database references are consistent,
   FTS5 search returns correct results, Sentinel Memory queries return expected decisions.

This test runs on every release. A backup that cannot be verified through a round-trip
restore is considered a failed backup.

- **Export**: `meridian export` creates a portable archive (tar.gz) of all databases +
  workspace + config for migration to a different device.
```

---

## Patch 2: Security Advisory Notification via Existing Notification System

**Severity**: High
**Review Finding**: #2 — Update Mechanism: "No Automatic Updates" Is a Security Liability
**Target Section**: 15.3 (Release Strategy), 5.5.5 (Notification System)

### Rationale

The architecture states users learn about security patches "on next Bridge login." For an autonomous system designed to run in the background on a Pi, "next Bridge login" could be days or weeks away. The reviewer identifies that Bridge already has a notification system (in-app, browser push, webhooks) but it is not connected to the security advisory mechanism. The fix is not automatic updates (which conflicts with the privacy ethos) but connecting advisories to the existing notification infrastructure.

### Changes

**15.3 — Amend the security patches bullet:**

Current:
> **Security patches**: Released immediately with a security advisory. Users are notified on next Bridge login.

Proposed:
> **Security patches**: Released immediately with a security advisory. Users are notified through all configured notification channels (see below).

**15.3 — Add after the release strategy bullets:**

```markdown
#### 15.3.1 Security Advisory Delivery

When a critical security patch is available, Meridian must reach the user even if they are
not actively using Bridge. The advisory mechanism uses a one-way read of a public signed
advisory file — this is not telemetry.

**Advisory check mechanism:**

1. On startup (and once daily thereafter), Axis fetches a signed advisory file from a
   well-known URL (e.g., `https://advisories.meridian.dev/latest.json`). The request
   contains no identifying information — no version number, no device ID, no usage data.
   The response is a small JSON file:
   ```json
   {
     "advisories": [
       {
         "id": "MERIDIAN-2026-001",
         "severity": "critical",
         "affectedVersions": ">=0.3.0 <0.3.5",
         "fixedVersion": "0.3.5",
         "summary": "Remote code execution via crafted WebSocket message",
         "url": "https://meridian.dev/security/MERIDIAN-2026-001"
       }
     ],
     "signature": "..."
   }
   ```
2. The file is verified against Meridian's public signing key (bundled at build time).
   Unsigned or tampered advisory files are silently ignored.
3. If any advisory matches the running version, Axis triggers notifications through all
   configured channels:
   - **In-app**: Persistent banner in Bridge UI (not dismissible until the update is applied
     or the user explicitly acknowledges).
   - **Browser push**: Push notification with severity and one-line summary.
   - **Webhook**: If the user has configured webhook notifications (Section 5.5.5), the
     advisory is forwarded to their configured endpoint (Slack, Discord, email, etc.).

**User opt-out:** The daily advisory check can be disabled entirely via configuration
(`security.advisory_check = false`). When disabled, Bridge displays a permanent notice:
"Security advisory checks are disabled. Visit meridian.dev/security for manual checks."
The default is enabled.

**Distinction from telemetry:** This mechanism sends no data upstream. It is equivalent to
checking an RSS feed. The request is a plain HTTPS GET with no cookies, no headers beyond
what is necessary, and no request body. The server sees only a standard HTTP request from
an IP address — the same as any user visiting the website.

**Supplementary channels:** The project also provides:
- An RSS/Atom feed at `https://meridian.dev/security/feed.xml`
- A `security-advisories` mailing list for users who prefer email
- GitHub Security Advisories on the project repository
```

---

## Patch 3: Blessed Installation Method Per Platform

**Severity**: High
**Review Finding**: #1 — Installation Complexity: Four Methods, Four Failure Surfaces
**Target Section**: 10.2 (Installation)

### Rationale

Four installation methods (curl | sh, npm global, Docker, Docker Compose) create 24+ test matrix cells across 6+ target platforms. Without CI coverage, one or more paths will silently break on any given release. The reviewer recommends picking one blessed method per target platform, testing it in CI, and documenting the others as alternatives.

### Changes

**10.2 — Replace the existing installation section with:**

```markdown
### 10.2 Installation

Each target platform has a **recommended** installation method — the one that is tested in
CI on every release and receives first-class support. Alternative methods are documented but
are community-maintained and may lag behind.

#### 10.2.1 Recommended Installation by Platform

| Platform | Recommended Method | Why |
|----------|-------------------|-----|
| Raspberry Pi (4/5) | Install script (`curl \| sh`) | No Docker overhead on constrained RAM. Script detects ARM64 and installs the correct binary. |
| Mac Mini / macOS | Install script (`curl \| sh`) or `npm install -g` | Both work well. npm is preferred if Node.js 20+ is already installed. |
| Linux VPS | Docker Compose | Containers simplify deployment on shared hosting. Includes resource limits by default. |
| Development (any OS) | `npm install` (local, from git clone) | Full source access for development and debugging. |

#### 10.2.2 Install Script

```bash
curl -fsSL https://meridian.dev/install.sh | sh
```

The install script:
- Detects the platform (Linux ARM64, Linux x64, macOS ARM64, macOS x64).
- Downloads the correct pre-built binary for the detected platform.
- Verifies the download checksum against a signed manifest.
- Installs to `~/.meridian/bin/` (user-local, no `sudo` required).
- Installs a systemd unit file on Linux (see Section 10.6).
- Creates the initial data directory at `~/.meridian/data/`.
- Is versioned and pinned to the release tag — not a static URL that can bitrot.

Minimum prerequisites: `curl`, `sh`, and on Linux, `systemd` for service management.

#### 10.2.3 npm Global Install

```bash
npm install -g @meridian/cli
```

Requires Node.js 20.0.0 or later. To install the correct Node.js version:
```bash
# One-liner to install Node.js 20+ via nvm (if not already installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 20
```

#### 10.2.4 Docker / Docker Compose

```bash
# Docker Compose (recommended for VPS)
curl -fsSL https://meridian.dev/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

See Section 10.3 for compose file details and resource limit configuration.

#### 10.2.5 CI Installation Testing

Every release is tested against the following matrix:

| Platform | Architecture | Install Method | CI Environment |
|----------|-------------|---------------|----------------|
| Raspberry Pi OS (Debian 12) | ARM64 | Install script | GitHub Actions ARM64 runner or QEMU |
| Ubuntu 24.04 | x64 | Docker Compose | GitHub Actions |
| macOS 14+ | ARM64 | Install script | GitHub Actions macOS runner |
| macOS 14+ | ARM64 | npm global | GitHub Actions macOS runner |

Each CI job verifies: binary executes, databases initialize, health endpoint responds,
one end-to-end job completes with a mock LLM provider. If any installation path fails,
the release is blocked.
```

---

## Patch 4: Honest RAM Requirements and Docker Compose Resource Limits

**Severity**: High
**Review Finding**: #3 — Docker on Raspberry Pi: The RAM Math Does Not Work
**Target Section**: 10.1 (Target Environments), 10.3 (Container Strategy)

### Rationale

The reviewer calculates that running Docker Compose with SearXNG on a 4GB Pi leaves dangerously little free RAM after accounting for the OS, Docker daemon, Meridian, SearXNG, worker processes, and kernel overhead. The default `docker compose up` starts SearXNG even though it is marked "Optional" in comments. Users unfamiliar with Compose may not know to remove it. The fix is using Docker Compose profiles to exclude SearXNG by default and adding explicit memory limits.

### Changes

**10.1 — Amend the target environments table:**

Current:
> | Raspberry Pi 4/5 | 4-8 GB | 32+ GB SD/SSD | ARM64 | Primary target. Docker optional. |

Proposed:
> | Raspberry Pi 4/5 | 4-8 GB | 32+ GB SD/SSD (SSD strongly recommended) | ARM64 | Primary target. Native install recommended. Docker requires 8GB. |

Add a note after the table:

```markdown
**Minimum RAM by deployment mode:**

| Mode | Minimum RAM | Notes |
|------|-------------|-------|
| Native (no Docker) | 2 GB | Process-level sandboxing. Recommended for 4 GB devices. |
| Docker (Meridian only) | 4 GB | Container sandboxing without SearXNG. |
| Docker Compose (full) | 8 GB | Meridian + SearXNG + Docker overhead. |

For 4 GB Raspberry Pi 4 deployments, the native install with process-level sandboxing
(Section 5.6.3, Level 1) is recommended. Docker Compose with SearXNG is not viable on
4 GB devices.
```

**10.3 — Amend the Docker Compose file to use profiles and add resource limits:**

```yaml
services:
  meridian:
    image: meridian/meridian:latest
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - meridian-data:/data
      - meridian-workspace:/workspace
    environment:
      - MERIDIAN_MASTER_KEY_FILE=/run/secrets/master_key
    secrets:
      - master_key
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
    deploy:
      resources:
        limits:
          memory: 1536M              # Hard cap prevents OOMing the host
          cpus: '2.0'
        reservations:
          memory: 512M

  searxng:
    image: searxng/searxng:latest
    profiles:
      - search                       # Only starts with: docker compose --profile search up
    expose:
      - "8080"
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'

secrets:
  master_key:
    file: ./master_key.txt

volumes:
  meridian-data:
  meridian-workspace:
```

**10.3 — Add after the compose file:**

```markdown
**SearXNG is opt-in, not default.** SearXNG is placed behind a Docker Compose profile. To
include it, run:
```bash
docker compose --profile search up -d
```

Without the `--profile search` flag, only the Meridian container starts. This prevents
accidental resource exhaustion on constrained devices.

**Alternative search:** When SearXNG is not running, the `web-search` built-in Gear can be
configured to use an external search API (SearXNG hosted elsewhere, or a commercial API)
instead of a local instance. This is documented in the setup wizard.

**Resource limits are mandatory in the compose file.** The `deploy.resources.limits` block
prevents either container from consuming all host memory. On a 4 GB Pi, these limits should
be reduced further via an override file:

```yaml
# docker-compose.rpi4.yml (override for 4GB Pi)
services:
  meridian:
    deploy:
      resources:
        limits:
          memory: 1024M
```

```bash
docker compose -f docker-compose.yml -f docker-compose.rpi4.yml up -d
```
```

---

## Patch 5: Process Management — Systemd Unit and Instance Locking

**Severity**: High
**Review Finding**: #7 — Process Management: How Does Meridian Actually Run? + #15.5 — Concurrent Instances
**Target Section**: New Section 10.6

### Rationale

The architecture describes graceful shutdown and crash recovery but does not specify how Meridian runs as a persistent service outside Docker. On a Pi or VPS without Docker, there is no systemd unit file, no crash loop prevention, no external resource limits, and no file descriptor management. Additionally, there is no protection against accidentally starting two Meridian instances writing to the same databases.

### Changes

**Add Section 10.6 after 10.5:**

```markdown
### 10.6 Process Management

#### 10.6.1 Systemd Service (Linux)

The install script (Section 10.2.2) installs a systemd unit file at
`~/.config/systemd/user/meridian.service` (user-level) or
`/etc/systemd/system/meridian.service` (system-level, when installed with `sudo`):

```ini
[Unit]
Description=Meridian AI Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/path/to/meridian serve
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60
StartLimitBurst=5

# Resource limits
MemoryMax=75%
LimitNOFILE=65536

# Watchdog integration
WatchdogSec=30

# Security hardening
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/path/to/meridian/data
NoNewPrivileges=true
PrivateTmp=true

# OOM behavior
OOMScoreAdjust=-100

[Install]
WantedBy=default.target
```

**Key properties:**

- **`Restart=on-failure` with `StartLimitBurst=5`**: Restarts on crashes but stops after 5
  crashes within 60 seconds to prevent crash loops that burn CPU and fill logs.
- **`MemoryMax=75%`**: External hard limit on process memory. Prevents a memory leak from
  OOMing the entire host. Complements the internal memory monitoring in Section 11.2.
- **`LimitNOFILE=65536`**: Raises the file descriptor limit. The default 1024 is insufficient
  under load (5 SQLite databases + WAL/SHM files + log files + WebSocket connections + Gear
  sandbox IPC).
- **`WatchdogSec=30`**: systemd will kill and restart the process if it does not send a
  watchdog heartbeat within 30 seconds. Axis integrates with this via `sd_notify()` — it
  calls `sd_notify(0, "WATCHDOG=1")` on every event loop tick. If the event loop is blocked
  (deadlock, V8 GC pause), the external watchdog catches it. This complements the internal
  10-second event loop watchdog in Section 5.1.5 — the internal watchdog detects short
  hangs and logs them; the systemd watchdog detects fatal hangs and restarts the process.
- **`OOMScoreAdjust=-100`**: Makes Meridian less likely to be targeted by the Linux OOM
  killer compared to other processes on the system.
- **`ProtectSystem=strict` + `ReadWritePaths`**: systemd-level sandboxing of the main
  process. The filesystem is read-only except for the data directory.

#### 10.6.2 macOS (launchd)

On macOS, the install script creates a launchd plist at
`~/Library/LaunchAgents/dev.meridian.plist`. This provides automatic start on login and
restart on crash, with a throttle interval of 10 seconds.

#### 10.6.3 Instance Locking

On startup, Axis acquires an advisory lock on the data directory by creating a lock file
(`data/.lock`) and using `flock()` (Linux/macOS) to hold an exclusive lock on it.

- If the lock cannot be acquired, Axis refuses to start with a clear error:
  `"Another Meridian instance is already running on this data directory. PID: <pid>"`
- The lock file contains the current process PID for diagnostics.
- On graceful shutdown, the lock is released and the lock file is deleted.
- On crash, the `flock()` lock is automatically released by the OS. The stale lock file
  remains but `flock()` will succeed on the next startup (the OS-level lock is gone).
- This prevents the subtle database corruption that would result from two processes writing
  to the same SQLite databases concurrently.

#### 10.6.4 Startup Self-Diagnostic

Before starting the main event loop, Axis runs a diagnostic check and reports problems
clearly:

| Check | Failure Behavior |
|-------|-----------------|
| Data directory writable | Abort with error: "Data directory is not writable" |
| Port available (default: 3000) | Abort with error: "Port 3000 is in use by PID <pid>" |
| Database files readable | Abort with error identifying the corrupted database |
| Disk space > 500 MB free | Warning: "Low disk space. Some operations may fail." |
| Available RAM > 1 GB | Warning: "Low memory. Consider reducing worker count." |
| File descriptor limit > 1024 | Warning: "Low file descriptor limit. Set LimitNOFILE=65536." |
| Node.js version >= 20 | Abort with error: "Node.js 20+ required, found <version>" |

Warnings do not prevent startup but are logged and displayed in Bridge. Abort-level
failures print the error to stderr and exit with a non-zero code.
```

---

## Patch 6: Startup Reconciliation for Cross-Database Consistency

**Severity**: High
**Review Finding**: #10 — Multi-Database Consistency: The Hardest Problem Nobody Mentioned
**Target Section**: 8.2 (Database Layout) — ties into 8.2.1 if Database Engineer Patch #5 is applied

### Rationale

With four separate SQLite databases, cross-database inconsistencies are inevitable after crashes, partial failures, or single-database restores. The reviewer identifies specific failure scenarios: jobs completed but Journal reflection missing, Sentinel approval recorded but execution never started, Journal-generated Gear existing on disk but missing from the registry. The fix is a reconciliation process that runs on startup and during idle maintenance.

### Changes

**8.2 — Add subsection (or amend 8.2.1 if the Database Engineer patch is applied):**

```markdown
#### 8.2.2 Startup Reconciliation

On every startup, Axis runs a reconciliation scanner that cross-checks database state:

**Jobs → Journal consistency:**
- Jobs in `completed` status without `journalSkip: true` that have no corresponding episode
  in `journal.db` are flagged. Action: re-queue the Journal reflection for these jobs.
- Jobs in `completed` status with `journalSkip: true` that were failures (result contains
  error data) are flagged. Action: override the journal-skip and queue reflection (failures
  should always be reflected on, per Section 4.3.1).

**Jobs → Execution consistency:**
- Jobs in `executing` status at startup time were interrupted by a crash. Action: reset
  status to `pending` for retry (existing crash recovery behavior from Section 5.1.5),
  but also check for partial side effects by examining Gear execution logs in `audit.db`.
  Include side effect summary in the retry context so Scout can account for partial
  completion during replanning.
- Jobs in `validating` or `awaiting_approval` status: check `sentinel.db` for existing
  validation results. If a validation exists, advance the job status accordingly rather
  than re-validating (saves a Sentinel LLM call).

**Gear registry → Filesystem consistency:**
- Gear entries in `meridian.db` with `origin: "journal"` that have no corresponding files
  in `workspace/gear/`: remove the registry entry and log a warning.
- Gear directories in `workspace/gear/` that have no corresponding entry in `meridian.db`:
  flag as orphaned. Notify the user via Bridge — they may be draft Gear from a crashed
  Synthesizer run.

**Sentinel decisions → Expiry:**
- Delete expired decisions from `sentinel.db` (decisions where `expires_at < now()`).

**Audit integrity:**
- Audit entries with status `pending` (from the write-ahead audit pattern) that were never
  updated to `completed`: mark as `incomplete` and log a warning.

**Reconciliation behavior:**

- Runs automatically on every startup. Typically completes in <1 second.
- Also runs during idle maintenance windows (once per hour) to catch drift from non-crash
  scenarios.
- All reconciliation actions are logged to the audit trail.
- Corrective actions are automatic for safe operations (re-queueing reflections, cleaning
  expired decisions). Destructive or ambiguous corrections (deleting orphaned Gear, purging
  orphaned episodes) are flagged for user review in Bridge.
```

---

## Patch 7: Workspace Cleanup Policies and Disk Space Management

**Severity**: High
**Review Finding**: #11 — Disk Space Management: Unbounded Growth Everywhere
**Target Section**: 8.2 (Database Layout), 11.2 (Resource Management)

### Rationale

The workspace directories (`downloads/`, `temp/`, `gear/`) have no cleanup policies and will grow without bound. Draft Gear from Journal accumulates if the user never reviews it. Backup storage grows with each backup set. The reviewer calculates that on a 32GB SD card, backups alone could consume 10% of storage. The existing disk monitoring (alert at 80%, pause at 90%) is reactive, not proactive.

### Changes

**8.2 — Add subsection after the workspace directory layout:**

```markdown
#### 8.2.3 Workspace Retention Policies

Each workspace subdirectory has a retention policy enforced by Axis during idle
maintenance:

| Directory | Retention Policy | Rationale |
|-----------|-----------------|-----------|
| `workspace/temp/` | Delete files older than 24 hours | Temp files from crashed or completed Gear executions. No long-term value. |
| `workspace/downloads/` | Delete files older than 7 days unless referenced by a memory entry or active Gear | Gear downloads accumulate quickly. Files explicitly saved by the user to `workspace/projects/` are not affected. |
| `workspace/gear/` (drafts) | Notify user after 30 days of unreviewed drafts. Auto-archive (move to `workspace/gear/.archived/`) after 90 days. | Prevents unbounded growth from Journal Synthesizer output the user never reviews. |
| `workspace/gear/.archived/` | Delete after 180 days | Final cleanup of long-ignored drafts. |

**Cleanup runs during idle maintenance windows** — Axis does not delete files while jobs
are running. Before deleting any file, Axis checks that no active job references it.

**User override:** Users can mark specific files as "pinned" through Bridge, exempting them
from automatic cleanup. Pinned files are retained indefinitely until manually unpinned.
```

**11.2 — Add under "General Performance Guidelines" or as a new subsection:**

```markdown
#### 11.2.1 Proactive Disk Space Management

Rather than relying solely on reactive alerts (80% / 90% thresholds), Meridian tracks disk
usage per data category and provides visibility in Bridge:

**Disk usage breakdown (visible in Bridge status dashboard):**

| Category | What It Includes | Monitoring |
|----------|-----------------|------------|
| Databases | meridian.db, journal.db, sentinel.db, audit-*.db | Size per database, free page ratio |
| Backups | data/backups/ | Total size, count, oldest backup age |
| Workspace | downloads/, gear/, projects/, temp/ | Size per subdirectory |
| Logs | data/logs/ | Total size, rotation status |

**Space reclamation triggers:**

- When free disk drops below 20%: Axis runs immediate cleanup of `temp/` and expired
  `downloads/` without waiting for the idle maintenance window.
- When free disk drops below 10%: Axis pauses all non-critical operations (scheduled jobs,
  Journal reflection) and sends an urgent notification via all channels.
- When any single database's free page ratio exceeds 30%: Axis schedules an incremental
  vacuum during the next idle window.

**`meridian cleanup` command:**

```bash
meridian cleanup              # Show what can be cleaned and estimated space savings
meridian cleanup --apply      # Apply cleanup after confirmation
meridian cleanup --apply -y   # Apply without confirmation (for automation)
```

Displays a breakdown of reclaimable space by category (temp files, expired downloads,
archived drafts, database free pages, old backups, rotated logs) and asks for confirmation
before proceeding.
```

---

## Patch 8: Migration Transactional Safety and Full-Chain CI Testing

**Severity**: High
**Review Finding**: #5 — Migration Strategy: Forward-Only With No Tested Rollback
**Target Section**: 8.5 (Migration Strategy)

### Rationale

The architecture does not specify that migrations run inside transactions. If a migration has 4 SQL statements and the third fails, the database can be left in a partially migrated state that neither the old nor the new binary can handle. SQLite supports transactional DDL, so wrapping each migration in a transaction is free and essential. The reviewer also identifies that "tested against all previous schema versions" needs to include full-chain testing (version 1 → latest in a single run), not just individual migration tests.

### Changes

**8.5 — Add explicit transactional wrapping and testing requirements:**

Amend the migration description (or amend the Database Engineer's Patch #9 if applied) to include:

```markdown
**Transactional safety:** Each migration executes inside a single SQLite transaction. If any
statement within the migration fails, the entire migration is rolled back and the
`schema_version` table is unchanged. The database remains at the previous version in a
consistent state. Axis logs the error and aborts startup with a clear message:
`"Migration <version> failed for <database>: <error>. Database remains at version <current>."`

```sql
-- Pseudocode for migration execution
BEGIN;
-- Execute all statements in the migration file
INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?);
COMMIT;
-- If any statement fails, ROLLBACK is issued automatically
```

**Pre-migration backup ordering (explicit):**

The update sequence is:
1. Install new binary (or pull new Docker image).
2. On first startup, before any migration runs, Axis backs up ALL databases using the
   backup mechanism from Section 8.4. This is a pre-migration backup — the databases are
   in the old schema state.
3. Axis applies pending migrations for each database.
4. If any migration fails, Axis aborts startup. The user can restore from the pre-migration
   backup and revert to the old binary.

**CI migration testing:**

Two types of migration tests run in CI:

1. **Individual migration tests**: Each migration is tested against its starting schema
   version. Verify that the migration applies cleanly and the resulting schema matches
   expectations.
2. **Full-chain migration tests**: Starting from the v1 schema (first release), apply ALL
   migrations sequentially in a single run to reach the current version. This catches
   migration ordering issues, conflicting column names across migrations, and assumptions
   about prior schema state.

Both test types run on every PR that modifies a migration file and on every release build.

**`meridian db check` command:** Validates the database schema matches the expected version
for the running binary without modifying anything. Outputs the current schema version for
each database and whether migrations are pending:

```bash
$ meridian db check
meridian.db:  version 12 (current)
journal.db:   version 8  (current)
sentinel.db:  version 3  (current)
audit template: version 2  (current)
All databases up to date.
```
```

---

## Patch 9: Log Management — Size Caps and Compression

**Severity**: Medium
**Review Finding**: #6 — Log Management: JSON Logs on Constrained Storage
**Target Section**: 12.1 (Logging Strategy)

### Rationale

At debug level with heavy usage, log volume can reach 10-50 MB/day. On a 32GB SD card with 7 days of retention, this consumes meaningful storage. The architecture mentions time-based rotation but not size-based limits. Compressing rotated logs (JSON compresses ~10:1) would significantly reduce storage impact.

### Changes

**12.1 — Amend the log file bullet:**

Current:
> 2. **File**: `data/logs/meridian.log` with daily rotation (configurable, default: 7 days retained).

Proposed:
> 2. **File**: `data/logs/meridian.log` with dual rotation:
>    - **Time-based**: Daily rotation. Rotated files are retained for 7 days (configurable).
>    - **Size-based**: Maximum total log storage of 100 MB (configurable). When exceeded, the
>      oldest rotated files are deleted regardless of age.
>    - **Compression**: Rotated log files are compressed with gzip (`.log.gz`). JSON structured
>      logs compress at approximately 10:1, reducing 7 days of info-level logs from ~4 MB to
>      ~400 KB, and 7 days of debug-level logs from ~350 MB to ~35 MB.

**12.1 — Add after the severity level table:**

```markdown
**Default log level:** `info`. The `debug` level is opt-in and should be used only for
active troubleshooting. Bridge displays a warning when debug logging is enabled:
"Debug logging is active. Log storage usage will increase significantly."

**Log export:** `meridian logs --export` bundles the last 7 days of logs (compressed),
recent audit entries (action types only, no user content), and system information (OS,
Node.js version, Meridian version, uptime, database sizes, disk/memory usage) into a single
`.tar.gz` file. Sensitive data (API keys, user message content, secrets) is automatically
redacted. This bundle is suitable for attaching to GitHub issues.
```

---

## Patch 10: Built-In System Status Dashboard in Bridge

**Severity**: Medium
**Review Finding**: #8 — Monitoring: Prometheus on a Pi Is Enterprise Cosplay
**Target Section**: 12.2 (Metrics), 5.5.1 (Bridge Responsibilities)

### Rationale

Prometheus metrics are useful for power users with an existing monitoring stack, but 90% of Meridian's target audience will not run Prometheus and Grafana on their Pi. Without a built-in dashboard, these users have no operational visibility beyond the health endpoint. The fix is a lightweight status dashboard built directly into Bridge.

### Changes

**12.2 — Add before the Prometheus metrics:**

```markdown
#### 12.2.1 Built-In Status Dashboard

Bridge includes a system status dashboard accessible at `/status` (or via the Bridge UI
sidebar). This dashboard provides operational visibility without external monitoring tools:

**System Health:**
- CPU usage (current, 1-hour trend)
- Memory usage (current, 1-hour trend, with breakdown: Node.js heap, SQLite cache, OS)
- Disk usage (total, per-category breakdown from Section 11.2.1)
- System uptime and Meridian uptime

**Component Status:**
- Each component's health status with last-known-good timestamp
- Scout: last successful API call, model in use, average response latency
- Sentinel: last successful validation, approval/rejection ratio (last 24h)
- Journal: memory count by type, last reflection time, last Gear synthesis
- Gear: enabled count, last execution time, circuit breaker status per Gear

**Job Metrics:**
- Queue depth (current)
- Jobs completed / failed / cancelled (last 24h, 7d, 30d)
- Average job duration (last 24h)
- Currently running jobs with progress

**Cost Tracking:**
- LLM API spend today / this week / this month
- Token usage breakdown by provider and model
- Remaining daily budget
- Estimated monthly cost at current usage rate

**Recent Errors:**
- Last 20 errors with timestamps, error codes, and affected jobs
- Recurring error detection: "This error has occurred 5 times in the last hour"

The dashboard data is served via a `/api/status` endpoint (distinct from `/api/health`)
that returns detailed system metrics in JSON. The dashboard auto-refreshes every 30 seconds
via the existing WebSocket connection.
```

**12.2 — Amend the Prometheus section:**

```markdown
#### 12.2.2 Prometheus Metrics (Opt-In)

For users with an existing Prometheus + Grafana monitoring stack, Axis exposes metrics via
a `/api/metrics` endpoint in Prometheus format. **This is opt-in** — disabled by default.
Enable with `observability.prometheus = true` in configuration.
```

(Keep existing Prometheus metric list unchanged.)

**5.5.1 — Add to Bridge responsibilities:**

```markdown
- Provide a built-in system status dashboard with real-time operational metrics (Section 12.2.1)
```

---

## Patch 11: Error Classification in Retry Logic and Internal Secret Rotation

**Severity**: Medium
**Review Finding**: #9 — Secret Rotation: Reminder Without Enforcement Is a Post-It Note
**Target Section**: 4.4 (Graceful Degradation), 6.4 (Secrets Management)

### Rationale

The retry logic for LLM API failures does not distinguish between "server is down" (retriable) and "your credentials are invalid" (non-retriable). Retrying a 401 with the same expired API key wastes time while jobs pile up. Additionally, internal secrets (HMAC signing key, session signing key) generated at install time are never rotated, meaning a compromise at any point allows permanent message forgery.

### Changes

**4.4 — Amend the graceful degradation table to add error classification:**

Add a new row:
> | LLM API returns 401/403 (authentication failure) | Stop retrying immediately. Mark the affected provider as "credential error." Pause all jobs using that provider. Notify user via Bridge with specific guidance: "Your [provider] API key is invalid or expired. Update it in Settings > Secrets." Resume automatically when the user updates the credential. |

**4.4 — Add after the graceful degradation table:**

```markdown
**Error classification for retry logic:** Axis classifies external API errors into
retriable and non-retriable categories:

| Category | HTTP Status Codes | Behavior |
|----------|------------------|----------|
| Retriable (transient) | 429, 500, 502, 503, 504, network timeout | Retry with exponential backoff (30s, 1m, 5m, 15m). Notify user after first failure. |
| Non-retriable (credential) | 401, 403 | Stop immediately. Notify user. Pause dependent jobs. |
| Non-retriable (client error) | 400, 404, 422 | Do not retry. Log error. Report to Scout for replanning or to user for correction. |
| Non-retriable (quota) | 402 (payment required), provider-specific quota errors | Stop immediately. Notify user of billing/quota issue. |

This classification applies to all external API calls: LLM providers, embedding APIs, and
any external services called by Gear.
```

**6.4 — Add after the existing secrets management section:**

```markdown
#### 6.4.2 Internal Secret Rotation

Secrets generated by Meridian itself (as opposed to user-provided API keys) are rotated
automatically:

| Secret | Rotation Cadence | Rollover |
|--------|-----------------|----------|
| HMAC signing key (component messages) | Every 30 days | Accept both old and new key for 24 hours after rotation, then old key is discarded. |
| Session signing key (Bridge cookies) | Every 30 days | Existing sessions remain valid until their natural expiry. New sessions use the new key. |
| Backup encryption key (if applicable) | On master password change | Old backups remain readable with the old key (stored in key history). |

Rotation happens automatically during idle maintenance. No user action required. Rotation
events are logged to the audit trail.

**External API key health checks:** Meridian provides a `meridian secrets check` command
that tests all stored credentials by making a lightweight, non-destructive API call to each
provider (e.g., listing models, checking account status). Reports which credentials are
valid, expired, or rate-limited:

```bash
$ meridian secrets check
anthropic-api-key:  valid (last used 2h ago)
openai-api-key:     EXPIRED (401 Unauthorized)
searxng-url:        valid (200 OK)
```
```

---

## Patch 12: Tiered Health Checks

**Severity**: Medium
**Review Finding**: #12 — Health Check Depth: Looks Healthy, Is Not
**Target Section**: 12.3 (Health Checks)

### Rationale

The current health endpoint reports component status but "healthy" for Scout and Sentinel may mean only that the component is loaded, not that its LLM provider is reachable or its API key is valid. The health check also omits system-level metrics (disk, memory, backup recency). The reviewer recommends tiered health checks: a fast shallow check for automated monitoring and a deep check for diagnostics.

### Changes

**12.3 — Replace the existing health check section with:**

```markdown
### 12.3 Health Checks

#### Shallow Health Check (default)

```
GET /api/health
```

Fast (<100ms), no external calls. Suitable for Docker health checks, systemd watchdog,
and load balancer probes.

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": 86400,
  "system": {
    "memory_used_percent": 62,
    "disk_free_percent": 45,
    "disk_free_bytes": 14500000000
  },
  "components": {
    "axis": { "status": "healthy", "queue_depth": 3 },
    "scout": {
      "status": "healthy",
      "provider": "anthropic",
      "last_successful_call_at": "2026-02-08T14:32:00Z"
    },
    "sentinel": {
      "status": "healthy",
      "provider": "openai",
      "last_successful_call_at": "2026-02-08T14:30:00Z"
    },
    "journal": { "status": "healthy", "memory_count": 1234 },
    "bridge": { "status": "healthy", "active_sessions": 1 }
  },
  "last_backup_at": "2026-02-08T03:00:00Z"
}
```

The shallow check verifies:
- Process is alive and event loop is responsive.
- All databases are openable (implicit from `queue_depth` and `memory_count` queries).
- Disk has >10% free space (degrades to "warning" below 20%, "critical" below 10%).
- Memory usage is not critical (degrades to "warning" above 85%).
- `last_successful_call_at` for Scout and Sentinel is stale-aware: if the last successful
  call was more than 1 hour ago, the component status degrades to "unknown" (not "healthy").

#### Deep Health Check (on-demand)

```
GET /api/health?deep=true
```

Takes 5-30 seconds. Performs active checks against external dependencies. Not for automated
polling — use for diagnostics when something seems wrong.

```json
{
  "...shallow fields...",
  "deep": {
    "scout_api_reachable": true,
    "scout_api_latency_ms": 450,
    "sentinel_api_reachable": true,
    "sentinel_api_latency_ms": 380,
    "database_integrity": {
      "meridian.db": "ok",
      "journal.db": "ok",
      "sentinel.db": "ok"
    },
    "sandbox_creation": "ok",
    "backup_recency_hours": 11,
    "tls_certificate_expires_in_days": 45
  }
}
```

The deep check additionally:
- Makes a lightweight API call to each configured LLM provider (list models, not a
  generation — no cost incurred).
- Runs `PRAGMA integrity_check` on each database.
- Attempts to create and destroy a sandbox process/container to verify sandbox readiness.
- Checks backup recency (warns if last backup was >24h ago).
- Checks TLS certificate expiry (if remote access is configured).
```

---

## Patch 13: CLI Diagnostics, Debug Bundle, and Structured Error Codes

**Severity**: Medium
**Review Finding**: #13 — Incident Response: No Debug Bundle, No Diagnostics
**Target Section**: 12.4 (Debugging Tools) — expand significantly

### Rationale

When the Bridge UI is broken or inaccessible (the most common scenario when things go seriously wrong), the user has no diagnostic tools beyond reading raw logs and database files. The reviewer recommends a CLI diagnostic tool, a debug bundle generator, and structured error codes — none of which require Bridge to be functional.

### Changes

**12.4 — Expand the debugging tools section:**

```markdown
### 12.4 Debugging Tools

#### 12.4.1 In-Bridge Debugging (when Bridge is functional)

- **Job inspector**: Full job details — original message, Scout's plan, Sentinel's
  validation, execution logs, final result.
- **Replay mode**: Re-run a completed job with the same inputs for debugging.
- **Dry run**: Submit a message with `?dry_run=true` to see the plan without executing it.
- **Sentinel explain**: View Sentinel's full reasoning for any approval or rejection.

#### 12.4.2 CLI Diagnostics (when Bridge is NOT functional)

**`meridian doctor`** runs a comprehensive diagnostic check that does not require Bridge
to be running. It checks:

| Check | What It Verifies |
|-------|-----------------|
| Node.js version | >= 20.0.0 |
| Database integrity | `PRAGMA integrity_check` on all databases |
| Database schema versions | Match expected versions for this binary |
| Disk space | Available space on the data directory |
| Memory | Available system RAM |
| Port availability | Default port (3000) is not in use |
| Config validity | Configuration file parses correctly, required fields present |
| Secret vault | Vault file is readable and decryptable |
| LLM API connectivity | Can reach configured providers (optional, `--check-apis`) |
| Docker availability | Docker daemon running (if container sandboxing configured) |
| Lock file | Check for stale lock files from crashed instances |

Output is both human-readable (terminal) and machine-readable (`--json`):

```bash
$ meridian doctor
Meridian Doctor v0.3.0

[PASS] Node.js version: 20.11.0
[PASS] meridian.db: integrity ok, schema version 12
[PASS] journal.db: integrity ok, schema version 8
[FAIL] sentinel.db: integrity check failed - database disk image is malformed
[PASS] Disk space: 14.5 GB free (45%)
[PASS] Memory: 3.2 GB available
[PASS] Port 3000: available
[PASS] Configuration: valid
[PASS] Secret vault: readable
[SKIP] LLM API connectivity: use --check-apis to test
[SKIP] Docker: not configured

1 issue found:
  sentinel.db is corrupted. Run 'meridian restore --db sentinel' to restore from backup.
```

#### 12.4.3 Debug Bundle

**`meridian debug-bundle`** creates a sanitized diagnostic archive for sharing with
maintainers or attaching to GitHub issues:

```bash
$ meridian debug-bundle
Creating debug bundle...
  Including: last 1000 log lines (sanitized)
  Including: system information
  Including: database schema versions
  Including: configuration (secrets redacted)
  Including: error counts by type (last 7 days)
  Including: disk and memory usage
  Including: uptime and version info
  Including: last 100 audit entries (action types only)
  Excluding: user message content
  Excluding: API keys and secrets
  Excluding: memory content
  Excluding: full audit details

Bundle saved to: meridian-debug-2026-02-08T14-30-00.tar.gz (245 KB)
```

The bundle contains no user-private content — only structural/operational data needed for
debugging. Users should still review the contents before sharing.

#### 12.4.4 Structured Error Codes

Every error class in Meridian has a unique, searchable error code. Error codes follow the
pattern `<COMPONENT>_<CATEGORY>_<SPECIFIC>`:

| Code | Meaning |
|------|---------|
| `AXIS_DB_OPEN_FAILED` | Cannot open a database file |
| `AXIS_DB_MIGRATION_FAILED` | A database migration failed |
| `AXIS_LOCK_CONFLICT` | Another instance is running |
| `SCOUT_API_TIMEOUT` | LLM provider did not respond within timeout |
| `SCOUT_API_AUTH_FAILED` | LLM provider returned 401/403 |
| `SCOUT_PLAN_MALFORMED` | Scout produced invalid JSON |
| `SENTINEL_API_UNREACHABLE` | Cannot reach Sentinel's LLM provider |
| `SENTINEL_REJECTED` | Sentinel rejected the plan |
| `GEAR_SANDBOX_CREATE_FAILED` | Cannot create sandbox process/container |
| `GEAR_TIMEOUT` | Gear execution exceeded timeout |
| `GEAR_PERMISSION_DENIED` | Gear attempted an undeclared action |
| `BRIDGE_PORT_IN_USE` | Bridge port is already in use |
| `BRIDGE_AUTH_LOCKOUT` | Too many failed login attempts |

Error codes are:
- Displayed in the Bridge UI alongside human-readable error messages.
- Included in log entries.
- Linked to a documentation page: `https://meridian.dev/errors/<ERROR_CODE>`
- Searchable in GitHub Issues for known problems and solutions.

The error code documentation is auto-generated from the error class definitions in the
codebase, ensuring it stays in sync.
```

---

## Patch 14: External Process Resource Governance

**Severity**: Medium
**Review Finding**: #14 — Main Process Resource Governance + #7 (partial)
**Target Section**: 11.2 (Resource Management on Constrained Devices)

### Rationale

The architecture has thorough internal resource monitoring (Axis pauses jobs when RAM drops below 512 MB, alerts on disk usage) but no external hard limits on the Node.js process itself. If the Node.js process has a memory leak, internal monitoring cannot help — the process needs external limits. The architecture also does not address swap configuration, which is critical on Pi with SD cards.

### Changes

**11.2 — Add new subsection before "General Performance Guidelines":**

```markdown
#### 11.2.0 External Resource Limits

Internal monitoring (Axis pausing jobs at low RAM) is a reactive control. External limits
are the safety net that prevents the Meridian process itself from destabilizing the host:

**Node.js heap size:**

The `meridian serve` command sets `--max-old-space-size` based on detected system RAM:

| System RAM | `--max-old-space-size` | Rationale |
|-----------|----------------------|-----------|
| <= 2 GB | 512 MB | Leave room for OS and Gear sandboxes |
| 4 GB | 1024 MB | Comfortable for typical workloads |
| 8+ GB | 2048 MB | Generous headroom |

This is a hard limit — V8 will trigger garbage collection or throw `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed` rather than growing beyond this size. The limit is
configurable via `MERIDIAN_MAX_HEAP_MB` environment variable.

**Swap recommendations:**

Swap configuration significantly affects behavior on constrained devices:

| Storage | Recommendation | Rationale |
|---------|---------------|-----------|
| SSD | 2 GB swap file | Swap on SSD is fast enough to be useful for occasional pressure. |
| SD card | Swap off (`swapoff -a`) | SD card random writes are 5-50x slower than SSD. Swap thrashing destroys SD card lifespan and makes the system unusable. Accept OOM kills over SD card destruction. |
| zram | 1 GB zram (compressed in-memory swap) | Good middle ground. Trades CPU for memory. Recommended for Pi deployments without SSD. |

The setup wizard detects the storage type for the data directory and provides a swap
recommendation. Meridian does not modify swap configuration — it only advises.

**File descriptor limits:**

Meridian's file descriptor usage under load:

| Consumer | Estimated FDs |
|----------|--------------|
| SQLite databases (4 DBs x 3 files each: .db, -wal, -shm) | 12 |
| SQLite read + write connections | 8 |
| Log files | 2 |
| WebSocket connections (Bridge) | 1-10 |
| HTTP server (Fastify) | 1-20 |
| Gear sandbox IPC | 2-8 per active worker |
| Event bus / timers | 5-10 |
| **Total typical** | **~40-70** |

The default `ulimit -n 1024` is sufficient for typical use but can be exceeded under heavy
load with many concurrent WebSocket clients. The systemd unit file (Section 10.6) sets
`LimitNOFILE=65536` as a comfortable ceiling.
```

---

## Patch 15: Power Loss Safety and SD Card Durability

**Severity**: Medium
**Review Finding**: #15.2 — Power Loss on Raspberry Pi + #15.3 — SD Card Wear
**Target Section**: 11.2 (Resource Management on Constrained Devices)

### Rationale

Raspberry Pis get unplugged. SD cards lack power-loss protection and proper write barriers. SQLite in WAL mode with `synchronous=NORMAL` protects against application crashes but not against hardware power loss on storage without write barriers. The reviewer recommends `synchronous=FULL` for critical databases. Additionally, always-on SQLite writes (every job, reflection, audit entry) cause significant write amplification on SD cards, reducing their lifespan.

### Changes

**11.2 — Under "Raspberry Pi Optimizations," add:**

```markdown
- **Power loss protection**: SD cards typically lack hardware write barriers. A power loss
  during a write can corrupt the database even with WAL mode. Meridian uses different
  `synchronous` settings based on data criticality:

  | Database | `synchronous` | Rationale |
  |----------|---------------|-----------|
  | `audit.db` | `FULL` | Audit integrity is critical. `FULL` issues explicit `fsync` on every commit, providing the strongest guarantee against power-loss corruption. |
  | `secrets.vault` | N/A (not SQLite) | Vault writes use explicit `fsync` + atomic rename. |
  | `meridian.db` | `NORMAL` | Some data loss is tolerable (jobs can be re-queued). |
  | `journal.db` | `NORMAL` | Memory loss is tolerable (can be re-reflected). |
  | `sentinel.db` | `NORMAL` | Decisions can be re-derived from user interaction. |

  When Meridian detects it is running on removable storage (SD card), it logs a warning:
  "Data directory is on removable storage. SSD is strongly recommended for data integrity
  and performance. See: meridian.dev/docs/storage"

- **SD card write endurance**: Always-on SQLite with WAL generates significant write volume.
  Estimated write volume for typical usage:

  | Operation | Estimated Writes/Day | Notes |
  |-----------|---------------------|-------|
  | Job lifecycle (100 jobs/day) | ~10 MB | Status updates, plan storage, results |
  | Journal reflection | ~5 MB | Episode creation, fact extraction |
  | Audit logging | ~2 MB | One entry per significant action |
  | WAL checkpoints | ~20 MB | Periodic compaction of WAL files |
  | **Total** | **~37 MB/day** | |

  At ~37 MB/day, a typical SD card (10,000 write cycles per cell, 32 GB) has an estimated
  lifespan of approximately 2-3 years of continuous operation. An SSD extends this to 10+
  years.

  **Storage recommendation:** The setup wizard and documentation strongly recommend:
  - SSD connected via USB 3.0 for the data directory (`data/`)
  - SD card for the OS only (low write volume)
  - Instructions for moving `data/` to an external SSD are provided in the setup wizard
    and documentation.

  **Monitoring:** Axis tracks estimated cumulative write volume to the data directory (from
  database operation counts) and surfaces it in the status dashboard. If estimated write
  volume on removable storage exceeds 50 MB/day sustained, a warning is displayed.
```

---

## Patch 16: Miscellaneous Operational Items

**Severity**: Low
**Review Finding**: #15.1 — Time Synchronization + #15.4 — IPv6

### Patch 16a: System Clock Sanity Check

**Target Section**: 10.6.4 (Startup Self-Diagnostic, from Patch 5)

**Add to the startup diagnostic table:**

> | System clock plausible | If system year < 2026, warn: "System clock appears incorrect. Scheduled jobs and UUID generation depend on accurate time. Ensure NTP is configured." Do not abort — the user may be intentionally using a non-synchronized clock. |

```markdown
**Time dependency note:** Meridian depends on accurate system time for:
- UUID v7 generation (time-sortable IDs)
- Cron-based job scheduling (Section 5.1.4)
- Cache expiry (24-hour TTL)
- Sentinel decision expiry
- Backup scheduling

On Raspberry Pi without a hardware real-time clock, the system clock may be wildly wrong
after a boot without network access (until NTP syncs). Meridian defers scheduled job
execution until the clock is plausible (year >= 2026 and time has advanced since last
known timestamp in the database). Immediate and event-driven jobs execute regardless of
clock state.
```

### Patch 16b: IPv6 / Dual-Stack Support

**Target Section**: 10.4 (Configuration)

**Amend the Bridge configuration example:**

Current:
```toml
[bridge]
bind = "127.0.0.1"
port = 3000
```

Proposed:
```toml
[bridge]
bind = "127.0.0.1"           # Default: IPv4 loopback only
# bind = "::1"               # IPv6 loopback only
# bind = "localhost"          # Dual-stack (both IPv4 and IPv6 loopback, OS-dependent)
port = 3000
```

Add a note:
```markdown
**IPv6 support:** By default, Bridge binds to `127.0.0.1` (IPv4 only). On IPv6-only or
dual-stack systems, set `bind = "::1"` for IPv6 loopback or `bind = "localhost"` for
OS-resolved dual-stack binding. When remote access is enabled with TLS, the same options
apply to the remote bind address. Document the behavior clearly: `0.0.0.0` binds all IPv4
interfaces, `::` binds all IPv6 interfaces (and often IPv4 via dual-stack).
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Crash-consistent backup using SQLite Backup API | Critical | 8.4 |
| 2 | Security advisory notification via existing notification system | High | 15.3, 5.5.5 |
| 3 | Blessed installation method per platform + CI matrix | High | 10.2 |
| 4 | Honest RAM requirements + Docker compose resource limits | High | 10.1, 10.3 |
| 5 | Process management: systemd unit + PID lock + startup diagnostic | High | New 10.6 |
| 6 | Startup reconciliation for cross-database consistency | High | 8.2 (new 8.2.2) |
| 7 | Workspace cleanup policies + disk space management | High | 8.2, 11.2 |
| 8 | Migration transactional safety + full-chain CI testing | High | 8.5 |
| 9 | Log management: size caps + compression + export | Medium | 12.1 |
| 10 | Built-in system status dashboard in Bridge | Medium | 12.2, 5.5.1 |
| 11 | Error classification in retry logic + internal secret rotation | Medium | 4.4, 6.4 |
| 12 | Tiered health checks (shallow + deep) | Medium | 12.3 |
| 13 | CLI diagnostics + debug bundle + structured error codes | Medium | 12.4 |
| 14 | External process resource governance (heap, swap, fd limits) | Medium | 11.2 |
| 15 | Power loss safety + SD card durability defaults | Medium | 11.2 |
| 16 | Miscellaneous: time sync, IPv6 / dual-stack | Low | 10.6, 10.4 |

### Cross-References with Other Patches

Several patches from this review interact with patches from other critic reviews:

| This Patch | Other Patch | Interaction |
|-----------|-------------|-------------|
| #1 (backup consistency) | DB Engineer #13 (backup consistency) | **Overlapping.** Both address the same problem. This patch adds CI testing of backup/restore and vault backup specifics. DB engineer patch adds `VACUUM INTO` as the mechanism. Apply both — they are complementary, not conflicting. |
| #6 (startup reconciliation) | DB Engineer #5 (cross-database consistency) | **Overlapping.** DB engineer patch adds the write-ahead audit pattern and periodic consistency checks. This patch adds startup-specific reconciliation covering job/Journal/Gear/Sentinel cross-references. Apply both — DB engineer covers the consistency model, this patch covers the startup scanner. |
| #7 (disk space) | DB Engineer #11 (VACUUM strategy) | **Complementary.** DB engineer patch specifies incremental vacuum mechanics. This patch adds workspace cleanup policies and the `meridian cleanup` command. Apply both. |
| #8 (migration safety) | DB Engineer #9 (per-database migrations) | **Overlapping.** DB engineer patch specifies per-database migration directories and `VACUUM INTO` backups. This patch adds transactional wrapping and full-chain CI testing. Apply both — they address different aspects of migration safety. |
| #12 (tiered health checks) | AI Tooling Engineer #4 (reliability) | **Compatible.** The reliability section's output validation and completion verification complement the deep health check's active probing. No conflict. |
| #14 (resource governance) | DB Engineer #12 (connection management) | **Complementary.** DB engineer patch covers SQLite-specific concerns (worker threads, read/write connections). This patch covers OS-level resource limits (heap size, swap, fd limits). Apply both. |
| #15 (power loss) | DB Engineer #10 (WAL on SD cards) | **Overlapping.** DB engineer patch covers WAL checkpoint tuning. This patch adds `synchronous=FULL` for audit, write volume estimation, and SSD recommendations. Apply both — they address different angles of the SD card problem. |
