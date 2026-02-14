-- TOTP Two-Factor Authentication (Phase 11.3)
-- Stores TOTP configuration (secret, backup codes, enabled state).

CREATE TABLE IF NOT EXISTS totp_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- Single-user: constrained to one row
  secret_hex TEXT NOT NULL,                 -- TOTP secret (hex-encoded)
  enabled INTEGER NOT NULL DEFAULT 0,       -- 0 = pending/disabled, 1 = enabled
  backup_codes_json TEXT NOT NULL,          -- JSON array of remaining backup codes
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
