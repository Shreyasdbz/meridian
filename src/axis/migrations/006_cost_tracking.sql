-- Cost tracking (Phase 9.5)
-- Records individual LLM calls and daily cost aggregates.

-- Individual LLM call records
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  component TEXT NOT NULL,           -- 'scout' | 'sentinel'
  provider TEXT NOT NULL,            -- e.g. 'anthropic', 'openai'
  model TEXT NOT NULL,               -- e.g. 'claude-sonnet-4-5-20250929'
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Daily cost aggregates (materialized for fast dashboard queries)
CREATE TABLE cost_daily (
  date TEXT NOT NULL,                -- YYYY-MM-DD
  component TEXT NOT NULL,           -- 'scout' | 'sentinel' | 'total'
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, component, provider, model)
);

-- Indexes for efficient queries
CREATE INDEX idx_llm_calls_job_id ON llm_calls(job_id);
CREATE INDEX idx_llm_calls_created_at ON llm_calls(created_at);
CREATE INDEX idx_llm_calls_component ON llm_calls(component);
CREATE INDEX idx_cost_daily_date ON cost_daily(date);
