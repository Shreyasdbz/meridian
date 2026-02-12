-- Meridian Core Database (meridian.db) — Initial Schema
-- Architecture Reference: Section 8.3

-- Conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,           -- UUID v7
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Job tracking
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,           -- UUID v7
  parent_id TEXT REFERENCES jobs(id),
  conversation_id TEXT REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  source_type TEXT NOT NULL,
  source_message_id TEXT,
  dedup_hash TEXT,               -- For duplicate detection
  plan_json TEXT CHECK (json_valid(plan_json) OR plan_json IS NULL),
  validation_json TEXT CHECK (json_valid(validation_json) OR validation_json IS NULL),
  result_json TEXT CHECK (json_valid(result_json) OR result_json IS NULL),
  error_json TEXT CHECK (json_valid(error_json) OR error_json IS NULL),
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  timeout_ms INTEGER DEFAULT 300000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- Conversation messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  conversation_id TEXT REFERENCES conversations(id),
  role TEXT NOT NULL,            -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  modality TEXT DEFAULT 'text',  -- 'text' | 'voice' | 'image' | 'video'
  attachments_json TEXT CHECK (json_valid(attachments_json) OR attachments_json IS NULL),
  created_at TEXT NOT NULL
);

-- Scheduled jobs
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  job_template_json TEXT NOT NULL CHECK (json_valid(job_template_json)),
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL
);

-- Installed Gear registry
CREATE TABLE gear (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  origin TEXT NOT NULL DEFAULT 'user',  -- 'builtin' | 'user' | 'journal'
  draft INTEGER DEFAULT 0,             -- 1 for Journal-generated Gear pending review
  installed_at TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  config_json TEXT CHECK (json_valid(config_json) OR config_json IS NULL),
  signature TEXT,
  checksum TEXT NOT NULL
);

-- Execution log
CREATE TABLE execution_log (
  execution_id TEXT PRIMARY KEY, -- Derived from jobId + stepId
  job_id TEXT NOT NULL REFERENCES jobs(id),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  result_json TEXT CHECK (json_valid(result_json) OR result_json IS NULL),
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- User configuration
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Core database indexes
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_queue ON jobs(status, priority, created_at);
CREATE INDEX idx_jobs_parent_id ON jobs(parent_id);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
CREATE INDEX idx_jobs_completed_at ON jobs(completed_at);
CREATE INDEX idx_jobs_conversation ON jobs(conversation_id);
CREATE INDEX idx_jobs_dedup ON jobs(dedup_hash) WHERE status NOT IN ('completed', 'failed', 'cancelled');
CREATE INDEX idx_messages_job_id ON messages(job_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_schedules_next_run ON schedules(next_run_at) WHERE enabled = 1;
CREATE INDEX idx_gear_origin ON gear(origin);
CREATE INDEX idx_gear_enabled ON gear(enabled);
CREATE INDEX idx_execution_log_job_id ON execution_log(job_id);
