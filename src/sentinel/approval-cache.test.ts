// @meridian/sentinel — Approval Cache tests (Phase 11.4)

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ExecutionPlan, ValidationResult } from '@meridian/shared';
import { generateId } from '@meridian/shared';

import { ApprovalCache } from './approval-cache.js';
import type { ApprovalCacheLogger } from './approval-cache.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: generateId(),
    jobId: generateId(),
    steps: [
      {
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/report.txt' },
        riskLevel: 'low',
      },
    ],
    ...overrides,
  };
}

function createTestValidation(
  plan: ExecutionPlan,
  overrides?: Partial<ValidationResult>,
): ValidationResult {
  return {
    id: generateId(),
    planId: plan.id,
    verdict: 'approved',
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      verdict: 'approved' as const,
      riskLevel: step.riskLevel,
    })),
    overallRisk: 'low',
    ...overrides,
  };
}

function createTestLogger(): ApprovalCacheLogger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalCache', () => {
  let cache: ApprovalCache;
  let logger: ApprovalCacheLogger;

  beforeEach(() => {
    logger = createTestLogger();
    cache = new ApprovalCache({ logger });
  });

  describe('computePlanHash', () => {
    it('should produce consistent hashes for structurally identical plans', () => {
      const plan1 = createTestPlan({
        id: 'plan-1',
        jobId: 'job-1',
        steps: [
          {
            id: 'step-a',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      const plan2 = createTestPlan({
        id: 'plan-2',
        jobId: 'job-2',
        steps: [
          {
            id: 'step-a',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/two.txt' },
            riskLevel: 'low',
          },
        ],
      });

      // Same structure (gear, action, risk, param keys) but different param values
      const hash1 = cache.computePlanHash(plan1);
      const hash2 = cache.computePlanHash(plan2);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different gear', () => {
      const plan1 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      const plan2 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'web-fetch',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.computePlanHash(plan1)).not.toBe(cache.computePlanHash(plan2));
    });

    it('should produce different hashes for different actions', () => {
      const plan1 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      const plan2 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'write',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.computePlanHash(plan1)).not.toBe(cache.computePlanHash(plan2));
    });

    it('should produce different hashes for different risk levels', () => {
      const plan1 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      const plan2 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'medium',
          },
        ],
      });

      expect(cache.computePlanHash(plan1)).not.toBe(cache.computePlanHash(plan2));
    });

    it('should produce different hashes for different parameter schemas', () => {
      const plan1 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt' },
            riskLevel: 'low',
          },
        ],
      });

      const plan2 = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/one.txt', encoding: 'utf-8' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.computePlanHash(plan1)).not.toBe(cache.computePlanHash(plan2));
    });

    it('should produce consistent hashes regardless of step order field', () => {
      const plan1 = createTestPlan({
        steps: [
          {
            id: 'step-a',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data' },
            riskLevel: 'low',
            order: 1,
          },
          {
            id: 'step-b',
            gear: 'file-manager',
            action: 'write',
            parameters: { path: '/data' },
            riskLevel: 'low',
            order: 2,
          },
        ],
      });

      // Same steps but provided in different array order
      const plan2 = createTestPlan({
        steps: [
          {
            id: 'step-b',
            gear: 'file-manager',
            action: 'write',
            parameters: { path: '/data' },
            riskLevel: 'low',
            order: 2,
          },
          {
            id: 'step-a',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data' },
            riskLevel: 'low',
            order: 1,
          },
        ],
      });

      expect(cache.computePlanHash(plan1)).toBe(cache.computePlanHash(plan2));
    });
  });

  describe('store and lookup', () => {
    it('should store and retrieve an approved result', () => {
      const plan = createTestPlan();
      const validation = createTestValidation(plan);
      const hash = cache.computePlanHash(plan);

      cache.store(hash, validation);
      const result = cache.lookup(hash);

      expect(result).not.toBeNull();
      expect(result?.verdict).toBe('approved');
      expect(result?.planId).toBe(plan.id);
    });

    it('should return null for unknown hash', () => {
      const result = cache.lookup('nonexistent-hash');
      expect(result).toBeNull();
    });

    it('should NOT store rejected verdicts', () => {
      const plan = createTestPlan();
      const validation = createTestValidation(plan, { verdict: 'rejected' });
      const hash = cache.computePlanHash(plan);

      cache.store(hash, validation);
      const result = cache.lookup(hash);

      expect(result).toBeNull();
      expect(cache.stats().size).toBe(0);
    });

    it('should NOT store needs_user_approval verdicts', () => {
      const plan = createTestPlan();
      const validation = createTestValidation(plan, { verdict: 'needs_user_approval' });
      const hash = cache.computePlanHash(plan);

      cache.store(hash, validation);
      expect(cache.stats().size).toBe(0);
    });

    it('should NOT store needs_revision verdicts', () => {
      const plan = createTestPlan();
      const validation = createTestValidation(plan, { verdict: 'needs_revision' });
      const hash = cache.computePlanHash(plan);

      cache.store(hash, validation);
      expect(cache.stats().size).toBe(0);
    });

    it('should return null for expired entries', () => {
      const shortTtlCache = new ApprovalCache({ ttlMs: 1, logger });
      const plan = createTestPlan();
      const validation = createTestValidation(plan);
      const hash = shortTtlCache.computePlanHash(plan);

      shortTtlCache.store(hash, validation);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const result = shortTtlCache.lookup(hash);
          expect(result).toBeNull();
          resolve();
        }, 10);
      });
    });

    it('should evict oldest entry when at capacity', () => {
      const smallCache = new ApprovalCache({ maxEntries: 2, logger });

      const plan1 = createTestPlan({
        steps: [
          { id: 's1', gear: 'g1', action: 'a1', parameters: {}, riskLevel: 'low' },
        ],
      });
      const plan2 = createTestPlan({
        steps: [
          { id: 's2', gear: 'g2', action: 'a2', parameters: {}, riskLevel: 'low' },
        ],
      });
      const plan3 = createTestPlan({
        steps: [
          { id: 's3', gear: 'g3', action: 'a3', parameters: {}, riskLevel: 'low' },
        ],
      });

      const hash1 = smallCache.computePlanHash(plan1);
      const hash2 = smallCache.computePlanHash(plan2);
      const hash3 = smallCache.computePlanHash(plan3);

      smallCache.store(hash1, createTestValidation(plan1));
      smallCache.store(hash2, createTestValidation(plan2));
      smallCache.store(hash3, createTestValidation(plan3));

      // hash1 should have been evicted (oldest)
      expect(smallCache.lookup(hash1)).toBeNull();
      expect(smallCache.lookup(hash2)).not.toBeNull();
      expect(smallCache.lookup(hash3)).not.toBeNull();
    });

    it('should increment hit count on repeated lookups', () => {
      const plan = createTestPlan();
      const validation = createTestValidation(plan);
      const hash = cache.computePlanHash(plan);

      cache.store(hash, validation);

      cache.lookup(hash);
      cache.lookup(hash);
      cache.lookup(hash);

      const stats = cache.stats();
      expect(stats.hits).toBe(3);
    });
  });

  describe('isEligible', () => {
    it('should return true for scheduled tasks with low-risk steps', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 's1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data' },
            riskLevel: 'low',
          },
        ],
      });

      expect(cache.isEligible(plan, 'schedule')).toBe(true);
    });

    it('should return true for scheduled tasks with medium-risk steps', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 's1',
            gear: 'file-manager',
            action: 'write',
            parameters: { path: '/data' },
            riskLevel: 'medium',
          },
        ],
      });

      expect(cache.isEligible(plan, 'schedule')).toBe(true);
    });

    it('should return false for non-schedule sources', () => {
      const plan = createTestPlan();
      expect(cache.isEligible(plan, 'user')).toBe(false);
      expect(cache.isEligible(plan, 'webhook')).toBe(false);
      expect(cache.isEligible(plan, 'sub-job')).toBe(false);
    });

    it('should return false for plans with high-risk steps', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 's1',
            gear: 'shell',
            action: 'execute',
            parameters: { command: 'rm -rf /' },
            riskLevel: 'high',
          },
        ],
      });

      expect(cache.isEligible(plan, 'schedule')).toBe(false);
    });

    it('should return false for plans with critical-risk steps', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 's1',
            gear: 'shell',
            action: 'execute',
            parameters: { command: 'shutdown' },
            riskLevel: 'critical',
          },
        ],
      });

      expect(cache.isEligible(plan, 'schedule')).toBe(false);
    });

    it('should return false for plans with no steps', () => {
      const plan = createTestPlan({ steps: [] });
      expect(cache.isEligible(plan, 'schedule')).toBe(false);
    });

    it('should return false if any step is high risk', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 's1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data' },
            riskLevel: 'low',
          },
          {
            id: 's2',
            gear: 'shell',
            action: 'execute',
            parameters: { command: 'echo test' },
            riskLevel: 'high',
          },
        ],
      });

      expect(cache.isEligible(plan, 'schedule')).toBe(false);
    });
  });

  describe('prune', () => {
    it('should remove expired entries', () => {
      const shortTtlCache = new ApprovalCache({ ttlMs: 1, logger });
      const plan1 = createTestPlan({
        steps: [
          { id: 's1', gear: 'g1', action: 'a1', parameters: {}, riskLevel: 'low' },
        ],
      });
      const plan2 = createTestPlan({
        steps: [
          { id: 's2', gear: 'g2', action: 'a2', parameters: {}, riskLevel: 'low' },
        ],
      });

      shortTtlCache.store(
        shortTtlCache.computePlanHash(plan1),
        createTestValidation(plan1),
      );
      shortTtlCache.store(
        shortTtlCache.computePlanHash(plan2),
        createTestValidation(plan2),
      );

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
      const plan = createTestPlan();
      const hash = cache.computePlanHash(plan);
      cache.store(hash, createTestValidation(plan));

      const pruned = cache.prune();
      expect(pruned).toBe(0);
      expect(cache.stats().size).toBe(1);
    });
  });

  describe('stats', () => {
    it('should track hits and misses', () => {
      const plan = createTestPlan();
      const hash = cache.computePlanHash(plan);
      cache.store(hash, createTestValidation(plan));

      cache.lookup(hash);
      cache.lookup('nonexistent');
      cache.lookup('also-nonexistent');

      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all entries and reset stats', () => {
      const plan = createTestPlan();
      const hash = cache.computePlanHash(plan);
      cache.store(hash, createTestValidation(plan));

      cache.lookup(hash);
      cache.lookup('nonexistent');

      cache.clear();

      const stats = cache.stats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });
});
