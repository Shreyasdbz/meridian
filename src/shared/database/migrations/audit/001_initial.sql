-- Audit Database (audit-YYYY-MM.db) — Initial Schema
-- Architecture Reference: Section 6.6, 8.3
-- Append-only: no UPDATE or DELETE operations allowed on audit_entries

CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,           -- UUID v7
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,           -- 'user' | 'scout' | 'sentinel' | 'axis' | 'gear'
  actor_id TEXT,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL,      -- 'low' | 'medium' | 'high' | 'critical'
  target TEXT,
  job_id TEXT,
  previous_hash TEXT,
  entry_hash TEXT,
  details TEXT CHECK (json_valid(details) OR details IS NULL)
);

CREATE INDEX idx_audit_timestamp ON audit_entries(timestamp);
CREATE INDEX idx_audit_actor ON audit_entries(actor);
CREATE INDEX idx_audit_action ON audit_entries(action);
CREATE INDEX idx_audit_job_id ON audit_entries(job_id);
CREATE INDEX idx_audit_risk_level ON audit_entries(risk_level);
