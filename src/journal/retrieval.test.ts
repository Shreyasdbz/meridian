// @meridian/journal — Retrieval & RRF tests (Phase 10.1)

import { describe, expect, it } from 'vitest';

import { reciprocalRankFusion, sanitizeFtsQuery } from './retrieval.js';

// ---------------------------------------------------------------------------
// RRF tests
// ---------------------------------------------------------------------------

describe('reciprocalRankFusion', () => {
  it('should combine results from two lists', () => {
    const listA = [
      { id: 'a', type: 'semantic' as const, content: 'A', createdAt: '2026-01-01', score: 0.9 },
      { id: 'b', type: 'semantic' as const, content: 'B', createdAt: '2026-01-02', score: 0.8 },
      { id: 'c', type: 'episodic' as const, content: 'C', createdAt: '2026-01-03', score: 0.7 },
    ];

    const listB = [
      { id: 'b', type: 'semantic' as const, content: 'B', createdAt: '2026-01-02', score: 0.95 },
      { id: 'd', type: 'procedural' as const, content: 'D', createdAt: '2026-01-04', score: 0.85 },
      { id: 'a', type: 'semantic' as const, content: 'A', createdAt: '2026-01-01', score: 0.75 },
    ];

    const results = reciprocalRankFusion(listA, listB);

    // Both 'a' and 'b' appear in both lists, so they should have higher scores
    expect(results.length).toBe(4); // a, b, c, d
    const ids = results.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');

    // b is rank 2 in A (0-indexed: 1) and rank 1 in B (0-indexed: 0)
    // a is rank 1 in A (0-indexed: 0) and rank 3 in B (0-indexed: 2)
    // b's RRF: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    // a's RRF: 1/(60+1) + 1/(60+3) = 1/61 + 1/63
    // b > a since 1/62 + 1/61 > 1/61 + 1/63
    expect(results[0]).toBeDefined();
    expect(results[0]?.id).toBe('b');
    expect(results[1]).toBeDefined();
    expect(results[1]?.id).toBe('a');
  });

  it('should handle empty lists', () => {
    const listA = [
      { id: 'a', type: 'semantic' as const, content: 'A', createdAt: '2026-01-01', score: 0.9 },
    ];
    const listB: typeof listA = [];

    const results = reciprocalRankFusion(listA, listB);
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    expect(results[0]?.id).toBe('a');
  });

  it('should handle both lists empty', () => {
    const results = reciprocalRankFusion([], []);
    expect(results).toHaveLength(0);
  });

  it('should produce higher scores for items in both lists', () => {
    const listA = [
      { id: 'shared', type: 'semantic' as const, content: 'S', createdAt: '2026-01-01', score: 0.5 },
    ];
    const listB = [
      { id: 'shared', type: 'semantic' as const, content: 'S', createdAt: '2026-01-01', score: 0.5 },
      { id: 'unique', type: 'episodic' as const, content: 'U', createdAt: '2026-01-02', score: 0.5 },
    ];

    const results = reciprocalRankFusion(listA, listB);
    const shared = results.find((r) => r.id === 'shared');
    const unique = results.find((r) => r.id === 'unique');

    expect(shared).toBeDefined();
    expect(unique).toBeDefined();
    expect(shared?.score).toBeGreaterThan(unique?.score as number);
  });

  it('should respect custom k parameter', () => {
    const listA = [
      { id: 'a', type: 'semantic' as const, content: 'A', createdAt: '2026-01-01', score: 1.0 },
    ];
    const listB = [
      { id: 'a', type: 'semantic' as const, content: 'A', createdAt: '2026-01-01', score: 1.0 },
    ];

    const resultsK1 = reciprocalRankFusion(listA, listB, 1);
    const resultsK60 = reciprocalRankFusion(listA, listB, 60);

    // With k=1, score = 1/(1+1) + 1/(1+1) = 1
    // With k=60, score = 1/(60+1) + 1/(60+1) ≈ 0.033
    expect(resultsK1[0]).toBeDefined();
    expect(resultsK60[0]).toBeDefined();
    expect(resultsK1[0]?.score).toBeGreaterThan(resultsK60[0]?.score as number);
  });
});

// ---------------------------------------------------------------------------
// FTS query sanitization tests
// ---------------------------------------------------------------------------

describe('sanitizeFtsQuery', () => {
  it('should wrap terms in quotes', () => {
    const result = sanitizeFtsQuery('hello world');
    expect(result).toBe('"hello" OR "world"');
  });

  it('should strip FTS5 special characters', () => {
    const result = sanitizeFtsQuery('hello (world) "test"');
    // Parentheses and quotes are stripped, words remain
    expect(result).toContain('"hello"');
    expect(result).toContain('"world"');
    expect(result).toContain('"test"');
    expect(result).not.toContain('(');
  });

  it('should handle empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });

  it('should strip special characters', () => {
    const result = sanitizeFtsQuery('test*query(with)special^chars');
    expect(result).not.toContain('*');
    expect(result).not.toContain('(');
    expect(result).not.toContain('^');
  });

  it('should handle single word', () => {
    const result = sanitizeFtsQuery('hello');
    expect(result).toBe('"hello"');
  });
});
