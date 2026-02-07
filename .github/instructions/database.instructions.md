---
applyTo: "**/*db*,**/*sql*,**/*migration*,**/*schema*"
---

# Database Conventions for Meridian

- SQLite only via `better-sqlite3` — no PostgreSQL, MySQL, Redis, etc.
- WAL mode enabled for concurrent reads with single writer
- Multiple databases for isolation:
  - `meridian.db` — jobs, config, schedules, gear registry (Axis owns)
  - `journal.db` — episodic, semantic, procedural memories (Journal owns)
  - `journal-vectors.db` — vector embeddings via sqlite-vec (Journal owns)
  - `sentinel.db` — approval decisions (Sentinel owns, completely isolated)
  - `audit.db` — append-only audit log (never UPDATE or DELETE)
- Use parameterized queries exclusively — never string-interpolate SQL
- Migrations are numbered sequentially: `001_initial.sql`, `002_add_schedules.sql`
- Migrations are forward-only (no rollback scripts)
- TEXT type for IDs (UUID v7), TEXT for timestamps (ISO 8601), TEXT for JSON blobs
- FTS5 virtual tables for full-text search on memory content
