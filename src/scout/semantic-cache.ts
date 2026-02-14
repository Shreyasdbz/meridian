// @meridian/scout — Semantic Response Cache (Phase 11.4)
//
// Caches LLM responses for identical or near-identical queries using
// embedding-based similarity. When a new query's embedding is within
// the similarity threshold (default 0.98) of a cached entry for the
// same model, the cached response is returned without an LLM call.
//
// Architecture references:
// - Section 11.2 (Semantic Cache)
// - Section 5.2 (Scout — Planner LLM)

import type { SemanticCacheEntry } from '@meridian/shared';
import {
  generateId,
  SEMANTIC_CACHE_SIMILARITY_THRESHOLD,
  SEMANTIC_CACHE_TTL_MS,
  SEMANTIC_CACHE_MAX_ENTRIES,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticCacheConfig {
  similarityThreshold?: number;
  ttlMs?: number;
  maxEntries?: number;
  embeddingProvider?: EmbeddingProviderLike;
  logger?: SemanticCacheLogger;
}

export interface EmbeddingProviderLike {
  embed(text: string): Promise<number[]>;
}

export interface SemanticCacheLogger {
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Constants — time-sensitive query keywords
// ---------------------------------------------------------------------------

/**
 * Keywords that indicate a time-sensitive query which should bypass the cache.
 * Grouped by category for maintainability.
 */
const TIME_SENSITIVE_KEYWORDS: readonly string[] = [
  // Weather
  'weather',
  'forecast',
  'temperature',
  // News
  'news',
  'latest',
  'today',
  'current',
  'now',
  // Finance
  'stock',
  'price',
  'market',
  'exchange rate',
  // Time
  'time',
  'date',
  'schedule today',
  // Freshness
  'recent',
  'right now',
  'at the moment',
  'this week',
  'this month',
];

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: SemanticCacheLogger = {
  info: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// SemanticCache
// ---------------------------------------------------------------------------

/**
 * SemanticCache — embedding-based LLM response cache.
 *
 * Uses cosine similarity between query embeddings to find near-identical
 * queries and return cached responses. This avoids redundant LLM calls
 * for semantically identical questions.
 *
 * Features:
 * - Configurable similarity threshold (default 0.98 for near-exact match)
 * - Per-model cache isolation (responses cached per model)
 * - Time-sensitive query bypass (weather, news, finance, time queries skip cache)
 * - TTL-based expiration (default 24 hours)
 * - LRU-style eviction when at capacity
 */
export class SemanticCache {
  private readonly entries: Map<string, SemanticCacheEntry> = new Map();
  private readonly similarityThreshold: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly embeddingProvider: EmbeddingProviderLike | null;
  private readonly logger: SemanticCacheLogger;

  private hits = 0;
  private misses = 0;
  private bypasses = 0;

  constructor(config?: SemanticCacheConfig) {
    this.similarityThreshold = config?.similarityThreshold ?? SEMANTIC_CACHE_SIMILARITY_THRESHOLD;
    this.ttlMs = config?.ttlMs ?? SEMANTIC_CACHE_TTL_MS;
    this.maxEntries = config?.maxEntries ?? SEMANTIC_CACHE_MAX_ENTRIES;
    this.embeddingProvider = config?.embeddingProvider ?? null;
    this.logger = config?.logger ?? noopLogger;
  }

  /**
   * Look up a cached response for a query.
   * Returns the cached response if similarity > threshold, null otherwise.
   *
   * Time-sensitive queries bypass the cache entirely.
   * If no embedding provider is configured, always returns null.
   */
  async lookup(query: string, model: string): Promise<string | null> {
    // Bypass for time-sensitive queries
    if (this.isTimeSensitive(query)) {
      this.bypasses++;
      this.logger.debug('Semantic cache bypass: time-sensitive query', {
        queryPreview: query.slice(0, 80),
      });
      return null;
    }

    // No embedding provider — cache cannot function
    if (!this.embeddingProvider) {
      this.misses++;
      return null;
    }

    // Generate embedding for the query
    const queryEmbedding = await this.embeddingProvider.embed(query);

    const now = Date.now();
    let bestMatch: SemanticCacheEntry | null = null;
    let bestSimilarity = 0;

    for (const entry of this.entries.values()) {
      // Skip entries for different models
      if (entry.model !== model) {
        continue;
      }

      // Skip expired entries
      const expiresAt = new Date(entry.expiresAt).getTime();
      if (now > expiresAt) {
        continue;
      }

      // Compute similarity
      const similarity = this.cosineSimilarity(queryEmbedding, entry.queryEmbedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestSimilarity >= this.similarityThreshold) {
      this.hits++;
      this.logger.info('Semantic cache hit', {
        entryId: bestMatch.id,
        model,
        similarity: bestSimilarity,
        queryPreview: query.slice(0, 80),
      });
      return bestMatch.response;
    }

    this.misses++;
    this.logger.debug('Semantic cache miss', {
      model,
      bestSimilarity,
      threshold: this.similarityThreshold,
      queryPreview: query.slice(0, 80),
    });
    return null;
  }

  /**
   * Store a response in the cache.
   *
   * If no embedding provider is configured, the store is a no-op.
   * Time-sensitive queries are not stored.
   */
  async store(query: string, response: string, model: string): Promise<void> {
    // Don't cache time-sensitive queries
    if (this.isTimeSensitive(query)) {
      return;
    }

    // No embedding provider — cannot store
    if (!this.embeddingProvider) {
      return;
    }

    // Evict if at capacity
    if (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }

    const queryEmbedding = await this.embeddingProvider.embed(query);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    const entry: SemanticCacheEntry = {
      id: generateId(),
      queryEmbedding,
      response,
      model,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.entries.set(entry.id, entry);
    this.logger.info('Stored response in semantic cache', {
      entryId: entry.id,
      model,
      queryPreview: query.slice(0, 80),
      cacheSize: this.entries.size,
    });
  }

  /**
   * Check if a query is time-sensitive and should bypass the cache.
   * Time-sensitive queries involve real-time data that changes frequently.
   */
  isTimeSensitive(query: string): boolean {
    const lower = query.toLowerCase();
    return TIME_SENSITIVE_KEYWORDS.some((keyword) => lower.includes(keyword));
  }

  /**
   * Compute cosine similarity between two embedding vectors.
   *
   * Note: This is a local implementation rather than importing from
   * @meridian/journal, since scout/ cannot import journal/ per
   * architecture module boundary rules.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dotProduct += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  /**
   * Evict expired entries. Returns the number of entries removed.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.entries) {
      const expiresAt = new Date(entry.expiresAt).getTime();
      if (now > expiresAt) {
        this.entries.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.info('Pruned expired semantic cache entries', {
        pruned,
        remaining: this.entries.size,
      });
    }

    return pruned;
  }

  /**
   * Get cache statistics.
   */
  stats(): { size: number; hits: number; misses: number; bypasses: number } {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      bypasses: this.bypasses,
    };
  }

  /**
   * Clear the entire cache and reset statistics.
   */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
    this.logger.info('Semantic cache cleared');
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

    for (const [key, entry] of this.entries) {
      const createdAt = new Date(entry.createdAt).getTime();
      if (createdAt < oldestTime) {
        oldestTime = createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.logger.debug('Evicted oldest semantic cache entry', {
        entryId: oldestKey,
      });
    }
  }
}
