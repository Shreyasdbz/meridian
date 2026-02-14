// @meridian/scout — Semantic Cache tests (Phase 11.4)

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SemanticCache } from './semantic-cache.js';
import type {
  SemanticCacheLogger,
  EmbeddingProviderLike,
} from './semantic-cache.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Mock embedding provider that produces deterministic embeddings.
 * Similar texts produce similar (high cosine similarity) embeddings.
 */
function createMockEmbeddingProvider(): EmbeddingProviderLike {
  return {
    embed: vi.fn((text: string): Promise<number[]> => {
      // Simple hash-based deterministic embedding
      const dimensions = 16;
      const embedding = new Array(dimensions).fill(0) as number[];
      const words = text.toLowerCase().split(/\s+/);

      for (let i = 0; i < words.length; i++) {
        const word = words[i] ?? '';
        for (let j = 0; j < word.length; j++) {
          const idx = (word.charCodeAt(j) * 31 + i * 7 + j) % dimensions;
          embedding[idx] = (embedding[idx] ?? 0) + 0.1;
        }
      }

      // Normalize
      let norm = 0;
      for (let i = 0; i < dimensions; i++) {
        norm += (embedding[i] ?? 0) * (embedding[i] ?? 0);
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
          embedding[i] = (embedding[i] ?? 0) / norm;
        }
      }

      return Promise.resolve(embedding);
    }),
  };
}

function createTestLogger(): SemanticCacheLogger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SemanticCache', () => {
  let embeddingProvider: EmbeddingProviderLike;
  let logger: SemanticCacheLogger;
  let cache: SemanticCache;

  beforeEach(() => {
    embeddingProvider = createMockEmbeddingProvider();
    logger = createTestLogger();
    cache = new SemanticCache({
      embeddingProvider,
      logger,
      similarityThreshold: 0.98,
    });
  });

  describe('store and lookup', () => {
    it('should store and retrieve an exact-match response', async () => {
      await cache.store('What is the capital of France?', 'Paris', 'model-1');

      const result = await cache.lookup('What is the capital of France?', 'model-1');
      expect(result).toBe('Paris');
    });

    it('should return null for queries with no matching entries', async () => {
      await cache.store('What is the capital of France?', 'Paris', 'model-1');

      const result = await cache.lookup(
        'How do I bake a chocolate cake?',
        'model-1',
      );
      expect(result).toBeNull();
    });

    it('should isolate entries by model', async () => {
      await cache.store('query', 'response-model-1', 'model-1');
      await cache.store('query', 'response-model-2', 'model-2');

      const result1 = await cache.lookup('query', 'model-1');
      const result2 = await cache.lookup('query', 'model-2');

      expect(result1).toBe('response-model-1');
      expect(result2).toBe('response-model-2');
    });

    it('should return null when no embedding provider is configured', async () => {
      const noProviderCache = new SemanticCache({ logger });

      await noProviderCache.store('query', 'response', 'model-1');
      const result = await noProviderCache.lookup('query', 'model-1');

      expect(result).toBeNull();
    });

    it('should not store when no embedding provider is configured', async () => {
      const noProviderCache = new SemanticCache({ logger });
      await noProviderCache.store('query', 'response', 'model-1');
      expect(noProviderCache.stats().size).toBe(0);
    });

    it('should return null for expired entries', async () => {
      const shortTtlCache = new SemanticCache({
        embeddingProvider,
        logger,
        ttlMs: 1,
      });

      await shortTtlCache.store('query', 'response', 'model-1');

      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await shortTtlCache.lookup('query', 'model-1');
      expect(result).toBeNull();
    });

    it('should evict oldest entry when at capacity', async () => {
      const smallCache = new SemanticCache({
        embeddingProvider,
        logger,
        maxEntries: 2,
        similarityThreshold: 0.98,
      });

      await smallCache.store('query one', 'response-1', 'model-1');
      await smallCache.store('query two', 'response-2', 'model-1');
      // This should evict 'query one'
      await smallCache.store('query three', 'response-3', 'model-1');

      expect(smallCache.stats().size).toBe(2);
    });
  });

  describe('isTimeSensitive', () => {
    it('should detect weather queries', () => {
      expect(cache.isTimeSensitive('What is the weather today?')).toBe(true);
      expect(cache.isTimeSensitive('Show me the forecast for tomorrow')).toBe(true);
      expect(cache.isTimeSensitive('Current temperature in New York')).toBe(true);
    });

    it('should detect news queries', () => {
      expect(cache.isTimeSensitive('What is the latest news?')).toBe(true);
      expect(cache.isTimeSensitive('Show me today\'s headlines')).toBe(true);
      expect(cache.isTimeSensitive('What is happening now?')).toBe(true);
    });

    it('should detect finance queries', () => {
      expect(cache.isTimeSensitive('What is the stock price of AAPL?')).toBe(true);
      expect(cache.isTimeSensitive('Show market trends')).toBe(true);
      expect(cache.isTimeSensitive('What is the exchange rate for USD?')).toBe(true);
    });

    it('should detect time queries', () => {
      expect(cache.isTimeSensitive('What time is it?')).toBe(true);
      expect(cache.isTimeSensitive('What is the date?')).toBe(true);
      expect(cache.isTimeSensitive('Show my schedule today')).toBe(true);
    });

    it('should not flag non-time-sensitive queries', () => {
      expect(cache.isTimeSensitive('What is the capital of France?')).toBe(false);
      expect(cache.isTimeSensitive('How do I write a for loop?')).toBe(false);
      expect(cache.isTimeSensitive('Explain quantum entanglement')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(cache.isTimeSensitive('WHAT IS THE WEATHER?')).toBe(true);
      expect(cache.isTimeSensitive('Latest NEWS headlines')).toBe(true);
    });
  });

  describe('lookup with time-sensitive bypass', () => {
    it('should bypass cache for time-sensitive queries', async () => {
      await cache.store('What is the weather?', 'Sunny', 'model-1');

      // Even though the exact query is stored, it should bypass
      const result = await cache.lookup('What is the weather?', 'model-1');
      expect(result).toBeNull();

      const stats = cache.stats();
      expect(stats.bypasses).toBe(1);
    });

    it('should not store time-sensitive queries', async () => {
      await cache.store('What is the weather today?', 'Sunny', 'model-1');
      expect(cache.stats().size).toBe(0);
    });
  });

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const v = [1, 0, 0, 1];
      expect(cache.cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0];
      const b = [0, 1];
      expect(cache.cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0];
      const b = [-1, 0];
      expect(cache.cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should return 0 for empty vectors', () => {
      expect(cache.cosineSimilarity([], [])).toBe(0);
    });

    it('should return 0 for mismatched dimensions', () => {
      const a = [1, 0, 0];
      const b = [1, 0];
      expect(cache.cosineSimilarity(a, b)).toBe(0);
    });

    it('should return 0 for zero vectors', () => {
      const a = [0, 0, 0];
      const b = [0, 0, 0];
      expect(cache.cosineSimilarity(a, b)).toBe(0);
    });

    it('should compute correct similarity for known vectors', () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      expect(cache.cosineSimilarity(a, b)).toBeCloseTo(1.0);

      const c = [1, 0, 0];
      const d = [1, 1, 0];
      // cos(45 degrees) = sqrt(2)/2 ~ 0.7071
      expect(cache.cosineSimilarity(c, d)).toBeCloseTo(Math.SQRT2 / 2, 4);
    });
  });

  describe('prune', () => {
    it('should remove expired entries', async () => {
      const shortTtlCache = new SemanticCache({
        embeddingProvider,
        logger,
        ttlMs: 1,
      });

      await shortTtlCache.store('query one', 'response-1', 'model-1');
      await shortTtlCache.store('query two', 'response-2', 'model-1');

      await new Promise((resolve) => setTimeout(resolve, 10));

      const pruned = shortTtlCache.prune();
      expect(pruned).toBe(2);
      expect(shortTtlCache.stats().size).toBe(0);
    });

    it('should not remove non-expired entries', async () => {
      await cache.store('query one', 'response-1', 'model-1');
      await cache.store('query two', 'response-2', 'model-1');

      const pruned = cache.prune();
      expect(pruned).toBe(0);
      expect(cache.stats().size).toBe(2);
    });
  });

  describe('stats', () => {
    it('should track hits, misses, and bypasses', async () => {
      await cache.store('What is the capital of France?', 'Paris', 'model-1');

      // Hit
      await cache.lookup('What is the capital of France?', 'model-1');
      // Miss
      await cache.lookup('completely different question', 'model-1');
      // Bypass
      await cache.lookup('What is the weather today?', 'model-1');

      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.bypasses).toBe(1);
      expect(stats.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all entries and reset stats', async () => {
      await cache.store('query one', 'response-1', 'model-1');
      await cache.store('query two', 'response-2', 'model-1');

      // Generate some stats
      await cache.lookup('query one', 'model-1');
      await cache.lookup('nonexistent', 'model-1');

      cache.clear();

      const stats = cache.stats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.bypasses).toBe(0);
    });
  });
});
