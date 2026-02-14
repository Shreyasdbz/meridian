-- Journal Database — Phase 10.1: Embeddings & Memory Staging
-- Architecture Reference: Section 5.4, 8.3

-- Memory staging table (24-hour review period before promotion)
CREATE TABLE memory_staging (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,       -- 'episodic' | 'semantic' | 'procedural'
  content TEXT NOT NULL,
  category TEXT,                    -- for facts/procedures
  confidence REAL DEFAULT 1.0,     -- for facts
  source_episode_id TEXT,
  job_id TEXT,
  staged_at TEXT NOT NULL,
  promoted_at TEXT,                 -- set when promoted to main tables
  rejected_at TEXT,                 -- set when user rejects
  metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
);

CREATE INDEX idx_staging_staged_at ON memory_staging(staged_at);
CREATE INDEX idx_staging_memory_type ON memory_staging(memory_type);
CREATE INDEX idx_staging_promoted ON memory_staging(promoted_at);

-- Memory embeddings table (pure-JS cosine similarity fallback)
-- If sqlite-vec is available, a vec0 virtual table is created at runtime.
-- This table stores embeddings as BLOB (Float32Array) for the fallback path.
CREATE TABLE memory_embeddings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL DEFAULT 768,
  created_at TEXT NOT NULL,
  UNIQUE(memory_id)
);

CREATE INDEX idx_embeddings_memory_type ON memory_embeddings(memory_type);

-- FTS5 content-sync triggers (deferred from 001_initial.sql)
-- These keep FTS5 indexes in sync with content tables.

-- Episodes FTS sync
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

-- Facts FTS sync
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

-- Procedures FTS sync
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
