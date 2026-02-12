-- Phase 2.3: Request Deduplication — Make dedup_hash index unique
-- Architecture Reference: Section 5.1.9
--
-- The original idx_jobs_dedup was a non-unique index. The architecture requires
-- a UNIQUE partial index to atomically prevent duplicate job creation within
-- the same dedup window.

DROP INDEX IF EXISTS idx_jobs_dedup;
CREATE UNIQUE INDEX idx_jobs_dedup ON jobs(dedup_hash)
  WHERE status NOT IN ('completed', 'failed', 'cancelled');
