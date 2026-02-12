import { describe, it, expect, vi, beforeEach } from 'vitest';

import { configureConnection } from './configure.js';
import type { DeploymentTier } from './types.js';

// Mock better-sqlite3 Database
function createMockDb(): { pragma: ReturnType<typeof vi.fn>; pragmaCalls: string[] } {
  const pragmaCalls: string[] = [];
  const pragma = vi.fn((statement: string) => {
    pragmaCalls.push(statement);
    return undefined;
  });
  return { pragma, pragmaCalls };
}

describe('configureConnection', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should set all required PRAGMAs for a non-audit database', () => {
    configureConnection(mockDb as unknown as Parameters<typeof configureConnection>[0], 'desktop');

    const calls = mockDb.pragmaCalls;
    expect(calls).toContain('journal_mode = WAL');
    expect(calls).toContain('synchronous = NORMAL');
    expect(calls).toContain('busy_timeout = 5000');
    expect(calls).toContain('foreign_keys = ON');
    expect(calls).toContain('auto_vacuum = INCREMENTAL');
    expect(calls).toContain('temp_store = MEMORY');
  });

  it('should use synchronous = FULL for audit databases', () => {
    configureConnection(
      mockDb as unknown as Parameters<typeof configureConnection>[0],
      'desktop',
      true,
    );

    expect(mockDb.pragmaCalls).toContain('synchronous = FULL');
    expect(mockDb.pragmaCalls).not.toContain('synchronous = NORMAL');
  });

  it('should use synchronous = NORMAL for non-audit databases', () => {
    configureConnection(
      mockDb as unknown as Parameters<typeof configureConnection>[0],
      'desktop',
      false,
    );

    expect(mockDb.pragmaCalls).toContain('synchronous = NORMAL');
    expect(mockDb.pragmaCalls).not.toContain('synchronous = FULL');
  });

  it('should set desktop/vps tier cache and mmap sizes', () => {
    configureConnection(mockDb as unknown as Parameters<typeof configureConnection>[0], 'desktop');

    expect(mockDb.pragmaCalls).toContain('cache_size = -20000');
    expect(mockDb.pragmaCalls).toContain('mmap_size = 268435456');
  });

  it('should set VPS tier cache and mmap sizes (same as desktop)', () => {
    configureConnection(mockDb as unknown as Parameters<typeof configureConnection>[0], 'vps');

    expect(mockDb.pragmaCalls).toContain('cache_size = -20000');
    expect(mockDb.pragmaCalls).toContain('mmap_size = 268435456');
  });

  it('should set Raspberry Pi tier cache and mmap sizes', () => {
    configureConnection(mockDb as unknown as Parameters<typeof configureConnection>[0], 'pi');

    expect(mockDb.pragmaCalls).toContain('cache_size = -8000');
    expect(mockDb.pragmaCalls).toContain('mmap_size = 67108864');
  });

  it('should set exactly 8 PRAGMAs', () => {
    configureConnection(mockDb as unknown as Parameters<typeof configureConnection>[0], 'desktop');

    // 6 core + 2 tier-specific = 8 total
    expect(mockDb.pragma).toHaveBeenCalledTimes(8);
  });

  it('should apply PRAGMAs for all deployment tiers', () => {
    const tiers: DeploymentTier[] = ['pi', 'desktop', 'vps'];

    for (const tier of tiers) {
      const db = createMockDb();
      configureConnection(db as unknown as Parameters<typeof configureConnection>[0], tier);

      // All tiers should get the core PRAGMAs
      expect(db.pragmaCalls).toContain('journal_mode = WAL');
      expect(db.pragmaCalls).toContain('foreign_keys = ON');
    }
  });
});
