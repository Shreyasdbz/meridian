# Database Engineering Review: Meridian Architecture

> **Reviewer**: Senior Database Engineer (SQLite specialist)
> **Document Reviewed**: `docs/architecture.md` v1.2 (2026-02-07)
> **Review Date**: 2026-02-07
> **Severity Scale**: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## Executive Summary

Meridian's decision to use SQLite as its sole data store is sound for a self-hosted, single-user system targeting low-power devices. SQLite is the right database for this use case. However, the architecture document reveals significant gaps in how SQLite is actually wielded. The multi-database design introduces cross-database consistency problems that the document does not acknowledge. The FTS5 content-sync tables are a ticking time bomb without explicit trigger management. The schema is missing critical indexes for the job queue workload. The encryption story has a fundamental gap. And the audit log "rotation" strategy is described in a way that is physically impossible with SQLite.

The good news: none of these are architectural dead ends. They are all fixable with careful implementation. The bad news: several of them will cause silent data corruption or degraded performance if the implementation team is not explicitly warned.

---

## Finding 1: Multi-Database Cross-Consistency is Unaddressed

**Severity: HIGH**

The architecture defines five separate SQLite databases:

```
meridian.db        -- jobs, messages, config, gear, schedules
journal.db         -- episodes, facts, procedures, FTS indexes
journal-vectors.db -- vector embeddings (sqlite-vec)
sentinel.db        -- approval decisions
audit.db           -- append-only audit log
```

This isolation is motivated by security boundaries (Sentinel cannot access Journal, etc.), and that motivation is valid. However, the document does not address the consistency implications.

### The Problems

**No cross-database foreign keys.** SQLite foreign keys do not work across database boundaries. The `episodes` table in `journal.db` has a `job_id TEXT` column, but this cannot reference `jobs(id)` in `meridian.db`. This means:

- You can delete a job from `meridian.db` and orphan every episode that referenced it in `journal.db`.
- You can have a `source_episode_id` in the `facts` table that points to a deleted or nonexistent episode.
- There is no referential integrity whatsoever between the five databases.

**No cross-database transactions.** SQLite transactions are per-connection. Even with `ATTACH DATABASE`, you cannot get a single atomic transaction that spans two separate database files with guaranteed rollback semantics. If you write a job to `meridian.db` and then the process crashes before writing the corresponding audit entry to `audit.db`, you have a job with no audit trail. The architecture claims "every significant action is recorded in the append-only audit log" -- this guarantee is not enforceable across database boundaries.

**ATTACH DATABASE has limitations.** You can use `ATTACH DATABASE` to query across databases within a single connection, but:

- A single connection can attach at most 10 databases by default (compile-time limit `SQLITE_MAX_ATTACHED`; `better-sqlite3` uses the default of 10, which is enough for 5 databases, but leaves limited headroom).
- An attached database shares the connection's WAL mode setting. If you open `meridian.db` in WAL mode and attach `journal.db`, the attached database must also be in WAL mode (it will be, since you configure them all for WAL, but this is a constraint to be aware of).
- ATTACH adds complexity to connection management and makes it harder to reason about lock contention.

### Recommendations

1. **Accept the eventual consistency model explicitly.** Document that cross-database references are soft references (just TEXT values, not enforced foreign keys). Build application-level consistency checks that run periodically (e.g., during idle maintenance) to detect and repair orphaned records.
2. **Use a write-ahead pattern for audit entries.** Write the audit entry *before* or *simultaneously with* the action, not after. If the audit write fails, abort the action. This is the only way to guarantee audit completeness.
3. **Do not rely on ATTACH for production queries.** Use it only for maintenance operations (backup verification, consistency checks). Each component should open its own database connection to its own database file.
4. **Consider merging `journal.db` and `journal-vectors.db` into a single database.** These are always queried together (hybrid search requires both). Keeping them separate forces you to either ATTACH or do two round-trips per query. The sqlite-vec extension can coexist with FTS5 in the same database file. The "isolation" argument does not apply here -- they are both owned by Journal.

---

## Finding 2: FTS5 Content-Sync Tables Will Desync

**Severity: CRITICAL**

The schema defines content-sync FTS5 tables:

```sql
CREATE VIRTUAL TABLE facts_fts USING fts5(content, content=facts, content_rowid=rowid);
CREATE VIRTUAL TABLE procedures_fts USING fts5(content, content=procedures, content_rowid=rowid);
CREATE VIRTUAL TABLE episodes_fts USING fts5(content, content=episodes, content_rowid=rowid);
```

The `content=facts` syntax creates an **external content FTS5 table** that reads content from the `facts` table on demand. (Note: this is distinct from a *contentless* table, which uses `content=''` and cannot retrieve original text at all.) This is space-efficient because FTS5 does not store a copy of the original content. However, it comes with a critical requirement that the architecture document does not mention.

### The Problem

External content FTS5 tables do NOT automatically update when the underlying content table changes. From the SQLite documentation:

> "It is the responsibility of the user to ensure that the contents of an FTS index are consistent with the contents of the content table."

This means:

- **INSERT into `facts`**: You must also manually run `INSERT INTO facts_fts(rowid, content) VALUES (new.rowid, new.content)`.
- **UPDATE on `facts`**: You must first run `INSERT INTO facts_fts(facts_fts, rowid, content) VALUES('delete', old.rowid, old.content)` and then `INSERT INTO facts_fts(rowid, content) VALUES (new.rowid, new.content)`.
- **DELETE from `facts`**: You must run `INSERT INTO facts_fts(facts_fts, rowid, content) VALUES('delete', old.rowid, old.content)`.

If any of these are missed, the FTS index becomes inconsistent with the content table. Search results will return stale data, miss new data, or worse, return rowids that point to wrong or deleted rows. This is silent corruption -- there is no error, no warning, just wrong results.

### But Wait -- There is Another Problem

The content tables use `TEXT PRIMARY KEY` (UUID v7), not `INTEGER PRIMARY KEY`. The `content_rowid=rowid` directive maps to SQLite's implicit `rowid`. In SQLite, when a table has a `TEXT PRIMARY KEY`, the `rowid` is an auto-assigned 64-bit integer that is *separate* from the `id` column. This is fine for FTS5 content-sync, but it means:

- The FTS5 index is keyed by `rowid`, not by the UUID `id`.
- When you retrieve FTS5 results, you get `rowid` values back. You must join back to the content table on `rowid` to get the UUID `id`.
- If a row is deleted and a new row happens to get the same `rowid` (possible with `rowid` reuse after VACUUM), the FTS index could return results for the wrong row if it was not properly maintained.

### Recommendations

1. **Create AFTER INSERT, AFTER UPDATE, and AFTER DELETE triggers** on `facts`, `procedures`, and `episodes` that maintain the FTS5 indexes. This is not optional. Example:

    ```sql
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
    ```

2. **Build a periodic FTS5 rebuild command** (`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`) that runs during maintenance windows. This is a safety net for any missed synchronization.
3. **Add the triggers to the architecture document** so that every implementer knows this is required. Do not leave it to "the application layer will handle it."
4. **Test FTS sync explicitly.** Write tests that insert, update, and delete rows from the content tables and verify the FTS index returns correct results. This should be in the security/integration test suite.

---

## Finding 3: WAL Mode on SD Cards is Risky

**Severity: MEDIUM**

The architecture specifies WAL (Write-Ahead Logging) mode for all SQLite databases. WAL mode is generally excellent -- it allows concurrent readers with a single writer, and it eliminates writer-reader blocking. However, on the Raspberry Pi's primary target storage (SD cards), WAL mode has specific concerns.

### The Problems

**WAL checkpoint I/O.** Each database in WAL mode maintains its own WAL file (`-wal`) and shared memory file (`-shm`). With five databases, that is 15 files (5 `.db` + 5 `.db-wal` + 5 `.db-shm`). WAL checkpointing -- the process of copying WAL contents back into the main database -- is an I/O-intensive operation that writes to both the WAL and the main database file. On SD cards with limited write endurance and high random-write latency, frequent checkpointing across five databases can:

- Cause write amplification (SD cards write in pages/blocks, and small random writes are amplified to full block writes).
- Lead to WAL file growth if checkpoints cannot keep up with write volume.
- Reduce SD card lifespan through excessive writes.

**WAL file growth.** If a long-running read transaction holds the WAL open (e.g., a long-running Journal query while Axis is writing jobs), the WAL file cannot be checkpointed past the reader's snapshot. On a constrained device with limited storage, an unbounded WAL file is a real concern.

**Multiple WALs competing for I/O.** Five databases means five independent WAL files being checkpointed independently. On a single SD card with a single I/O queue, these checkpoints can pile up and create latency spikes.

### Recommendations

1. **Use `PRAGMA wal_autocheckpoint = N` with a tuned value.** The default (1000 pages) may be too aggressive for SD cards. Experiment with higher values (5000-10000) to batch checkpoint I/O.
2. **Stagger checkpoint timing.** Do not let all five databases checkpoint simultaneously. Use a coordinator (Axis) that triggers `PRAGMA wal_checkpoint(TRUNCATE)` for each database in sequence during idle periods.
3. **Monitor WAL file sizes.** Add a metric for WAL file size per database. Alert if any WAL exceeds a configurable threshold (e.g., 50 MB).
4. **Strongly recommend SSD over SD card.** The architecture mentions SD/SSD for Raspberry Pi. The documentation should state clearly that an SSD (via USB 3.0) is the recommended configuration for any non-trivial workload. SD cards should be documented as "works but with performance and longevity caveats."
5. **Consider merging databases** where the security boundary does not require separation (see Finding 1, re: `journal.db` and `journal-vectors.db`). Fewer databases = fewer WAL files = less I/O contention.

---

## Finding 4: JSON Columns -- The Denormalization is Appropriate but Incomplete

**Severity: LOW**

The `jobs` table stores `plan_json`, `validation_json`, `result_json`, and `error_json` as TEXT columns containing JSON. This is the right call for this workload.

### Why This is Fine

These JSON blobs are write-once, read-occasionally documents. The plan is written by Scout, the validation by Sentinel, the result by Gear. They are read when displaying job details in Bridge or during Journal reflection. They are not queried, filtered, or joined on. Normalizing them into separate tables (e.g., `execution_plans`, `plan_steps`, `step_validations`) would add schema complexity and JOIN overhead for no benefit -- these documents are always read as a whole.

SQLite's JSON functions (`json_extract`, `json_each`, etc.) are available if you ever need to query into these blobs, and they perform well for occasional use.

### The Gap

The document does not mention using SQLite's `json()` function or `CHECK` constraints to validate that these columns actually contain valid JSON. Without this:

- A bug in Scout could write malformed JSON to `plan_json`.
- A downstream reader would crash when parsing it.
- The error would be discovered far from its origin, making debugging harder.

### Recommendations

1. **Add CHECK constraints** to validate JSON columns:

    ```sql
    plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
    validation_json TEXT CHECK (validation_json IS NULL OR json_valid(validation_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
    ```

    `json_valid()` has been available since SQLite 3.9.0 (2015-10-14) as part of the JSON1 extension, and became a built-in function (no longer requiring opt-in) in SQLite 3.38.0 (2022-02-22). Since `better-sqlite3` has always compiled with JSON1 enabled, `json_valid()` is available in all supported versions.

2. **Consider the `JSONB` format** available in SQLite 3.45.0+ (2024-01-15). JSONB stores JSON in a binary format that is faster to query with `json_extract`. Since these columns are written once and potentially read many times (Job inspector in Bridge), JSONB is a small win. This is a minor optimization, not a priority.

---

## Finding 5: Missing Indexes Will Cripple the Job Queue

**Severity: CRITICAL**

The schema shows tables with primary keys but **no secondary indexes**. For a job scheduling system, this is a showstopper. Without indexes, every job queue poll becomes a full table scan.

### What is Missing

**`jobs` table:**

```sql
-- The job queue polls by status. Without this, every dequeue is a full table scan.
CREATE INDEX idx_jobs_status ON jobs(status);

-- Jobs are frequently queried by status + priority + created_at for ordering.
-- This composite index covers the most common dequeue query:
-- SELECT * FROM jobs WHERE status = 'pending' ORDER BY priority, created_at LIMIT 1
CREATE INDEX idx_jobs_queue ON jobs(status, priority, created_at);

-- Parent-child job lookups (sub-jobs).
CREATE INDEX idx_jobs_parent_id ON jobs(parent_id);

-- Time-based queries (find jobs created in a range, find stale jobs).
CREATE INDEX idx_jobs_created_at ON jobs(created_at);

-- Find completed/failed jobs for cleanup.
CREATE INDEX idx_jobs_completed_at ON jobs(completed_at);
```

**`messages` table:**

```sql
-- Loading conversation history for a job.
CREATE INDEX idx_messages_job_id ON messages(job_id);

-- Loading recent messages (for Scout context).
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- Composite for "last N messages from a conversation".
CREATE INDEX idx_messages_job_created ON messages(job_id, created_at);
```

**`schedules` table:**

```sql
-- The scheduler polls for enabled schedules whose next_run_at has passed.
CREATE INDEX idx_schedules_next_run ON schedules(enabled, next_run_at);
```

**`episodes` table (journal.db):**

```sql
-- Time-based retention queries.
CREATE INDEX idx_episodes_created_at ON episodes(created_at);

-- Archive queries.
CREATE INDEX idx_episodes_archived_at ON episodes(archived_at);
```

**`facts` and `procedures` tables (journal.db):**

```sql
-- Category filtering.
CREATE INDEX idx_facts_category ON facts(category);
CREATE INDEX idx_procedures_category ON procedures(category);
```

**Audit table (audit.db):**

```sql
-- Time-range queries for audit review.
CREATE INDEX idx_audit_timestamp ON audit_entries(timestamp);

-- Filter by actor.
CREATE INDEX idx_audit_actor ON audit_entries(actor);

-- Filter by job.
CREATE INDEX idx_audit_job_id ON audit_entries(job_id);

-- Composite for common query: "all actions by a specific actor in a time range."
CREATE INDEX idx_audit_actor_time ON audit_entries(actor, timestamp);
```

### Impact

On a fresh system with few rows, the missing indexes are invisible. After weeks of operation with hundreds of jobs, thousands of messages, and a growing audit log, every job dequeue, every conversation load, every audit query will do a full table scan. On a Raspberry Pi with an SD card, this will manifest as increasing latency and eventually visible UI lag.

### Recommendations

1. **Add all the indexes listed above to the initial migration** (`001_initial.sql`). Adding indexes later via migration works, but `CREATE INDEX` on a large table can be slow and locks the database. Better to have them from the start.
2. **Run `ANALYZE` periodically** (during maintenance windows) so SQLite's query planner has accurate statistics. Without `ANALYZE`, SQLite uses heuristic estimates that may not choose the optimal index.
3. **Document the expected query patterns** for each table so future developers know which indexes to add as new queries are introduced.

---

## Finding 6: sqlite-vec in a Separate Database Creates Join Friction

**Severity: HIGH**

The architecture places vector embeddings in `journal-vectors.db`, separate from the content they index in `journal.db`. The stated hybrid search strategy is:

1. Embed the query.
2. Find nearest neighbors via sqlite-vec in `journal-vectors.db`.
3. Retrieve matching content from `journal.db`.
4. Also run FTS5 keyword search on `journal.db`.
5. Combine results with Reciprocal Rank Fusion.

### The Problems

**Two-database round-trip for every search.** Each hybrid search requires:

1. A vector similarity query against `journal-vectors.db` to get a list of IDs.
2. A lookup against `journal.db` (by those IDs) to get the actual content.
3. An FTS5 query against `journal.db`.

This is three queries across two databases. With ATTACH, you could do steps 1 and 2 in a single query, but ATTACH has its own complications (see Finding 1).

**ID synchronization.** The vector table and the content table must be kept in sync. When a fact is deleted from `journal.db`, its embedding must also be deleted from `journal-vectors.db`. This is the same class of sync problem as FTS5 content-sync (Finding 2), but across database boundaries where you do not even have triggers available.

**sqlite-vec works fine in the same database.** The sqlite-vec extension loads into a SQLite connection and creates virtual tables. There is no technical reason these virtual tables cannot coexist with the `facts`, `procedures`, and `episodes` tables in the same database file. The architecture document does not explain why they are separated.

### Recommendations

1. **Merge `journal-vectors.db` into `journal.db`.** This eliminates the cross-database sync problem, enables single-query hybrid search (vector search + content retrieval + FTS in one query), and reduces WAL file count. The resulting database will be larger, but Journal already owns both. There is no security boundary between them.
2. If there is a technical reason for separation (e.g., the sqlite-vec extension has stability concerns and you want to isolate potential corruption), document that reason explicitly. Otherwise, merge.
3. **Define the vector table schema.** The architecture document mentions sqlite-vec but never shows the actual schema for the embeddings table. This is a significant omission. At minimum:

    ```sql
    CREATE VIRTUAL TABLE memory_embeddings USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[768]       -- dimension depends on the embedding model
    );
    ```

    (The dimension should be configurable based on the embedding model -- 768 for nomic-embed-text, 384 for MiniLM.)

---

## Finding 7: Audit Log "Rotation" is Physically Impossible as Described

**Severity: HIGH**

The architecture states:

> "Is rotated by size (default: 100 MB per file, kept for 1 year)."

### The Problem

SQLite databases are not log files. You cannot "rotate" a SQLite database the way you rotate `syslog` output. There is no built-in mechanism to say "when this database reaches 100 MB, start a new one." The options are:

1. **Monitor the file size, then rename and recreate.** When `audit.db` reaches 100 MB, close all connections, rename it to `audit-2026-02-07.db`, create a new empty `audit.db`, and reopen connections. This requires downtime on audit writes and coordination across all components that might be writing audit entries.

2. **Partition by time.** Instead of a single `audit.db`, use `audit-2026-01.db`, `audit-2026-02.db`, etc. This is cleaner but requires the application to manage multiple database files and know which one to write to and which ones to query across.

3. **DELETE old rows and VACUUM.** Delete rows older than the retention period and reclaim space with VACUUM. But the document says the audit log is append-only with no DELETE -- and VACUUM requires exclusive access and rewrites the entire database.

**Foreign key references from other tables.** The architecture does not show any foreign keys to audit entries from other tables, which is good. But if any future code references audit entry IDs (e.g., "this job was approved, see audit entry X"), those references become dangling after rotation.

### Recommendations

1. **Use time-based partitioning.** Write to `audit-YYYY-MM.db`. Each month gets its own database file. Query recent audit entries from the current month's database; for historical queries, ATTACH older files. This is the cleanest approach and avoids the "how do you rotate a SQLite file" question entirely.
2. **Alternative: Use a single database with periodic purging.** If the append-only guarantee is only at the application level (which the document already acknowledges), allow a maintenance command to archive old entries to a compressed export and then delete them. Run `VACUUM` after purging. This is simpler but violates the "append-only" spirit.
3. **Document the exact rotation mechanism.** The current description is too vague to implement correctly. Be specific about what happens when the threshold is reached, how connections are managed during rotation, and how historical queries work.

---

## Finding 8: Migration Strategy Across Five Databases is Under-Specified

**Severity: MEDIUM**

The architecture describes:

> "Migrations are numbered sequentially (`001_initial.sql`, `002_add_schedules.sql`). A `schema_version` table tracks the current version."

### The Problems

**Which database has the `schema_version` table?** With five databases, you need either:

- A `schema_version` table in each database (tracking that database's schema independently), or
- A single `schema_version` table in `meridian.db` tracking all five schemas (requiring ATTACH to apply migrations to other databases).

The document does not specify.

**Atomic cross-database migrations.** What happens when migration `005` needs to change both `meridian.db` (add a column to `jobs`) and `journal.db` (add a new memory type table)? These cannot be done atomically. If the process crashes between the two, you have one database at version 5 and another at version 4. On restart, the migration runner must be smart enough to handle this partial state.

**Migration ordering across databases.** If migration `003` adds a column to `meridian.db` and migration `004` adds a table to `journal.db`, the ordering is fine. But if migration `003` requires that `journal.db` already has a table that is created in the same migration, you need to define the order in which databases are migrated within a single migration version.

### Recommendations

1. **Put a `schema_version` table in each database.** Each database tracks its own version independently.
2. **Use per-database migration directories**: `migrations/meridian/`, `migrations/journal/`, `migrations/sentinel/`, `migrations/audit/`. Each directory has its own numbered migrations. Each database is migrated independently on startup.
3. **If a migration spans databases**, split it into per-database migrations with the same version number. Add a check: if database A is at version N but database B is at version N-1, apply database B's migration first before applying version N+1 to either.
4. **Always backup before migration.** The document mentions this ("pre-migration backup"), which is good. Make it explicit that the backup is of ALL five databases, and that rollback restores ALL five databases together (not one at a time).

---

## Finding 9: Data Retention Without VACUUM Leaks Disk Space

**Severity: MEDIUM**

The architecture specifies 90-day retention for episodic memories with auto-summarization, and 30-day retention for Gear execution logs. When rows are deleted, SQLite does not return the disk space to the operating system. The space is marked as "free" within the database file and reused for future inserts, but the file on disk does not shrink.

### The Problem

On a Raspberry Pi with a 32 GB SD card, disk space is precious. If the system accumulates 90 days of episodic memories, then deletes them, the `journal.db` file stays the same size. After a year of operation, the database files could be consuming far more disk than their actual data would suggest.

`VACUUM` rewrites the entire database file, reclaiming the free space. But `VACUUM`:

- Requires exclusive access (no other connections can be open).
- Temporarily requires approximately 2x the database file size in free disk space (it creates a copy).
- Can take a long time for large databases.
- Resets `rowid` values (relevant for FTS5 content-sync, see Finding 2).

The architecture mentions "Database vacuuming ... run during idle periods" (Section 11.2) but does not specify when, how, or with what safeguards.

### Recommendations

1. **Use `PRAGMA auto_vacuum = INCREMENTAL` instead of manual VACUUM.** Set this at database creation time (it cannot be changed afterward without VACUUM). Incremental auto-vacuum reclaims space without rewriting the entire file:

    ```sql
    PRAGMA auto_vacuum = INCREMENTAL;
    ```

    Then periodically run `PRAGMA incremental_vacuum(N)` to free N pages. This is much cheaper than a full VACUUM and does not require exclusive access.

2. **If using full VACUUM**, schedule it during a maintenance window where Axis suspends job processing. Document the disk space requirement (2x database size in free space). Run it no more frequently than weekly.
3. **Monitor page counts.** Use `PRAGMA page_count` and `PRAGMA freelist_count` to track the ratio of used vs. free pages. Alert if free pages exceed 30% of total pages (suggesting a VACUUM is overdue).
4. **Be aware of the FTS5 rowid problem.** A full VACUUM rewrites the table and can change `rowid` values. If FTS5 content-sync indexes are keyed on `rowid`, a VACUUM without a subsequent FTS rebuild will corrupt the FTS index. This is another reason to prefer `INCREMENTAL` auto-vacuum (which does not change rowid values) or to always follow VACUUM with an FTS rebuild.

---

## Finding 10: Encryption at Rest Has a Fundamental Gap

**Severity: CRITICAL**

The architecture states:

> "Memories are stored locally in encrypted SQLite databases."
> "Secrets are stored in an encrypted vault: AES-256-GCM with a key derived from the user's master password using Argon2id."

### The Problem

`better-sqlite3` does not support encrypted SQLite databases. It is a binding to the stock SQLite C library, which does not include encryption. To encrypt a SQLite database, you need one of:

- **SQLite Encryption Extension (SEE)**: A proprietary, paid extension from the SQLite Consortium. Requires a license.
- **SQLCipher**: An open-source fork of SQLite that adds AES-256 encryption. Requires replacing `better-sqlite3` with `better-sqlite3-sqlcipher` (a fork) or using the `@journeyapps/sqlcipher` package.
- **Application-level encryption**: Encrypt/decrypt individual column values in application code. Does not protect the schema, indexes, or WAL files.
- **Filesystem-level encryption**: Use LUKS, FileVault, or dm-crypt to encrypt the partition. Transparent to SQLite but requires OS-level configuration.

The `secrets.vault` file is described as AES-256-GCM encrypted, which is straightforward since it is presumably a custom binary format, not a SQLite database. But the claim of "encrypted SQLite databases" for Journal and Sentinel is not achievable with the stated tech stack without additional dependencies.

### Recommendations

1. **Use `better-sqlite3-sqlcipher`** (or the `@journeyapps/sqlcipher` binding) if database-level encryption is a hard requirement. This is a drop-in replacement for `better-sqlite3` that uses SQLCipher. Be aware that:
   - SQLCipher has a performance overhead (~5-15% for reads, ~15-25% for writes).
   - On a Raspberry Pi, this overhead is more noticeable.
   - The encryption key must be provided at connection open time (`PRAGMA key = '...'`).
   - The key derivation from the user's master password should use PBKDF2 or Argon2id (SQLCipher supports both).

2. **Alternatively, rely on filesystem-level encryption** and drop the "encrypted SQLite databases" claim. This is simpler, has no performance overhead inside SQLite, and is arguably more appropriate for a self-hosted system where the user controls the device. Document that users should enable full-disk encryption (LUKS on Linux, FileVault on macOS).

3. **If neither is done, remove the "encrypted SQLite databases" claim from the architecture.** Claiming encryption you do not provide is worse than not claiming it at all. The `secrets.vault` can still be AES-256-GCM encrypted at the application level.

4. **Do not use application-level column encryption** for the general databases. It defeats the purpose of FTS5 (you cannot full-text search encrypted text), breaks sqlite-vec (you cannot compute vector similarity on encrypted vectors), and makes every query require a decrypt step.

---

## Finding 11: Connection Management and Event Loop Concerns

**Severity: MEDIUM**

The architecture states `better-sqlite3`'s synchronous API is used. This is a deliberate choice -- `better-sqlite3` is synchronous because SQLite itself is synchronous, and wrapping it in Promises adds overhead without benefit (SQLite's "I/O wait" is typically microseconds for local disk access).

### The Problems

**Blocking the event loop.** `better-sqlite3` calls are synchronous and block the Node.js event loop. For fast queries (indexed lookups, small inserts), this is negligible. But for:

- Full table scans (see Finding 5 about missing indexes).
- Large FTS5 queries or rebuilds.
- VACUUM operations.
- Large JSON column reads (a `plan_json` blob could be tens of KB).

...the event loop blocks, and WebSocket messages, HTTP requests, and timer callbacks are delayed.

**File handle count.** Each `better-sqlite3` connection opens the main database file, plus the WAL file and SHM file. With five databases, that is 15 file handles minimum. Each database might have additional connections if you separate read and write connections (common pattern for WAL mode). That could be 30 file handles. On a Raspberry Pi with default `ulimit -n` of 1024, this is fine, but it is something to be aware of.

**WAL mode and concurrent reads.** WAL mode allows multiple readers and a single writer. But `better-sqlite3` is synchronous, so "concurrent readers" in the WAL sense are not truly concurrent from the Node.js perspective -- they are serialized by the event loop. The WAL benefit is that a reader does not block a writer and vice versa, which matters when you have read transactions that overlap with write transactions in the same event loop tick.

### Recommendations

1. **Use worker threads for heavy database operations.** `better-sqlite3` supports being used from worker threads. Move VACUUM, FTS5 rebuild, backup, and any large scan operations to a worker thread so they do not block the main event loop.
2. **Use separate connections for reads and writes.** Open two connections per database: one for writes (with `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL`) and one for reads (read-only). This ensures write transactions do not block reads even within the synchronous model.
3. **Set `PRAGMA busy_timeout`** on all connections (e.g., `PRAGMA busy_timeout = 5000`). Without this, a write attempt that conflicts with another write will fail immediately with `SQLITE_BUSY` rather than waiting.
4. **Profile query execution times** early in development. Add timing instrumentation to all database calls. Any query taking more than 10ms on the target hardware should be investigated.

---

## Finding 12: Backup Consistency Across Multiple Databases

**Severity: MEDIUM**

The architecture specifies daily backups with `PRAGMA integrity_check` verification. `better-sqlite3` provides a `backup()` API (wrapping SQLite's Online Backup API) that creates a consistent snapshot even while the database is being written to.

### The Problem

The backup is consistent *per database*. But a backup of all five databases is only globally consistent if they are all backed up at the exact same point in time. In practice:

1. You backup `meridian.db` at time T.
2. While backing up `journal.db` (which starts at T+1s), a new job completes and writes to both databases.
3. Now `meridian.db` backup has the job at status `executing`, but `journal.db` backup has the reflection for the completed job.

This is a minor inconsistency for most data, but it means:

- A restored system might have orphaned references.
- Audit entries in `audit.db` backup might reference jobs that are not in the `meridian.db` backup (because the job was created between the two backups).

### Recommendations

1. **Pause write operations during backup.** Have Axis enter a "backup mode" where it stops dispatching new jobs, waits for in-flight writes to complete, then backs up all five databases in sequence. This creates a globally consistent snapshot at the cost of brief unavailability (typically <10 seconds for databases under 100 MB each).
2. **Alternatively, accept the minor inconsistency** and document it. For a single-user self-hosted system, the backup inconsistency is unlikely to cause problems in practice. The consistency checks from Finding 1 can repair any orphaned references after restore.
3. **Use `VACUUM INTO` for backup** (SQLite 3.27.0+, 2019). `VACUUM INTO 'backup.db'` creates a compacted, consistent snapshot in a single operation, which is faster and more space-efficient than the online backup API. Unlike regular `VACUUM`, `VACUUM INTO` only acquires a shared (read) lock on the source database — it can run concurrently with both readers and writers in WAL mode without blocking them. This makes it well-suited for live backups.

---

## Finding 13: UUID v7 as TEXT Primary Key -- Storage and Performance Overhead

**Severity: LOW**

The architecture uses UUID v7 (time-sortable) as `TEXT PRIMARY KEY` for all entity IDs. This is a reasonable choice for distributed-system readiness and debuggability, but it has measurable costs in SQLite.

### The Costs

**Storage overhead.** A UUID v7 stored as TEXT (e.g., `"0190a6c8-a4e3-7b1a-8c1e-d1f2a3b4c5d6"`) is 36 bytes. An `INTEGER PRIMARY KEY` is 1-8 bytes (typically 4-8). For the `messages` table, which could accumulate millions of rows over years, this is significant:

- With TEXT PK: 36 bytes per row for the PK alone, plus the same 36 bytes in every index that references this PK, plus 36 bytes in every foreign key column in other tables.
- With INTEGER PK: 4-8 bytes per row.

For 1 million messages: ~34 MB of overhead just in PK storage. In indexes, it compounds.

**B-tree comparison cost.** SQLite's B-tree compares keys bytewise for TEXT. A 36-byte text comparison is more expensive than a 64-bit integer comparison. This affects every index lookup, every INSERT (which must find the insertion point), and every foreign key check.

**rowid table vs. WITHOUT ROWID.** When a table has a `TEXT PRIMARY KEY`, SQLite creates a hidden `rowid` column (an auto-incrementing 64-bit integer) and uses that as the B-tree key. The TEXT PK becomes a unique index on top of the rowid B-tree. This means every row lookup by UUID requires two B-tree traversals: one in the PK index to find the rowid, then one in the main B-tree to find the row.

You can use `WITHOUT ROWID` to eliminate the hidden rowid and use the TEXT PK directly as the B-tree key. This saves one indirection but makes text-key comparisons the primary bottleneck.

### Why It Is Still Acceptable

- UUID v7 is time-sortable, which means inserts are approximately sequential in the B-tree (new UUIDs are always larger than old ones). This avoids page splits and fragmentation.
- For a single-user system, the performance difference between TEXT PK and INTEGER PK is unlikely to be the bottleneck. LLM API latency will dwarf database access time.
- UUIDs are invaluable for debugging, logging, and cross-database references (no ambiguity about which "row 42" you mean).

### Recommendations

1. **Store UUIDs as BLOB(16) instead of TEXT(36)** to halve the storage overhead. A UUID v7 is 128 bits = 16 bytes. Store it as a BLOB and convert to/from the human-readable string format in application code. This saves ~20 bytes per row per UUID column. Over millions of rows, this adds up.
2. **Use `WITHOUT ROWID`** on tables that are primarily looked up by their PK (e.g., `config`, `gear`, `schedules`). This eliminates the double-B-tree overhead.
3. **If storage on constrained devices is a real concern**, consider using INTEGER PRIMARY KEY for high-volume tables (`messages`, `episodes`, audit entries) and UUID v7 only for entities that need cross-database referencing (`jobs`, `facts`, `procedures`). This is a pragmatic hybrid.
4. **At minimum, document the tradeoff** so future developers understand why UUIDs were chosen and what the cost is.

---

## Finding 14: Sentinel Database Schema is Not Defined

**Severity: MEDIUM**

The architecture describes Sentinel Memory in detail (Section 5.3.8) but never shows the actual SQL schema for `sentinel.db`. We see the TypeScript interface:

```typescript
interface SentinelDecision {
  id: string;
  actionType: string;
  scope: string;
  verdict: 'allow' | 'deny';
  [key: string]: unknown;
}
```

But the corresponding `CREATE TABLE` is missing from Section 8.3.

### Recommendations

1. **Add the schema to Section 8.3.** At minimum:

    ```sql
    -- sentinel.db
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny')),
      conditions_json TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_decisions_action_type ON decisions(action_type);
    CREATE INDEX idx_decisions_lookup ON decisions(action_type, scope, verdict);
    CREATE INDEX idx_decisions_expires ON decisions(expires_at);
    ```

2. **Define the matching semantics for `scope`.** The examples show glob patterns (`/tmp/*`, `*@company.com`), inequality operators (`>50USD`), and wildcards (`*`). How are these matched at query time? Is it `LIKE`? `GLOB`? Application-level pattern matching? This affects both the schema design and the index strategy.

---

## Finding 15: No `PRAGMA` Configuration Documented

**Severity: MEDIUM**

The architecture says "WAL mode" and mentions encryption, but does not specify the full set of `PRAGMA` settings that each database should use. This is a common oversight that leads to inconsistent configuration across databases and sub-optimal performance.

### Recommendations

Document the following PRAGMAs for all databases at connection open time:

```sql
PRAGMA journal_mode = WAL;          -- Write-Ahead Logging
PRAGMA synchronous = NORMAL;        -- Safe with WAL; FULL is unnecessarily slow
PRAGMA busy_timeout = 5000;         -- Wait 5s on lock conflicts instead of failing
PRAGMA cache_size = -20000;         -- 20 MB page cache (negative = KB)
PRAGMA foreign_keys = ON;           -- Enforce FK constraints (OFF by default!)
PRAGMA auto_vacuum = INCREMENTAL;   -- Enable incremental space reclamation
PRAGMA temp_store = MEMORY;         -- Store temp tables in memory
PRAGMA mmap_size = 268435456;       -- Memory-map up to 256 MB for read performance
```

Note: `PRAGMA foreign_keys = ON` is **off by default** in SQLite. If the architecture relies on foreign key constraints (and it does -- `jobs.parent_id REFERENCES jobs(id)`, `messages.job_id REFERENCES jobs(id)`), this PRAGMA must be set on every connection, every time. This is not persisted; it must be set per-connection.

For the Raspberry Pi target, reduce `cache_size` and `mmap_size` to fit within available RAM.

---

## Summary Table

| # | Finding | Severity | Effort to Fix |
|---|---------|----------|---------------|
| 1 | Multi-database cross-consistency unaddressed | HIGH | Medium (design + code) |
| 2 | FTS5 content-sync will desync without triggers | CRITICAL | Low (add triggers) |
| 3 | WAL mode on SD cards is risky | MEDIUM | Low (config + docs) |
| 4 | JSON columns appropriate but need CHECK constraints | LOW | Low (schema change) |
| 5 | Missing indexes will cripple the job queue | CRITICAL | Low (schema change) |
| 6 | sqlite-vec in separate DB creates join friction | HIGH | Medium (merge DBs) |
| 7 | Audit log rotation is not implementable as described | HIGH | Medium (redesign) |
| 8 | Migration strategy across 5 DBs under-specified | MEDIUM | Medium (design) |
| 9 | Data retention without VACUUM leaks disk space | MEDIUM | Low (PRAGMA + schedule) |
| 10 | Encryption at rest has a fundamental gap | CRITICAL | High (dependency change) |
| 11 | Connection management and event loop concerns | MEDIUM | Medium (worker threads) |
| 12 | Backup consistency across multiple databases | MEDIUM | Low (pause writes) |
| 13 | UUID v7 as TEXT PK has storage overhead | LOW | Low-Medium (BLOB option) |
| 14 | Sentinel database schema not defined | MEDIUM | Low (add schema) |
| 15 | No PRAGMA configuration documented | MEDIUM | Low (add to docs) |

### Priority Order for Resolution

1. **Finding 2** (FTS5 triggers) -- silent data corruption, trivial fix
2. **Finding 5** (missing indexes) -- performance cliff, trivial fix
3. **Finding 10** (encryption gap) -- architectural claim is unimplementable with current stack
4. **Finding 6** (merge vector DB) -- simplifies architecture, eliminates a class of bugs
5. **Finding 7** (audit rotation) -- current description is not implementable
6. **Finding 1** (cross-DB consistency) -- design decision needed, affects all future code
7. **Finding 15** (PRAGMA config) -- especially `foreign_keys = ON`, which is off by default
8. Everything else

---

*This review is based solely on the architecture document. Implementation may address some of these concerns. The reviewer recommends creating a dedicated "Data Layer Implementation Guide" that translates these architectural decisions into concrete SQLite configuration, schema, and operational procedures.*
