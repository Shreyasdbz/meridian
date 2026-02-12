// @meridian/axis — Request deduplication (Section 5.1.9)
//
// Prevents duplicate job creation from rapid resubmission (double-clicks,
// retries, network hiccups) by hashing the request content within a time
// window and checking for existing non-terminal jobs with the same hash.

import { createHash } from 'node:crypto';

import type { DatabaseClient } from '@meridian/shared';
import { DEDUP_WINDOW_MS } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 deduplication hash for a request.
 *
 * The hash is derived from the user ID, message content, and a time window
 * (floor(timestamp / DEDUP_WINDOW_MS)). Requests within the same 5-second
 * window with identical user + content produce the same hash.
 *
 * @param userId - The submitting user's ID
 * @param content - The normalized message content
 * @param timestamp - Unix epoch ms (defaults to Date.now())
 * @returns Hex-encoded SHA-256 hash
 */
export function computeDedupHash(
  userId: string,
  content: string,
  timestamp?: number,
): string {
  const ts = timestamp ?? Date.now();
  const window = Math.floor(ts / DEDUP_WINDOW_MS);
  const input = `${userId}\0${content}\0${window}`;
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Find an existing non-terminal job with the given dedup hash.
 *
 * If a match is found, the caller should return the existing job ID to the
 * user instead of creating a new job. The UNIQUE partial index on
 * `jobs(dedup_hash)` ensures atomicity — concurrent insertions with the
 * same hash will fail at the database level.
 *
 * @param db - Database client
 * @param dedupHash - The SHA-256 dedup hash to check
 * @returns The existing job ID if a non-terminal duplicate exists, undefined otherwise
 */
export async function findDuplicateJobId(
  db: DatabaseClient,
  dedupHash: string,
): Promise<string | undefined> {
  const rows = await db.query<{ id: string }>(
    'meridian',
    `SELECT id FROM jobs
     WHERE dedup_hash = ?
       AND status NOT IN ('completed', 'failed', 'cancelled')
     LIMIT 1`,
    [dedupHash],
  );

  const first = rows[0];
  return first !== undefined ? first.id : undefined;
}
