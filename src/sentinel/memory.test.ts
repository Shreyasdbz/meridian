// @meridian/sentinel — Sentinel Memory tests (Phase 10.3)

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseClient, SENTINEL_MEMORY_CAP, ValidationError } from '@meridian/shared';

import {
  matchFileScope,
  matchFinancialScope,
  matchNetworkScope,
  SentinelMemory,
} from './memory.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;
let memory: SentinelMemory;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-sentinel-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();
  await db.open('sentinel');

  // Run schema
  await db.exec('sentinel', `
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny')),
      job_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      conditions TEXT,
      metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_action_scope ON decisions(action_type, scope);
    CREATE INDEX IF NOT EXISTS idx_decisions_expires ON decisions(expires_at) WHERE expires_at IS NOT NULL;
  `);

  memory = new SentinelMemory({ db });
});

afterEach(async () => {
  await db.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Decision storage
// ---------------------------------------------------------------------------

describe('SentinelMemory', () => {
  describe('storeDecision', () => {
    it('should store and retrieve a decision', async () => {
      const decision = await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
      });

      expect(decision.id).toBeTruthy();
      expect(decision.actionType).toBe('file.read');
      expect(decision.scope).toBe('/data/workspace');
      expect(decision.verdict).toBe('allow');

      const retrieved = await memory.getDecision(decision.id);
      expect(retrieved).toBeTruthy();
      expect((retrieved as NonNullable<typeof retrieved>).actionType).toBe('file.read');
    });

    it('should reject shell.execute action type', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.execute',
          scope: 'ls -la',
          verdict: 'allow',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject shell.run action type', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.run',
          scope: 'rm -rf /',
          verdict: 'allow',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should reject shell.exec action type', async () => {
      await expect(
        memory.storeDecision({
          actionType: 'shell.exec',
          scope: 'cat /etc/passwd',
          verdict: 'allow',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should store deny decisions', async () => {
      const decision = await memory.storeDecision({
        actionType: 'network.request',
        scope: 'evil.com',
        verdict: 'deny',
      });

      expect(decision.verdict).toBe('deny');
    });

    it('should store decisions with metadata', async () => {
      const decision = await memory.storeDecision({
        actionType: 'file.write',
        scope: '/data/workspace/output',
        verdict: 'allow',
        metadata: { reason: 'User approved', trust: 'high' },
      });

      const retrieved = await memory.getDecision(decision.id);
      expect((retrieved as NonNullable<typeof retrieved>).metadata).toEqual({ reason: 'User approved', trust: 'high' });
    });
  });

  // -------------------------------------------------------------------------
  // Finding matches
  // -------------------------------------------------------------------------

  describe('findMatch', () => {
    it('should match exact action type and scope', async () => {
      await memory.storeDecision({
        actionType: 'network.request',
        scope: 'api.example.com',
        verdict: 'allow',
      });

      const result = await memory.findMatch('network.request', 'api.example.com');
      expect(result.matched).toBe(true);
      expect((result.decision as NonNullable<typeof result.decision>).verdict).toBe('allow');
    });

    it('should not match different action type', async () => {
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
      });

      const result = await memory.findMatch('file.write', '/data/workspace');
      expect(result.matched).toBe(false);
    });

    it('should match file operations with prefix', async () => {
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
      });

      const result = await memory.findMatch('file.read', '/data/workspace/subdir/file.txt');
      expect(result.matched).toBe(true);
    });

    it('should not match expired decisions', async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
        expiresAt: pastDate,
      });

      const result = await memory.findMatch('file.read', '/data/workspace/file.txt');
      expect(result.matched).toBe(false);
    });

    it('should match non-expired decisions', async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/workspace',
        verdict: 'allow',
        expiresAt: futureDate,
      });

      const result = await memory.findMatch('file.read', '/data/workspace/file.txt');
      expect(result.matched).toBe(true);
    });

    it('should return most recent decision for overlapping matches', async () => {
      await memory.storeDecision({
        actionType: 'network.request',
        scope: 'api.example.com',
        verdict: 'allow',
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));

      await memory.storeDecision({
        actionType: 'network.request',
        scope: 'api.example.com',
        verdict: 'deny',
      });

      const result = await memory.findMatch('network.request', 'api.example.com');
      expect(result.matched).toBe(true);
      expect((result.decision as NonNullable<typeof result.decision>).verdict).toBe('deny');
    });

    it('should match financial with numeric comparison', async () => {
      await memory.storeDecision({
        actionType: 'financial.transfer',
        scope: '100.00',
        verdict: 'allow',
      });

      const within = await memory.findMatch('financial.transfer', '50.00');
      expect(within.matched).toBe(true);

      const over = await memory.findMatch('financial.transfer', '150.00');
      expect(over.matched).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Deletion and pruning
  // -------------------------------------------------------------------------

  describe('deletion', () => {
    it('should delete a decision', async () => {
      const decision = await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data',
        verdict: 'allow',
      });

      await memory.deleteDecision(decision.id);

      const retrieved = await memory.getDecision(decision.id);
      expect(retrieved).toBeUndefined();
    });

    it('should throw NotFoundError for non-existent delete', async () => {
      await expect(memory.deleteDecision('non-existent')).rejects.toThrow('not found');
    });
  });

  describe('pruneExpired', () => {
    it('should prune expired decisions', async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data',
        verdict: 'allow',
        expiresAt: pastDate,
      });

      const activeDecision = await memory.storeDecision({
        actionType: 'file.write',
        scope: '/data',
        verdict: 'allow',
      });

      const pruned = await memory.pruneExpired();
      expect(pruned).toBe(1);

      const remaining = await memory.listActiveDecisions();
      expect(remaining).toHaveLength(1);
      expect((remaining[0] as (typeof remaining)[number]).id).toBe(activeDecision.id);
    });
  });

  // -------------------------------------------------------------------------
  // Cap enforcement
  // -------------------------------------------------------------------------

  describe('cap enforcement', () => {
    it('should enforce the cap by evicting oldest', async () => {
      // Store cap + 1 decisions
      for (let i = 0; i < SENTINEL_MEMORY_CAP + 1; i++) {
        await memory.storeDecision({
          actionType: 'file.read',
          scope: `/data/path-${i}`,
          verdict: 'allow',
        });
      }

      const count = await memory.countActive();
      expect(count).toBe(SENTINEL_MEMORY_CAP);
    });
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  describe('listActiveDecisions', () => {
    it('should list all active decisions', async () => {
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/a',
        verdict: 'allow',
      });
      await memory.storeDecision({
        actionType: 'file.write',
        scope: '/data/b',
        verdict: 'deny',
      });

      const decisions = await memory.listActiveDecisions();
      expect(decisions).toHaveLength(2);
    });

    it('should exclude expired decisions from listing', async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/expired',
        verdict: 'allow',
        expiresAt: pastDate,
      });
      await memory.storeDecision({
        actionType: 'file.read',
        scope: '/data/active',
        verdict: 'allow',
      });

      const decisions = await memory.listActiveDecisions();
      expect(decisions).toHaveLength(1);
      expect((decisions[0] as (typeof decisions)[number]).scope).toBe('/data/active');
    });
  });
});

// ---------------------------------------------------------------------------
// Scope matching unit tests
// ---------------------------------------------------------------------------

describe('matchFileScope', () => {
  it('should match exact path', () => {
    expect(matchFileScope('/data/workspace', '/data/workspace')).toBe(true);
  });

  it('should match subdirectory', () => {
    expect(matchFileScope('/data/workspace', '/data/workspace/file.txt')).toBe(true);
    expect(matchFileScope('/data/workspace', '/data/workspace/sub/deep/file.txt')).toBe(true);
  });

  it('should not match non-boundary prefix', () => {
    // /data/workspace should NOT match /data/workspacetoo
    expect(matchFileScope('/data/workspace', '/data/workspacetoo/file.txt')).toBe(false);
  });

  it('should handle trailing slashes', () => {
    expect(matchFileScope('/data/workspace/', '/data/workspace/file.txt')).toBe(true);
  });

  it('should not match parent directory', () => {
    expect(matchFileScope('/data/workspace/sub', '/data/workspace')).toBe(false);
  });
});

describe('matchNetworkScope', () => {
  it('should match exact domain case-insensitively', () => {
    expect(matchNetworkScope('api.example.com', 'API.Example.COM')).toBe(true);
  });

  it('should not match different domain', () => {
    expect(matchNetworkScope('api.example.com', 'evil.com')).toBe(false);
  });

  it('should not match subdomain', () => {
    expect(matchNetworkScope('example.com', 'sub.example.com')).toBe(false);
  });
});

describe('matchFinancialScope', () => {
  it('should match when request amount is within limit', () => {
    expect(matchFinancialScope('100.00', '50.00')).toBe(true);
    expect(matchFinancialScope('100.00', '100.00')).toBe(true);
  });

  it('should not match when request exceeds limit', () => {
    expect(matchFinancialScope('100.00', '150.00')).toBe(false);
  });

  it('should return false for non-numeric scopes', () => {
    expect(matchFinancialScope('abc', '50.00')).toBe(false);
    expect(matchFinancialScope('100.00', 'abc')).toBe(false);
  });
});
