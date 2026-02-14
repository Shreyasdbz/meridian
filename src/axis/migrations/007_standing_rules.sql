-- Standing rules (Phase 9.6)
-- Auto-approval rules created after repeated same-category approvals.

CREATE TABLE standing_rules (
  id TEXT PRIMARY KEY,
  action_pattern TEXT NOT NULL,        -- Glob pattern for action matching (e.g., 'file-manager:*')
  scope TEXT NOT NULL DEFAULT 'global', -- 'global' | 'conversation' | gear-specific
  verdict TEXT NOT NULL DEFAULT 'approve', -- 'approve' | 'deny'
  created_at TEXT NOT NULL,
  expires_at TEXT,                       -- Null means no expiry
  created_by TEXT NOT NULL DEFAULT 'system', -- 'system' | 'user'
  approval_count INTEGER NOT NULL DEFAULT 0  -- How many approvals triggered this rule
);

CREATE INDEX idx_standing_rules_pattern ON standing_rules(action_pattern);
CREATE INDEX idx_standing_rules_expires ON standing_rules(expires_at) WHERE expires_at IS NOT NULL;
