-- WebSocket connection tokens (one-time use)
-- Architecture Reference: Section 6.5.2 (WebSocket Authentication)

CREATE TABLE ws_connection_tokens (
  id TEXT PRIMARY KEY,                   -- UUID v7
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,       -- SHA-256 hash of one-time token
  created_at TEXT NOT NULL,
  consumed_at TEXT                        -- NULL = unused, set on consumption
);

CREATE INDEX idx_ws_tokens_hash ON ws_connection_tokens(token_hash);
CREATE INDEX idx_ws_tokens_session ON ws_connection_tokens(session_id);
