-- Journal Database (journal.db) — Initial Schema
-- Architecture Reference: Section 8.3

-- Episodic memory
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  content TEXT NOT NULL,
  summary TEXT,                  -- Auto-generated summary for archival
  created_at TEXT NOT NULL,
  archived_at TEXT               -- Set when summarized
);

-- Semantic memory
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,        -- 'user_preference' | 'environment' | 'knowledge'
  content TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,   -- 0-1, reduced when contradicted
  source_episode_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Procedural memory
CREATE TABLE procedures (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,        -- 'strategy' | 'pattern' | 'workflow'
  content TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  source_episode_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search (external content FTS5 tables)
-- Note: content-sync triggers deferred to v0.3
CREATE VIRTUAL TABLE facts_fts USING fts5(content, content=facts, content_rowid=rowid);
CREATE VIRTUAL TABLE procedures_fts USING fts5(content, content=procedures, content_rowid=rowid);
CREATE VIRTUAL TABLE episodes_fts USING fts5(content, content=episodes, content_rowid=rowid);

-- Note: memory_embeddings sqlite-vec virtual table added in Phase 10.1 migration (v0.3)

-- Journal database indexes
CREATE INDEX idx_episodes_created_at ON episodes(created_at);
CREATE INDEX idx_facts_category ON facts(category);
CREATE INDEX idx_procedures_category ON procedures(category);
