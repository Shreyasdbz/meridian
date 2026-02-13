-- Meridian Auth Schema (meridian.db)
-- Architecture Reference: Section 6.3 (Authentication & Authorization)

-- Password storage (single-user system; constrained to one row)
CREATE TABLE auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,           -- bcrypt hash
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Session management
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                   -- UUID v7
  token_hash TEXT NOT NULL,              -- SHA-256 hash of session token
  csrf_token TEXT NOT NULL,              -- Per-session CSRF token
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Brute-force protection tracking
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,                   -- UUID v7
  ip_address TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_login_attempts_ip_time ON login_attempts(ip_address, attempted_at);

-- Per-job approval nonces (one-time use)
CREATE TABLE approval_nonces (
  id TEXT PRIMARY KEY,                   -- UUID v7
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  consumed_at TEXT                       -- NULL = unused, set on consumption
);

CREATE INDEX idx_approval_nonces_job ON approval_nonces(job_id);
CREATE INDEX idx_approval_nonces_nonce ON approval_nonces(nonce);
