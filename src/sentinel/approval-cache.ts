// @meridian/sentinel — Approval Cache (Phase 11.4)
//
// Caches Sentinel approval decisions for identical plan structures from
// scheduled tasks. When a scheduled task produces a plan with the same
// structural hash as a previously approved plan, the cached approval
// is returned without running Sentinel validation again.
//
// INFORMATION BARRIER: This cache only stores plan structure hashes and
// validation results. It does NOT store user messages, Journal data,
// or Gear catalog information.
//
// Architecture references:
// - Section 5.3 (Sentinel — Safety Validator)
// - Section 5.3.5 (Risk Policies)

import { createHash } from 'node:crypto';

import type { ExecutionPlan, ValidationResult } from '@meridian/shared';
import {
  SENTINEL_APPROVAL_CACHE_MAX_ENTRIES,
  SENTINEL_APPROVAL_CACHE_TTL_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalCacheConfig {
  maxEntries?: number;
  ttlMs?: number;
  logger?: ApprovalCacheLogger;
}

export interface ApprovalCacheLogger {
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

interface CachedApproval {
  result: ValidationResult;
  createdAt: number;
  hitCount: number;
}

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: ApprovalCacheLogger = {
  info: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// ApprovalCache
// ---------------------------------------------------------------------------

/**
 * ApprovalCache — reuse cached approvals for identical scheduled task plans.
 *
 * Computes a deterministic hash of a plan's structure (Gear IDs, action names,
 * parameter schemas) and caches the Sentinel approval result. For scheduled
 * tasks that produce structurally identical plans, the cached approval is
 * returned immediately.
 *
 * This is safe because:
 * - Only scheduled/repeated tasks are eligible (predictable patterns)
 * - The hash captures the plan's security-relevant structure
 * - Cached approvals expire after TTL (default 24 hours)
 * - Only 'approved' verdicts are cached (rejections are not)
 */
export class ApprovalCache {
  private readonly cache = new Map<string, CachedApproval>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly logger: ApprovalCacheLogger;
  private hits = 0;
  private misses = 0;

  constructor(config?: ApprovalCacheConfig) {
    this.maxEntries = config?.maxEntries ?? SENTINEL_APPROVAL_CACHE_MAX_ENTRIES;
    this.ttlMs = config?.ttlMs ?? SENTINEL_APPROVAL_CACHE_TTL_MS;
    this.logger = config?.logger ?? noopLogger;
  }

  /**
   * Compute a deterministic hash of a plan's security-relevant structure.
   *
   * Hashes:
   * - Step gear IDs (which plugins are used)
   * - Action names (what operations are performed)
   * - Parameter keys (what data shapes are involved, not values)
   * - Risk levels (declared risk of each step)
   * - Step order (order matters for security assessment)
   *
   * Parameter values are NOT included because scheduled tasks may have
   * the same structure but different runtime values.
   */
  computePlanHash(plan: ExecutionPlan): string {
    const hash = createHash('sha256');

    // Sort steps by their ID for deterministic ordering when no explicit order
    const sortedSteps = [...plan.steps].sort((a, b) => {
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });

    for (const step of sortedSteps) {
      hash.update(step.gear);
      hash.update(':');
      hash.update(step.action);
      hash.update(':');
      hash.update(step.riskLevel);
      hash.update(':');

      // Hash parameter keys (sorted for determinism)
      const paramKeys = Object.keys(step.parameters).sort();
      hash.update(paramKeys.join(','));
      hash.update('|');
    }

    return hash.digest('hex');
  }

  /**
   * Look up a cached approval for a plan.
   * Returns null if not found, expired, or the cached verdict was not 'approved'.
   */
  lookup(planHash: string): ValidationResult | null {
    const entry = this.cache.get(planHash);

    if (!entry) {
      this.misses++;
      this.logger.debug('Approval cache miss', { planHash });
      return null;
    }

    // Check expiration
    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.cache.delete(planHash);
      this.misses++;
      this.logger.debug('Approval cache entry expired', {
        planHash,
        age: now - entry.createdAt,
        ttl: this.ttlMs,
      });
      return null;
    }

    // Record hit
    entry.hitCount++;
    this.hits++;

    this.logger.info('Approval cache hit', {
      planHash,
      verdict: entry.result.verdict,
      hitCount: entry.hitCount,
    });

    return entry.result;
  }

  /**
   * Store an approval result in the cache.
   *
   * Only stores 'approved' verdicts. Rejections, needs_user_approval, and
   * needs_revision verdicts are NOT cached to ensure they are always
   * freshly evaluated.
   */
  store(planHash: string, result: ValidationResult): void {
    // Only cache approved results
    if (result.verdict !== 'approved') {
      this.logger.debug('Skipping cache store for non-approved verdict', {
        planHash,
        verdict: result.verdict,
      });
      return;
    }

    // Evict if at capacity
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(planHash, {
      result,
      createdAt: Date.now(),
      hitCount: 0,
    });

    this.logger.info('Stored approval in cache', {
      planHash,
      verdict: result.verdict,
      cacheSize: this.cache.size,
    });
  }

  /**
   * Check if a plan is eligible for approval caching.
   *
   * Eligibility criteria:
   * - Source is 'schedule' (scheduled/repeated tasks)
   * - Plan has at least one step
   * - No high or critical risk steps (only low/medium are auto-cacheable)
   */
  isEligible(plan: ExecutionPlan, source: string): boolean {
    // Only scheduled tasks are eligible
    if (source !== 'schedule') {
      return false;
    }

    // Must have steps
    if (plan.steps.length === 0) {
      return false;
    }

    // High/critical risk plans should always be freshly validated
    for (const step of plan.steps) {
      if (step.riskLevel === 'high' || step.riskLevel === 'critical') {
        return false;
      }
    }

    return true;
  }

  /**
   * Evict expired entries. Returns the number of entries removed.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.info('Pruned expired approval cache entries', {
        pruned,
        remaining: this.cache.size,
      });
    }

    return pruned;
  }

  /**
   * Clear the entire cache and reset statistics.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.logger.info('Approval cache cleared');
  }

  /**
   * Get cache statistics.
   */
  stats(): { size: number; hits: number; misses: number } {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evict the oldest entry (by createdAt) when cache is at capacity.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.logger.debug('Evicted oldest approval cache entry', {
        planHash: oldestKey,
      });
    }
  }
}
