-- Sentinel Database (sentinel.db) — Initial Schema
-- Architecture Reference: Section 8.3

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny')),
  job_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  conditions TEXT,
  metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
);

CREATE INDEX idx_decisions_action_scope ON decisions(action_type, scope);
CREATE INDEX idx_decisions_expires ON decisions(expires_at) WHERE expires_at IS NOT NULL;
