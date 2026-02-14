// @meridian/scout — Plan Replay Cache tests (Phase 11.4)

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ExecutionPlan } from '@meridian/shared';
import { generateId } from '@meridian/shared';

import { PlanReplayCache } from './plan-replay-cache.js';
import type { PlanReplayCacheLogger } from './plan-replay-cache.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: generateId(),
    jobId: generateId(),
    steps: [
      {
        id: generateId(),
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/report.txt' },
        riskLevel: 'low',
      },
    ],
    ...overrides,
  };
}

function createTestLogger(): PlanReplayCacheLogger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanReplayCache', () => {
  let cache: PlanReplayCache;
  let logger: PlanReplayCacheLogger;

  beforeEach(() => {
    logger = createTestLogger();
    cache = new PlanReplayCache({ logger });
  });

  describe('computeInputHash', () => {
    it('should produce consistent hashes for identical inputs', () => {
      const hash1 = cache.computeInputHash({ userMessage: 'backup database' });
      const hash2 = cache.computeInputHash({ userMessage: 'backup database' });
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = cache.computeInputHash({ userMessage: 'backup database' });
      const hash2 = cache.computeInputHash({ userMessage: 'restore database' });
      expect(hash1).not.toBe(hash2);
    });

    it('should normalize whitespace in input', () => {
      const hash1 = cache.computeInputHash({ userMessage: 'backup   database' });
      const hash2 = cache.computeInputHash({ userMessage: 'backup database' });
      expect(hash1).toBe(hash2);
    });

    it('should be case-insensitive', () => {
      const hash1 = cache.computeInputHash({ userMessage: 'Backup Database' });
      const hash2 = cache.computeInputHash({ userMessage: 'backup database' });
      expect(hash1).toBe(hash2);
    });

    it('should strip ISO 8601 timestamps', () => {
      const hash1 = cache.computeInputHash({
        userMessage: 'backup database at 2026-02-14T12:00:00.000Z',
      });
      const hash2 = cache.computeInputHash({
        userMessage: 'backup database at 2026-03-01T08:30:00.000Z',
      });
      expect(hash1).toBe(hash2);
    });

    it('should strip Unix timestamps', () => {
      const hash1 = cache.computeInputHash({
        userMessage: 'backup database 1707900000000',
      });
      const hash2 = cache.computeInputHash({
        userMessage: 'backup database 1707986400000',
      });
      expect(hash1).toBe(hash2);
    });

    it('should include gear catalog in hash when provided', () => {
      const hash1 = cache.computeInputHash({
        userMessage: 'backup database',
        gearCatalog: ['file-manager'],
      });
      const hash2 = cache.computeInputHash({
        userMessage: 'backup database',
        gearCatalog: ['file-manager', 'web-fetch'],
      });
      expect(hash1).not.toBe(hash2);
    });

    it('should produce consistent hash regardless of gear catalog order', () => {
      const hash1 = cache.computeInputHash({
        userMessage: 'backup',
        gearCatalog: ['file-manager', 'web-fetch'],
      });
      const hash2 = cache.computeInputHash({
        userMessage: 'backup',
        gearCatalog: ['web-fetch', 'file-manager'],
      });
      expect(hash1).toBe(hash2);
    });
  });

  describe('store and lookup', () => {
    it('should store and retrieve a plan', () => {
      const plan = createTestPlan();
      const hash = 'test-hash-1';

      cache.store(hash, plan);
      const result = cache.lookup(hash);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(plan.id);
      expect(result?.steps).toEqual(plan.steps);
    });

    it('should return null for unknown hash', () => {
      const result = cache.lookup('nonexistent-hash');
      expect(result).toBeNull();
    });

    it('should store approval hash alongside plan', () => {
      const plan = createTestPlan();
      const hash = 'test-hash-2';
      const approvalHash = 'approval-123';

      cache.store(hash, plan, approvalHash);
      const result = cache.lookup(hash);
      expect(result).not.toBeNull();
    });

    it('should return null for expired entries', () => {
      const shortTtlCache = new PlanReplayCache({ ttlMs: 1, logger });
      const plan = createTestPlan();
      const hash = 'test-hash-3';

      shortTtlCache.store(hash, plan);

      // Wait for expiration
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const result = shortTtlCache.lookup(hash);
          expect(result).toBeNull();
          resolve();
        }, 10);
      });
    });

    it('should evict oldest entry when at capacity', () => {
      const smallCache = new PlanReplayCache({ maxEntries: 2, logger });
      const plan1 = createTestPlan();
      const plan2 = createTestPlan();
      const plan3 = createTestPlan();

      smallCache.store('hash-1', plan1);
      smallCache.store('hash-2', plan2);
      smallCache.store('hash-3', plan3);

      // hash-1 should have been evicted
      expect(smallCache.lookup('hash-1')).toBeNull();
      expect(smallCache.lookup('hash-2')).not.toBeNull();
      expect(smallCache.lookup('hash-3')).not.toBeNull();
    });
  });

  describe('isCacheable', () => {
    it('should return true for scheduled tasks with deterministic steps', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: generateId(),
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/report.txt' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.isCacheable(plan, 'schedule')).toBe(true);
    });

    it('should return false for non-schedule sources', () => {
      const plan = createTestPlan();
      expect(cache.isCacheable(plan, 'user')).toBe(false);
      expect(cache.isCacheable(plan, 'webhook')).toBe(false);
      expect(cache.isCacheable(plan, 'sub-job')).toBe(false);
    });

    it('should return false for plans with non-deterministic gear', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: generateId(),
            gear: 'web-search',
            action: 'search',
            parameters: { query: 'test' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.isCacheable(plan, 'schedule')).toBe(false);
    });

    it('should return false for plans with web-fetch gear', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: generateId(),
            gear: 'web-fetch',
            action: 'get',
            parameters: { url: 'https://example.com' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.isCacheable(plan, 'schedule')).toBe(false);
    });

    it('should return false for plans with time-sensitive parameters', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: generateId(),
            gear: 'file-manager',
            action: 'write',
            parameters: { path: '/data/log.txt', timestamp: '2026-02-14' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.isCacheable(plan, 'schedule')).toBe(false);
    });

    it('should return false for plans with no steps', () => {
      const plan = createTestPlan({ steps: [] });
      expect(cache.isCacheable(plan, 'schedule')).toBe(false);
    });

    it('should detect time-sensitive parameter names case-insensitively', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: generateId(),
            gear: 'file-manager',
            action: 'write',
            parameters: { path: '/data/log.txt', CurrentDate: '2026-02-14' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.isCacheable(plan, 'schedule')).toBe(false);
    });
  });

  describe('recordHit', () => {
    it('should increment hit count on existing entry', () => {
      const plan = createTestPlan();
      const hash = 'test-hash-hit';

      cache.store(hash, plan);

      // First lookup (triggers internal totalHits++)
      cache.lookup(hash);
      cache.recordHit(hash);
      cache.recordHit(hash);

      const stats = cache.stats();
      expect(stats.totalHits).toBe(1);
    });

    it('should be a no-op for non-existent hash', () => {
      // Should not throw
      cache.recordHit('nonexistent');
    });
  });

  describe('prune', () => {
    it('should remove expired entries', () => {
      const shortTtlCache = new PlanReplayCache({ ttlMs: 1, logger });

      shortTtlCache.store('hash-1', createTestPlan());
      shortTtlCache.store('hash-2', createTestPlan());

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const pruned = shortTtlCache.prune();
          expect(pruned).toBe(2);
          expect(shortTtlCache.stats().size).toBe(0);
          resolve();
        }, 10);
      });
    });

    it('should not remove non-expired entries', () => {
      cache.store('hash-1', createTestPlan());
      cache.store('hash-2', createTestPlan());

      const pruned = cache.prune();
      expect(pruned).toBe(0);
      expect(cache.stats().size).toBe(2);
    });
  });

  describe('stats', () => {
    it('should track hits and misses', () => {
      const plan = createTestPlan();
      cache.store('found', plan);

      cache.lookup('found');
      cache.lookup('not-found');
      cache.lookup('also-not-found');

      const stats = cache.stats();
      expect(stats.totalHits).toBe(1);
      expect(stats.totalMisses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(1 / 3);
      expect(stats.size).toBe(1);
    });

    it('should return 0 hit rate when no lookups', () => {
      const stats = cache.stats();
      expect(stats.hitRate).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all entries and reset stats', () => {
      cache.store('hash-1', createTestPlan());
      cache.store('hash-2', createTestPlan());
      cache.lookup('hash-1');
      cache.lookup('missing');

      cache.clear();

      const stats = cache.stats();
      expect(stats.size).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
    });
  });
});
