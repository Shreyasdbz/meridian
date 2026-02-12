-- Job Queue Columns — Phase 2.2
-- Adds columns required for job queue CAS claiming, cycle limit tracking,
-- and typed-with-metadata pattern support.

ALTER TABLE jobs ADD COLUMN worker_id TEXT;
ALTER TABLE jobs ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL);
