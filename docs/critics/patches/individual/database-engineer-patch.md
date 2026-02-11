# Architecture Patches: Database Engineer Review

> **Source**: `docs/critics/database-engineer.md`
> **Target**: `docs/architecture.md` (v1.2)
> **Date**: 2026-02-08

Each patch below identifies a specific section to modify, the rationale from the review, and the proposed text changes. Patches are ordered by severity (Critical > High > Medium > Low) then by section number.

---

## Patch 1: Add FTS5 Content-Sync Triggers

**Severity**: Critical
**Review Finding**: #2 — FTS5 Content-Sync Tables Will Desync
**Target Section**: 8.3 (Schema Overview — Journal Database)

### Rationale

The schema defines external content FTS5 tables (`content=facts`, `content=procedures`, `content=episodes`) but does not include the mandatory triggers to keep FTS indexes in sync with their content tables. External content FTS5 tables do NOT automatically update when the underlying table changes. Without explicit AFTER INSERT, AFTER UPDATE, and AFTER DELETE triggers, the FTS index silently drifts — returning stale results, missing new data, or pointing to wrong rows. This is silent data corruption with no error or warning. The fix is trivial: add triggers and a periodic rebuild safety net.

### Changes

**8.3 — Journal Database schema, add triggers after the FTS5 table definitions:**

Replace:
```sql
-- Full-text search
CREATE VIRTUAL TABLE facts_fts USING fts5(content, content=facts, content_rowid=rowid);
CREATE VIRTUAL TABLE procedures_fts USING fts5(content, content=procedures, content_rowid=rowid);
CREATE VIRTUAL TABLE episodes_fts USING fts5(content, content=episodes, content_rowid=rowid);
```

With:
```sql
-- Full-text search (external content FTS5 — requires explicit sync triggers)
CREATE VIRTUAL TABLE facts_fts USING fts5(content, content=facts, content_rowid=rowid);
CREATE VIRTUAL TABLE procedures_fts USING fts5(content, content=procedures, content_rowid=rowid);
CREATE VIRTUAL TABLE episodes_fts USING fts5(content, content=episodes, content_rowid=rowid);

-- FTS5 sync triggers for facts
-- External content FTS5 tables do NOT auto-update. These triggers are mandatory.
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO facts_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- FTS5 sync triggers for procedures
CREATE TRIGGER procedures_ai AFTER INSERT ON procedures BEGIN
  INSERT INTO procedures_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER procedures_ad AFTER DELETE ON procedures BEGIN
  INSERT INTO procedures_fts(procedures_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER procedures_au AFTER UPDATE ON procedures BEGIN
  INSERT INTO procedures_fts(procedures_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO procedures_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- FTS5 sync triggers for episodes
CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO episodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

**8.3 — After the Journal schema, add a maintenance note:**

```markdown
**FTS5 maintenance:** As a safety net against any missed synchronization, the Journal component
runs `INSERT INTO <table>_fts(<table>_fts) VALUES('rebuild')` for each FTS table during idle
maintenance windows (Section 11.2). This rebuilds the index from scratch using the content
table. The rebuild is also triggered automatically on startup if the last rebuild was more than
7 days ago.

**Important implementation note:** The content tables use `TEXT PRIMARY KEY` (UUID v7), not
`INTEGER PRIMARY KEY`. The `rowid` used by FTS5 is SQLite's implicit auto-assigned 64-bit
integer, separate from the UUID `id` column. FTS5 results return `rowid` values — always join
back to the content table on `rowid` to retrieve the UUID `id`. Be aware that a full `VACUUM`
can change `rowid` values, so always follow a VACUUM with an FTS rebuild.
```

---

## Patch 2: Add Missing Database Indexes

**Severity**: Critical
**Review Finding**: #5 — Missing Indexes Will Cripple the Job Queue
**Target Section**: 8.3 (Schema Overview)

### Rationale

The schema defines tables with primary keys but no secondary indexes. For a job scheduling system, every job queue poll without an index is a full table scan. On a Raspberry Pi with an SD card, this manifests as increasing latency after weeks of operation with hundreds of jobs and thousands of messages. Adding indexes from day one avoids the pain of `CREATE INDEX` on large tables later (which locks the database).

### Changes

**8.3 — Core Database (meridian.db), add after the `config` table definition:**

```sql
-- Indexes for jobs table
-- The job queue polls by status + priority + created_at for dequeuing.
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_queue ON jobs(status, priority, created_at);
CREATE INDEX idx_jobs_parent_id ON jobs(parent_id);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
CREATE INDEX idx_jobs_completed_at ON jobs(completed_at);

-- Indexes for messages table
CREATE INDEX idx_messages_job_id ON messages(job_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_job_created ON messages(job_id, created_at);

-- Indexes for schedules table
-- The scheduler polls for enabled schedules whose next_run_at has passed.
CREATE INDEX idx_schedules_next_run ON schedules(enabled, next_run_at);

-- Indexes for gear table
CREATE INDEX idx_gear_origin ON gear(origin);
CREATE INDEX idx_gear_enabled ON gear(enabled);
```

**8.3 — Journal Database (journal.db), add after the FTS triggers:**

```sql
-- Indexes for episodes table
CREATE INDEX idx_episodes_created_at ON episodes(created_at);
CREATE INDEX idx_episodes_archived_at ON episodes(archived_at);

-- Indexes for facts and procedures tables
CREATE INDEX idx_facts_category ON facts(category);
CREATE INDEX idx_procedures_category ON procedures(category);
```

**8.3 — Add a note about index maintenance after all schema definitions:**

```markdown
**Index maintenance:** Run `ANALYZE` periodically (during idle maintenance windows) so SQLite's
query planner has accurate statistics. Without `ANALYZE`, SQLite uses heuristic estimates that
may not choose the optimal index. Axis schedules `ANALYZE` to run once per day during idle time.
```

---

## Patch 3: Resolve Encryption-at-Rest Gap

**Severity**: Critical
**Review Finding**: #10 — Encryption at Rest Has a Fundamental Gap
**Target Section**: 7.4.7 (Memory Privacy), 6.4 (Secrets Management), 14.1 (Core Technologies)

### Rationale

The architecture claims "memories are stored locally in encrypted SQLite databases," but `better-sqlite3` does not support encrypted databases. It binds to stock SQLite, which has no encryption. Achieving database-level encryption requires either SQLCipher (a drop-in SQLite fork with AES-256 encryption) or filesystem-level encryption. Claiming encryption that the tech stack cannot deliver is worse than not claiming it.

### Changes

**14.1 — Amend the Database row in the Core Technologies table:**

Current:
> | Database | SQLite (via `better-sqlite3`) | No daemon, zero config, single-file, WAL mode for concurrency |

Proposed:
> | Database | SQLite (via `better-sqlite3`) or SQLCipher (via `@journeyapps/sqlcipher`) | No daemon, zero config, single-file, WAL mode for concurrency. SQLCipher variant enables database-level encryption. |

**7.4.7 — Amend the first bullet of Memory Privacy:**

Current:
> Memories are stored locally in encrypted SQLite databases.

Proposed:
> Memories are stored locally in SQLite databases. Database-level encryption is provided via SQLCipher (AES-256-CBC with HMAC-SHA512 page-level authentication) when the user enables it during setup. The encryption key is derived from the user's master password using PBKDF2-SHA512 (SQLCipher default) or Argon2id. On devices where the performance overhead of SQLCipher is unacceptable (~5-15% read overhead, ~15-25% write overhead, more noticeable on Raspberry Pi), users may instead rely on filesystem-level encryption (LUKS on Linux, FileVault on macOS) and disable database-level encryption.

**6.4 — Add after the Secrets Management section:**

```markdown
#### 6.4.1 Encryption Tiers

Meridian supports two encryption models. The user selects one during initial setup:

| Tier | Mechanism | Performance Impact | Protection Scope |
|------|-----------|-------------------|------------------|
| **Database-level** (recommended) | SQLCipher via `@journeyapps/sqlcipher` | ~10-20% slower writes, ~5-15% slower reads | Protects data at rest even if filesystem encryption is absent. Covers all SQLite databases: `meridian.db`, `journal.db`, `sentinel.db`, `audit.db`. |
| **Filesystem-level** | LUKS (Linux), FileVault (macOS), BitLocker (Windows) | Negligible (hardware-accelerated) | Protects the entire disk. Relies on OS-level configuration outside Meridian's control. |

Both tiers can be combined for defense-in-depth. The `secrets.vault` file always uses
application-level AES-256-GCM encryption regardless of the chosen tier — secrets are never
stored in a SQLite database.

**Implementation note:** When database-level encryption is enabled, the encryption key is
provided at connection open time via `PRAGMA key = '...'`. The key is derived from the
master password and held in memory for the process lifetime. On graceful shutdown, the key
is zeroed. The `better-sqlite3` package is swapped for `@journeyapps/sqlcipher` at build
time via a conditional dependency — the API is identical.

**Setup wizard guidance:** During first-run setup, Bridge explains the tradeoff and recommends
database-level encryption for users who have not verified that their device uses full-disk
encryption. For Raspberry Pi users on SD cards (where SQLCipher overhead is most noticeable),
Bridge recommends enabling LUKS and disabling database-level encryption.
```

---

## Patch 4: Merge journal-vectors.db into journal.db

**Severity**: High
**Review Finding**: #6 — sqlite-vec in a Separate Database Creates Join Friction
**Target Section**: 8.2 (Database Layout), 5.4.5 (Retrieval: Hybrid Search), and related references

### Rationale

The vector embeddings in `journal-vectors.db` are always queried together with the content in `journal.db` (hybrid search requires both). Keeping them separate forces either ATTACH or two round-trips per query, plus cross-database sync for inserts and deletes — the same class of problem as FTS5 content-sync but across database boundaries where triggers are unavailable. The sqlite-vec extension works fine in the same database file. There is no security boundary between them — Journal owns both. Merging eliminates a class of bugs and enables single-query hybrid search.

### Changes

**8.2 — Amend the database layout, removing `journal-vectors.db`:**

```
data/
├── meridian.db           # Core database (jobs, configuration, schedules)
├── journal.db            # Memory system (episodes, semantic, procedural, vector embeddings)
├── sentinel.db           # Sentinel Memory (isolated approval decisions)
├── audit.db              # Append-only audit log
├── secrets.vault         # Encrypted secrets store
└── workspace/            # File workspace for Gear operations
    ├── downloads/
    ├── gear/             # Journal-generated Gear (drafts and approved)
    ├── projects/
    └── temp/
```

**8.3 — Journal Database (journal.db), add the vector table schema after the FTS triggers:**

```sql
-- Vector embeddings for semantic search (sqlite-vec extension)
-- Dimension depends on the configured embedding model:
--   768 for nomic-embed-text, 384 for all-MiniLM-L6-v2
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,           -- 'episodic' | 'semantic' | 'procedural'
  embedding FLOAT[768]                 -- Dimension is set at database creation time
                                       -- based on the configured embedding model
);
```

**5.4.5 — Amend the hybrid search description to reflect the merged database:**

Add after the existing description:
```markdown
**Single-database hybrid search:** Because vector embeddings, FTS5 indexes, and content tables
all reside in `journal.db`, hybrid search executes as a single coordinated query sequence within
one database connection:

1. Vector similarity query against `memory_embeddings` → ranked list of IDs with scores.
2. FTS5 keyword query against `*_fts` tables → ranked list of IDs with scores.
3. Reciprocal Rank Fusion on the two result sets.
4. Content retrieval for the top-k fused results (single query, no cross-database join).

This avoids the complexity and sync hazards of querying across separate database files. When a
memory entry is inserted, updated, or deleted, its embedding in `memory_embeddings` is updated
in the same transaction as the content table change — guaranteeing consistency that would be
impossible across separate databases.
```

**Update all references to `journal-vectors.db`** throughout the architecture document (Sections
4.1 component diagram annotations, 8.2, and the `.claude/rules/architecture.md` data isolation
section) to reflect the merge.

---

## Patch 5: Address Multi-Database Cross-Consistency

**Severity**: High
**Review Finding**: #1 — Multi-Database Cross-Consistency is Unaddressed
**Target Section**: 8.2 (Database Layout) — add new subsection 8.2.1

### Rationale

With four separate SQLite databases (down from five after merging journal-vectors.db), cross-database foreign keys do not exist and cross-database transactions are not possible. A job can be deleted from `meridian.db` while its episodes remain orphaned in `journal.db`. An action can complete in `meridian.db` but the audit entry in `audit.db` may be lost if the process crashes between the two writes. The architecture must explicitly acknowledge this consistency model and provide mitigation.

### Changes

**8.2 — Add subsection 8.2.1 after the database layout:**

```markdown
#### 8.2.1 Cross-Database Consistency Model

Meridian uses separate SQLite databases for security isolation (Sentinel cannot access Journal)
and operational separation (audit log is independent). This design choice means:

**What is NOT available:**
- Cross-database foreign keys. References between databases (e.g., `episodes.job_id` referencing
  `jobs.id`) are soft references — TEXT values, not enforced constraints.
- Cross-database transactions. A write to `meridian.db` and `audit.db` cannot be atomic. If
  the process crashes between the two writes, data is inconsistent.

**Mitigation strategies:**

1. **Write-ahead audit pattern:** For audit-critical operations, the audit entry is written
   *before* the action is committed. If the audit write fails, the action is aborted. If the
   action write subsequently fails (process crash), the audit entry records an action that did
   not complete — a benign inconsistency that is preferable to a completed action with no audit
   trail. Specifically:
   ```
   BEGIN (audit.db) → INSERT audit entry (status: 'pending')  → COMMIT
   BEGIN (meridian.db) → perform action → COMMIT
   UPDATE audit entry (status: 'completed')
   ```
   If step 2 crashes, the audit entry shows a pending action that never completed. Axis detects
   these on startup and marks them as `incomplete`.

2. **Periodic consistency checks.** During idle maintenance windows, Axis runs a consistency
   scanner that:
   - Detects orphaned episodes in `journal.db` whose `job_id` no longer exists in `meridian.db`.
   - Detects Sentinel decisions in `sentinel.db` that reference nonexistent action types.
   - Detects audit entries referencing nonexistent jobs.
   Orphaned records are not automatically deleted — they are flagged and the user is notified.
   The user can choose to purge them or keep them (they may contain useful historical context).

3. **No ATTACH for production queries.** Each component opens its own connection to its own
   database. `ATTACH DATABASE` is used only during maintenance operations (backup verification,
   consistency checks). This avoids lock contention and simplifies connection management.

4. **Deletion cascades are application-managed.** When a job is deleted from `meridian.db`,
   the deletion handler also issues deletes to `journal.db` (episodes) and `audit.db` (marks
   audit entries as referencing a deleted job, but does not delete them). These are best-effort
   — if the secondary deletes fail, the consistency scanner will catch the orphans.
```

---

## Patch 6: Replace Audit Log Rotation with Time-Based Partitioning

**Severity**: High
**Review Finding**: #7 — Audit Log "Rotation" is Physically Impossible as Described
**Target Section**: 6.6 (Audit Logging)

### Rationale

The architecture states the audit log "is rotated by size (default: 100 MB per file, kept for 1 year)." SQLite databases are not log files — there is no built-in mechanism to rotate a database at a size threshold. Renaming and recreating requires closing all connections and coordinated downtime. The reviewer recommends time-based partitioning, which avoids the rotation problem entirely.

### Changes

**6.6 — Replace the audit log bullet about rotation:**

Current:
> - Is rotated by size (default: 100 MB per file, kept for 1 year).

Proposed:
> - Uses **time-based partitioning**: audit entries are written to monthly database files
>   (`audit-YYYY-MM.db`). Each month gets its own SQLite database. The current month's database
>   is always the write target. Historical queries that span months ATTACH older files
>   as needed.
> - Monthly files older than the retention period (default: 1 year) are archived to compressed
>   exports (`audit-YYYY-MM.db.zst`) and the original database file is deleted. Archived files
>   can be restored for querying via a maintenance command.
> - This approach avoids the impossible requirement of "rotating" a SQLite database file.
>   Each monthly database is a self-contained, consistent unit that can be backed up,
>   archived, or deleted independently.

**6.6 — Amend the AuditEntry interface and add implementation notes:**

```markdown
**Partition management:** Axis manages the audit partition lifecycle:

- On startup, Axis opens (or creates) the current month's audit database.
- On the first write after a month boundary, Axis creates the new month's database and
  switches the write target. The previous month's database remains open for reads until
  the end of the day, then is closed.
- The `GET /api/audit` endpoint accepts a `from` and `to` date range. If the query spans
  multiple months, Bridge queries each relevant monthly database and merges results.
- A maintenance command (`meridian audit archive`) compresses and archives old partitions.

**Schema consistency:** Each monthly audit database has the same schema (identical `CREATE TABLE`
and indexes). The schema version is recorded in each file so migrations can be applied to older
partitions if the schema evolves.
```

**8.3 — Add audit database schema (currently absent):**

```sql
-- audit-YYYY-MM.db (one per month)
CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,                -- 'user' | 'scout' | 'sentinel' | 'axis' | 'gear'
  actor_id TEXT,                      -- Gear ID if actor is 'gear'
  action TEXT NOT NULL,               -- e.g., 'plan.approved', 'file.write', 'secret.accessed'
  target TEXT,                        -- What was acted upon
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  job_id TEXT,                        -- Associated job (soft reference to meridian.db)
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical'))
);

CREATE INDEX idx_audit_timestamp ON audit_entries(timestamp);
CREATE INDEX idx_audit_actor ON audit_entries(actor);
CREATE INDEX idx_audit_job_id ON audit_entries(job_id);
CREATE INDEX idx_audit_actor_time ON audit_entries(actor, timestamp);
CREATE INDEX idx_audit_action ON audit_entries(action);
```

---

## Patch 7: Add Sentinel Database Schema

**Severity**: Medium
**Review Finding**: #14 — Sentinel Database Schema is Not Defined
**Target Section**: 8.3 (Schema Overview)

### Rationale

The architecture describes Sentinel Memory in detail (Section 5.3.8) with a TypeScript interface but never shows the SQL schema for `sentinel.db`. This is a significant omission — the matching semantics for `scope` (which uses glob patterns, inequality operators, and wildcards) need to be specified.

### Changes

**8.3 — Add after the Journal Database schema (or wherever appropriate):**

```markdown
#### Sentinel Database (sentinel.db)
```

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,           -- e.g., 'file.delete', 'shell.execute', 'network.post'
  scope TEXT NOT NULL,                 -- Pattern: glob ('/tmp/*'), wildcard ('*'), domain ('*@company.com')
  verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny')),
  conditions_json TEXT CHECK (conditions_json IS NULL OR json_valid(conditions_json)),
  expires_at TEXT,                     -- ISO 8601, NULL means no expiry
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Primary lookup: find decisions matching an action type and scope
CREATE INDEX idx_decisions_action_type ON decisions(action_type);
CREATE INDEX idx_decisions_lookup ON decisions(action_type, scope, verdict);
-- Expiry cleanup
CREATE INDEX idx_decisions_expires ON decisions(expires_at);
```

```markdown
**Scope matching semantics:** The `scope` field uses pattern matching at the application level
(not SQL `LIKE` or `GLOB`). When Sentinel checks its memory:

1. Query all non-expired decisions where `action_type` matches (exact match or wildcard prefix,
   e.g., `financial.*` matches `financial.purchase`).
2. For each candidate, evaluate `scope` against the current action's context using glob-style
   matching (via a library like `minimatch`):
   - `/tmp/*` matches any path under `/tmp/`
   - `*@company.com` matches any email at that domain
   - `*` matches everything
   - `>50USD` is parsed as a numeric comparison (application-level, not pattern matching)
3. Most specific match wins. If both `/tmp/*` (allow) and `/tmp/secrets/*` (deny) match,
   the more specific `/tmp/secrets/*` takes precedence.

**Expiry management:** Axis runs a cleanup job hourly that deletes decisions where
`expires_at < now()`. Security-sensitive decisions (shell execution, sudo-like commands) default
to a 24-hour expiry if the user does not specify otherwise.
```

---

## Patch 8: Document Required PRAGMA Configuration

**Severity**: Medium
**Review Finding**: #15 — No PRAGMA Configuration Documented
**Target Section**: 8.1 (Storage Technologies) — add new subsection 8.1.1

### Rationale

The architecture mentions WAL mode but does not specify the full PRAGMA configuration for each database. Critically, `PRAGMA foreign_keys = ON` is **off by default** in SQLite — if not set on every connection, the FK constraints in the schema (e.g., `jobs.parent_id REFERENCES jobs(id)`) are silently unenforced. This must be documented to prevent a class of subtle bugs.

### Changes

**8.1 — Add subsection 8.1.1:**

```markdown
#### 8.1.1 Connection Configuration

Every database connection MUST set the following PRAGMAs at open time. These are not
persisted (except `journal_mode` and `auto_vacuum`) — they must be set per-connection.

```sql
-- Required on every connection, every time
PRAGMA journal_mode = WAL;            -- Write-Ahead Logging (concurrent reads + single writer)
PRAGMA synchronous = NORMAL;          -- Safe with WAL mode; FULL is unnecessarily slow
PRAGMA busy_timeout = 5000;           -- Wait 5s on lock conflicts instead of SQLITE_BUSY
PRAGMA foreign_keys = ON;             -- Enforce FK constraints (OFF by default in SQLite!)
PRAGMA auto_vacuum = INCREMENTAL;     -- Enable incremental space reclamation (set at creation)
PRAGMA temp_store = MEMORY;           -- Store temp tables in memory (faster)
```

```sql
-- Tunable per deployment target
PRAGMA cache_size = -20000;           -- 20 MB page cache (negative = KB)
                                      -- Raspberry Pi: -8000 (8 MB)
                                      -- Mac Mini/VPS: -20000 (20 MB)
PRAGMA mmap_size = 268435456;         -- Memory-map up to 256 MB for read performance
                                      -- Raspberry Pi: 67108864 (64 MB)
                                      -- Mac Mini/VPS: 268435456 (256 MB)
```

```markdown
**Critical note on `foreign_keys`:** SQLite disables foreign key enforcement by default. The
`PRAGMA foreign_keys = ON` must be executed on every new connection — it is not persisted in
the database file. If this PRAGMA is missed, constraints like
`parent_id TEXT REFERENCES jobs(id)` and `job_id TEXT REFERENCES jobs(id)` become decorative
comments with no runtime effect.

**Note on `auto_vacuum`:** The `INCREMENTAL` setting must be applied before the database
contains any data (ideally in the `CREATE DATABASE` / first-migration step). It cannot be
changed afterward without running a full `VACUUM`. Once set, call
`PRAGMA incremental_vacuum(N)` periodically during maintenance to free N pages.

The shared package (`@meridian/shared`) should export a `configureConnection(db)` function
that applies all required PRAGMAs to a `better-sqlite3` database instance. Every component
must call this function when opening a connection.
```

---

## Patch 9: Specify Per-Database Migration Strategy

**Severity**: Medium
**Review Finding**: #8 — Migration Strategy Across Five Databases is Under-Specified
**Target Section**: 8.5 (Migration Strategy)

### Rationale

With four separate databases (after merging journal-vectors.db), the migration strategy needs to specify: which database has the `schema_version` table, how cross-database migrations are handled, and what happens on partial failure.

### Changes

**8.5 — Replace the existing migration strategy with:**

```markdown
### 8.5 Migration Strategy

Each database tracks its own schema version independently:

**Per-database migration directories:**

```
migrations/
  meridian/        # Migrations for meridian.db
    001_initial.sql
    002_add_schedules.sql
    ...
  journal/         # Migrations for journal.db
    001_initial.sql
    ...
  sentinel/        # Migrations for sentinel.db
    001_initial.sql
    ...
  audit/           # Migrations for audit-YYYY-MM.db template
    001_initial.sql
    ...
```

**Each database contains its own version table:**

```sql
CREATE TABLE schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  description TEXT
);
```

**Startup migration procedure:**

1. Axis opens each database and reads its `schema_version`.
2. For each database that is behind, Axis applies pending migrations in order.
3. Each migration runs in its own transaction within its database. If a migration fails,
   the transaction is rolled back and startup is aborted with a clear error message.
4. Databases are migrated independently — a migration for `meridian.db` does not affect
   `journal.db` and vice versa.
5. If a logical change spans multiple databases (rare), it is split into separate per-database
   migrations with the same version number and a documented dependency order.

**Backup before migration:** Before applying any migration, Axis creates a backup of ALL
databases using `VACUUM INTO` (SQLite 3.27.0+). If migration fails and the user needs to
roll back, all databases are restored together (not individually) to maintain cross-database
consistency.

**Audit database migrations:** Since audit uses time-based partitioning (monthly files), the
`audit/` migration directory contains a template schema. New monthly databases are created with
the latest schema. Older monthly databases are migrated on-demand when they are opened for
querying (lazy migration).

Migrations are forward-only (no rollback scripts). Backups serve as the rollback mechanism.
Each migration is tested against all previous schema versions in CI.
```

---

## Patch 10: Address WAL Mode on SD Cards

**Severity**: Medium
**Review Finding**: #3 — WAL Mode on SD Cards is Risky
**Target Section**: 11.2 (Resource Management on Constrained Devices)

### Rationale

WAL mode with four databases means 12 files (4 `.db` + 4 `.db-wal` + 4 `.db-shm`). On SD cards with limited write endurance and high random-write latency, frequent checkpointing can cause write amplification and WAL file growth. The recommendations are configuration tuning and strong guidance toward SSD.

### Changes

**11.2 — Under "Raspberry Pi Optimizations," add:**

```markdown
- **WAL checkpoint tuning**: SD cards suffer from write amplification on small random writes.
  Adjust WAL checkpoint behavior:
  - Set `PRAGMA wal_autocheckpoint = 5000` (vs. default 1000 pages) to batch checkpoint I/O.
  - Stagger checkpoint timing: Axis triggers `PRAGMA wal_checkpoint(TRUNCATE)` for each
    database in sequence during idle periods, not simultaneously. This avoids all four WAL
    files competing for I/O on a single storage device.
  - Monitor WAL file sizes. Add a metric per database. Alert if any WAL exceeds 50 MB
    (suggesting checkpoints are falling behind).
- **Storage recommendation**: An SSD connected via USB 3.0 is the recommended storage for any
  non-trivial workload on Raspberry Pi. SD cards work but have performance and longevity
  caveats:
  - Higher write latency (5-50x slower random writes vs. SSD)
  - Limited write endurance (typically 10,000-100,000 write cycles per cell)
  - WAL checkpoint I/O can reduce SD card lifespan with sustained use
  The setup wizard should note this recommendation when it detects the data directory is on
  removable storage.
```

---

## Patch 11: Add Data Retention and VACUUM Strategy

**Severity**: Medium
**Review Finding**: #9 — Data Retention Without VACUUM Leaks Disk Space
**Target Section**: 7.4 (Data Retention), 11.2 (Resource Management)

### Rationale

When rows are deleted (e.g., 90-day episode retention), SQLite does not return disk space to the OS. The database file stays the same size. On a 32 GB SD card, this matters. The architecture mentions "database vacuuming during idle periods" without specifying the mechanism.

### Changes

**7.4 — Add after the Data Retention table:**

```markdown
**Space reclamation:** Deleted rows do not shrink the database file on disk. SQLite reuses
the freed pages for future inserts, but the file does not shrink without explicit action.

Meridian uses **incremental auto-vacuum** (`PRAGMA auto_vacuum = INCREMENTAL`, set at database
creation time) as the primary space reclamation mechanism. Periodically during idle maintenance,
Axis calls `PRAGMA incremental_vacuum(N)` to release N pages back to the OS. This is much
cheaper than a full `VACUUM`:

| Mechanism | Behavior | Downtime | Disk Requirement | rowid Impact |
|-----------|----------|----------|-----------------|--------------|
| `incremental_vacuum(N)` | Frees N pages | None (concurrent) | None | No change |
| Full `VACUUM` | Rewrites entire database | Exclusive lock required | 2x database size | May change rowids |

Full `VACUUM` is reserved for major maintenance events (e.g., after bulk data deletion) and
requires special handling:
1. Axis suspends job processing.
2. All connections except the maintenance connection are closed.
3. VACUUM runs.
4. FTS5 indexes are rebuilt (VACUUM can change rowids — see Section 8.3 note).
5. Connections are reopened and job processing resumes.

**Monitoring:** Axis tracks `PRAGMA page_count` and `PRAGMA freelist_count` for each database.
If free pages exceed 30% of total pages, a maintenance notification is surfaced in Bridge
suggesting the user run space reclamation.
```

---

## Patch 12: Address Connection Management and Event Loop Blocking

**Severity**: Medium
**Review Finding**: #11 — Connection Management and Event Loop Concerns
**Target Section**: 14.1 (Core Technologies), 11.2 (Resource Management)

### Rationale

`better-sqlite3` is synchronous and blocks the Node.js event loop. For indexed lookups this is negligible, but full table scans, FTS5 rebuilds, VACUUM, and large JSON reads can block the event loop and delay WebSocket messages and HTTP requests. The architecture should specify the mitigation strategy.

### Changes

**14.1 — Add after the Core Technologies table:**

```markdown
**SQLite connection model:** `better-sqlite3` is deliberately synchronous — SQLite's local disk
I/O is typically measured in microseconds, making async wrappers overhead without benefit. However,
some operations can block the event loop for noticeable durations. Meridian mitigates this:

1. **Worker threads for heavy operations.** `better-sqlite3` supports use from worker threads.
   The following operations run in a dedicated database worker thread:
   - Full `VACUUM`
   - FTS5 index rebuilds
   - Backup operations (`VACUUM INTO`)
   - `ANALYZE`
   - Consistency checks (cross-database reference validation)
   - Any query expected to scan more than 10,000 rows

2. **Separate read and write connections.** Each database opens two connections:
   - A write connection (used for INSERT, UPDATE, DELETE, DDL).
   - A read connection (opened with `readonly: true`).
   WAL mode ensures write transactions do not block reads. The read connection is used for
   all query operations (job status lookups, memory retrieval, audit queries).

3. **`PRAGMA busy_timeout = 5000`** on all connections. Without this, a write that conflicts
   with another write fails immediately with `SQLITE_BUSY`. The busy timeout makes the
   connection wait up to 5 seconds for the lock to clear.

4. **Query timing instrumentation.** All database calls are timed in development. Queries
   taking more than 10ms on target hardware are flagged for investigation and index review.
```

---

## Patch 13: Improve Backup Consistency

**Severity**: Medium
**Review Finding**: #12 — Backup Consistency Across Multiple Databases
**Target Section**: 8.4 (Backup and Recovery)

### Rationale

Backing up four databases sequentially means the backup set is not globally consistent — a job may complete between backing up `meridian.db` and `journal.db`, leaving the backup with mismatched states. For a single-user self-hosted system, this is usually acceptable, but it should be acknowledged and mitigated.

### Changes

**8.4 — Amend the backup section:**

```markdown
### 8.4 Backup and Recovery

- **Backup mechanism**: Use `VACUUM INTO 'path/backup.db'` (SQLite 3.27.0+) for each database.
  `VACUUM INTO` creates a compacted, consistent snapshot in a single operation. Unlike the
  online backup API, it produces a defragmented copy. It only acquires a shared read lock,
  so it runs concurrently with reads and writes in WAL mode.

- **Near-consistent snapshots**: To minimize cross-database inconsistency, Axis performs
  backups in a "quiet period":
  1. Axis stops dispatching new jobs (existing running jobs continue).
  2. Axis waits for in-flight database writes to complete (timeout: 10 seconds).
  3. Axis backs up all databases in rapid sequence: `meridian.db`, `journal.db`,
     `sentinel.db`, then the current month's `audit-YYYY-MM.db`.
  4. Axis resumes job dispatching.
  This creates a near-consistent snapshot. Minor inconsistencies are possible (a WebSocket
  message could arrive during the backup sequence) but are repaired by the consistency
  scanner on restore.

- **Backup rotation**: Keep 7 daily backups, 4 weekly, and 3 monthly. Configurable.
- **Backup verification**: After each backup, run `PRAGMA integrity_check` on the backup file.
- **Restore**: `meridian restore <backup-path>` restores ALL databases together from a backup
  set. The current state is preserved as a pre-restore backup. After restore, Axis runs the
  consistency scanner and FTS5 rebuild to repair any cross-database inconsistencies.
- **Export**: `meridian export` creates a portable archive of all data (databases + workspace +
  config) for migration.
```

---

## Patch 14: Add JSON Validity CHECK Constraints

**Severity**: Low
**Review Finding**: #4 — JSON Columns Need CHECK Constraints
**Target Section**: 8.3 (Schema Overview — Core Database)

### Rationale

JSON columns (`plan_json`, `validation_json`, `result_json`, `error_json`) have no validation. A bug in Scout could write malformed JSON, and the error would be discovered far from its origin. Adding `CHECK` constraints with `json_valid()` catches malformed JSON at write time.

### Changes

**8.3 — Core Database, amend the `jobs` table JSON columns:**

Current:
```sql
  plan_json TEXT,                -- Execution plan (JSON)
  validation_json TEXT,          -- Sentinel validation result (JSON)
  result_json TEXT,              -- Execution result (JSON)
  error_json TEXT,               -- Error details (JSON)
```

Proposed:
```sql
  plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
  validation_json TEXT CHECK (validation_json IS NULL OR json_valid(validation_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
```

Also apply to `messages.attachments_json`, `schedules.job_template_json`, `gear.manifest_json`,
and `gear.config_json`:

```sql
  attachments_json TEXT CHECK (attachments_json IS NULL OR json_valid(attachments_json)),
  job_template_json TEXT NOT NULL CHECK (json_valid(job_template_json)),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
```

`json_valid()` is available in all versions of `better-sqlite3` (compiled with JSON1 enabled,
and built-in since SQLite 3.38.0).

---

## Patch 15: Document UUID v7 Storage Tradeoff

**Severity**: Low
**Review Finding**: #13 — UUID v7 as TEXT Primary Key — Storage and Performance Overhead
**Target Section**: 15 (Development Principles) — add to 15.1 or new subsection

### Rationale

UUID v7 stored as TEXT is 36 bytes per occurrence vs. 16 bytes as BLOB or 4-8 bytes as INTEGER. For high-volume tables, this compounds across PKs, indexes, and FK columns. The reviewer notes this is acceptable for a single-user system but the tradeoff should be documented and a mitigation path identified.

### Changes

**15.1 — Add after the code organization tree, or as a new "Data Design Decisions" note:**

```markdown
**UUID v7 as TEXT Primary Key:**

All entity IDs use UUID v7 stored as TEXT (36 bytes, e.g., `"0190a6c8-a4e3-7b1a-8c1e-..."`).
This was chosen for:
- **Debuggability**: UUIDs are human-readable in logs, SQL queries, and API responses.
- **Cross-database references**: No ambiguity about which "row 42" is meant.
- **Time-sortability**: UUID v7 encodes a timestamp, so inserts are sequential in the B-tree
  (avoiding page splits and fragmentation).

**Known cost:** TEXT UUIDs use ~36 bytes per occurrence vs. 16 bytes as BLOB. For a single-user
system, the performance difference is unlikely to be the bottleneck (LLM API latency dwarfs
database access). However, for high-volume tables (`messages`, `episodes`, audit entries),
storage overhead accumulates.

**Mitigation path (if needed):** If storage becomes a concern on constrained devices, the
highest-volume tables can be migrated to store UUIDs as BLOB(16) with application-level
conversion to/from the human-readable format. This halves PK storage overhead. Tables that
primarily serve as lookup targets (`config`, `gear`, `schedules`) can use `WITHOUT ROWID` to
eliminate the double-B-tree indirection. These optimizations are not planned for v1 but the
schema migration system supports them if needed.
```

---

## Summary

| # | Patch | Severity | Section(s) Modified |
|---|-------|----------|---------------------|
| 1 | Add FTS5 content-sync triggers | Critical | 8.3 |
| 2 | Add missing database indexes | Critical | 8.3 |
| 3 | Resolve encryption-at-rest gap | Critical | 6.4, 7.4.7, 14.1 |
| 4 | Merge journal-vectors.db into journal.db | High | 8.2, 8.3, 5.4.5 |
| 5 | Address multi-database cross-consistency | High | 8.2 (new 8.2.1) |
| 6 | Replace audit log rotation with time-based partitioning | High | 6.6, 8.3 |
| 7 | Add Sentinel database schema | Medium | 8.3 |
| 8 | Document required PRAGMA configuration | Medium | 8.1 (new 8.1.1) |
| 9 | Specify per-database migration strategy | Medium | 8.5 |
| 10 | Address WAL mode on SD cards | Medium | 11.2 |
| 11 | Add data retention and VACUUM strategy | Medium | 7.4, 11.2 |
| 12 | Address connection management and event loop | Medium | 14.1, 11.2 |
| 13 | Improve backup consistency | Medium | 8.4 |
| 14 | Add JSON validity CHECK constraints | Low | 8.3 |
| 15 | Document UUID v7 storage tradeoff | Low | 15.1 |

### Cross-References with Other Patches

Several patches from this review interact with patches from other critic reviews:

| This Patch | Other Patch | Interaction |
|-----------|-------------|-------------|
| #1 (FTS5 triggers) | AI Researcher #3 (multi-tag memory) | Compatible. If memory_links table is added per researcher patch, it needs its own indexes but no FTS. |
| #2 (indexes) | AI Researcher #3 (memory_links table) | The memory_links table from the researcher patch also needs indexes: `CREATE INDEX idx_memory_links_source ON memory_links(source_id, source_type)` and `CREATE INDEX idx_memory_links_target ON memory_links(target_id, target_type)`. |
| #4 (merge vector DB) | AI Tooling Engineer #1 (MCP-first) | Compatible. The merged journal.db stores embeddings alongside content regardless of whether Gear uses MCP. |
| #6 (audit partitioning) | AI Tooling Engineer #4 (reliability) | Compatible. The reliability section's audit references work with partitioned audit databases — queries are routed to the correct monthly file. |
| #8 (PRAGMA config) | All patches | Foundational. The `configureConnection()` function from this patch should be implemented early as it affects all database operations. |
| #14 (JSON CHECK constraints) | AI Tooling Engineer #5 (replanning context) | Compatible. The StepResult data stored in `result_json` will be validated by the CHECK constraint. |
