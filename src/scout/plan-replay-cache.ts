// @meridian/scout — Plan Replay Cache (Phase 11.4)
//
// Caches execution plans for repeated scheduled tasks to skip Scout's LLM call.
// Only caches plans from scheduled sources with deterministic operations that
// have been previously approved by Sentinel.
//
// Architecture references:
// - Section 16 Phase 4 (Plan Replay Cache)
// - Section 5.2 (Scout — Planner LLM)

import { createHash } from 'node:crypto';

import type { ExecutionPlan, PlanReplayCacheEntry } from '@meridian/shared';
import {
  generateId,
  PLAN_REPLAY_CACHE_MAX_ENTRIES,
  PLAN_REPLAY_CACHE_TTL_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanReplayCacheConfig {
  maxEntries?: number;
  ttlMs?: number;
  logger?: PlanReplayCacheLogger;
}

export interface PlanReplayCacheLogger {
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Gear actions considered non-deterministic (output varies with external state).
 * Plans containing only deterministic Gear actions are eligible for caching.
 */
const NON_DETERMINISTIC_GEARS: ReadonlySet<string> = new Set([
  'web-search',
  'web-fetch',
]);

/**
 * Parameter names that indicate time-sensitive values.
 * Plans with these parameters in their steps are not cacheable.
 */
const TIME_SENSITIVE_PARAMS: ReadonlySet<string> = new Set([
  'timestamp',
  'date',
  'time',
  'now',
  'currentdate',
  'currenttime',
  'today',
  'datetime',
]);

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: PlanReplayCacheLogger = {
  info: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// PlanReplayCache
// ---------------------------------------------------------------------------

/**
 * PlanReplayCache — skip Scout for known patterns.
 *
 * Caches execution plans that were successfully executed from scheduled tasks.
 * When the same scheduled task fires again with identical input, the cached
 * plan is returned directly, bypassing the LLM call entirely.
 *
 * Cacheability criteria:
 * - Plan source is 'schedule' (repeated scheduled tasks)
 * - Plan has no time-sensitive parameters
 * - Plan steps use only deterministic Gear operations
 * - Plan was previously approved by Sentinel (has approvalHash)
 */
export class PlanReplayCache {
  private readonly cache = new Map<string, PlanReplayCacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly logger: PlanReplayCacheLogger;
  private totalHits = 0;
  private totalMisses = 0;

  constructor(config?: PlanReplayCacheConfig) {
    this.maxEntries = config?.maxEntries ?? PLAN_REPLAY_CACHE_MAX_ENTRIES;
    this.ttlMs = config?.ttlMs ?? PLAN_REPLAY_CACHE_TTL_MS;
    this.logger = config?.logger ?? noopLogger;
  }

  /**
   * Compute a normalized input hash from the user message and relevant context.
   * Used as the cache key. Normalizes whitespace, lowercases, and strips timestamps.
   */
  computeInputHash(input: { userMessage: string; gearCatalog?: string[] }): string {
    const normalized = this.normalizeInput(input.userMessage);

    const parts: string[] = [normalized];
    if (input.gearCatalog && input.gearCatalog.length > 0) {
      parts.push(input.gearCatalog.slice().sort().join(','));
    }

    return createHash('sha256').update(parts.join('|')).digest('hex');
  }

  /**
   * Look up a cached plan. Returns null if not found or expired.
   */
  lookup(inputHash: string): ExecutionPlan | null {
    const entry = this.cache.get(inputHash);

    if (!entry) {
      this.totalMisses++;
      this.logger.debug('Plan replay cache miss', { inputHash });
      return null;
    }

    // Check expiration
    const now = Date.now();
    const createdAt = new Date(entry.createdAt).getTime();
    if (now - createdAt > this.ttlMs) {
      this.cache.delete(inputHash);
      this.totalMisses++;
      this.logger.debug('Plan replay cache entry expired', {
        inputHash,
        age: now - createdAt,
        ttl: this.ttlMs,
      });
      return null;
    }

    this.totalHits++;
    this.logger.info('Plan replay cache hit', {
      inputHash,
      planId: entry.plan.id,
      hitCount: entry.hitCount,
    });

    return entry.plan;
  }

  /**
   * Store a plan in the cache after successful execution.
   * Only stores plans that are "cacheable" (scheduled tasks, deterministic operations).
   */
  store(inputHash: string, plan: ExecutionPlan, approvalHash?: string): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    const now = new Date().toISOString();
    const entry: PlanReplayCacheEntry = {
      id: generateId(),
      inputHash,
      plan,
      approvalHash,
      createdAt: now,
      hitCount: 0,
      lastHitAt: now,
    };

    this.cache.set(inputHash, entry);
    this.logger.info('Stored plan in replay cache', {
      inputHash,
      planId: plan.id,
      approvalHash,
      cacheSize: this.cache.size,
    });
  }

  /**
   * Check if a plan is cacheable.
   *
   * Criteria:
   * - Source is 'schedule' (repeated scheduled tasks)
   * - No time-sensitive parameters in any step
   * - All steps use deterministic Gear operations
   * - Plan was previously approved (has approvalHash)
   */
  isCacheable(plan: ExecutionPlan, source: string): boolean {
    // Only cache plans from scheduled sources
    if (source !== 'schedule') {
      return false;
    }

    // Must have steps
    if (plan.steps.length === 0) {
      return false;
    }

    for (const step of plan.steps) {
      // Check for non-deterministic Gear
      if (NON_DETERMINISTIC_GEARS.has(step.gear)) {
        return false;
      }

      // Check for time-sensitive parameters
      for (const paramKey of Object.keys(step.parameters)) {
        if (TIME_SENSITIVE_PARAMS.has(paramKey.toLowerCase())) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Record a cache hit — increments the hit counter and updates lastHitAt.
   */
  recordHit(inputHash: string): void {
    const entry = this.cache.get(inputHash);
    if (entry) {
      entry.hitCount++;
      entry.lastHitAt = new Date().toISOString();
    }
  }

  /**
   * Evict expired entries. Returns the number of entries removed.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache) {
      const createdAt = new Date(entry.createdAt).getTime();
      if (now - createdAt > this.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.info('Pruned expired plan replay cache entries', {
        pruned,
        remaining: this.cache.size,
      });
    }

    return pruned;
  }

  /**
   * Get cache statistics.
   */
  stats(): { size: number; hitRate: number; totalHits: number; totalMisses: number } {
    const total = this.totalHits + this.totalMisses;
    return {
      size: this.cache.size,
      hitRate: total > 0 ? this.totalHits / total : 0,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
    };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.totalHits = 0;
    this.totalMisses = 0;
    this.logger.info('Plan replay cache cleared');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalize input text for consistent hashing.
   * - Lowercases
   * - Collapses whitespace
   * - Strips common timestamp patterns (ISO 8601, Unix timestamps)
   */
  private normalizeInput(text: string): string {
    let normalized = text.trim();

    // Strip ISO 8601 timestamps BEFORE lowercasing (e.g., 2026-02-14T12:00:00.000Z)
    normalized = normalized.replace(
      /\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?/g,
      '',
    );

    // Strip Unix timestamps (10+ digits)
    normalized = normalized.replace(/\b\d{10,13}\b/g, '');

    // Lowercase after timestamp removal
    normalized = normalized.toLowerCase();

    // Collapse multiple whitespace to single space
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
  }

  /**
   * Evict the oldest entry (by createdAt) when cache is at capacity.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      const createdAt = new Date(entry.createdAt).getTime();
      if (createdAt < oldestTime) {
        oldestTime = createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.logger.debug('Evicted oldest plan replay cache entry', {
        inputHash: oldestKey,
      });
    }
  }
}
