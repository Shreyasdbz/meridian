// @meridian/journal — Hybrid search: semantic + keyword with RRF fusion (Phase 10.1)
//
// Combines sqlite-vec/cosine KNN results with FTS5 MATCH results using
// Reciprocal Rank Fusion (RRF, k=60). Filtered by minRelevance, types, timeRange.

import type { DatabaseClient, MemoryQuery, MemoryResult, MemoryType } from '@meridian/shared';

import type { EmbeddingProvider, EmbeddingStore } from './embeddings.js';
import type { MemoryStore } from './memory-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HybridRetrievalOptions {
  db: DatabaseClient;
  memoryStore: MemoryStore;
  embeddingStore: EmbeddingStore;
  embeddingProvider: EmbeddingProvider;
  logger?: RetrievalLogger;
}

export interface RetrievalLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

interface RankedResult {
  id: string;
  type: MemoryType;
  content: string;
  createdAt: string;
  source?: string;
  score: number;
}

interface FTSRow {
  id: string;
  content: string;
  created_at: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF constant k — standard value from the original RRF paper */
const RRF_K = 60;

const noopLogger: RetrievalLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// HybridRetrieval
// ---------------------------------------------------------------------------

export class HybridRetrieval {
  private readonly db: DatabaseClient;
  private readonly memoryStore: MemoryStore;
  private readonly embeddingStore: EmbeddingStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly logger: RetrievalLogger;

  constructor(options: HybridRetrievalOptions) {
    this.db = options.db;
    this.memoryStore = options.memoryStore;
    this.embeddingStore = options.embeddingStore;
    this.embeddingProvider = options.embeddingProvider;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Execute a hybrid search combining semantic (embedding) and keyword (FTS5) results.
   * Results are fused using Reciprocal Rank Fusion (RRF).
   */
  async search(query: MemoryQuery): Promise<MemoryResult[]> {
    const maxResults = query.maxResults ?? 10;
    const minRelevance = query.minRelevance ?? 0.0;
    const types = query.types;
    const timeRange = query.timeRange;

    this.logger.debug('Starting hybrid search', {
      query: query.text.slice(0, 100),
      maxResults,
      minRelevance,
      types,
    });

    // Run semantic and keyword searches in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(query.text, types, maxResults * 2),
      this.keywordSearch(query.text, types, maxResults * 2),
    ]);

    this.logger.debug('Search results', {
      semanticCount: semanticResults.length,
      keywordCount: keywordResults.length,
    });

    // Fuse results using RRF
    const fused = reciprocalRankFusion(semanticResults, keywordResults);

    // Apply time range filter
    let filtered = fused;
    if (timeRange) {
      filtered = filtered.filter((r) => {
        if (timeRange.start && r.createdAt < timeRange.start) return false;
        if (timeRange.end && r.createdAt > timeRange.end) return false;
        return true;
      });
    }

    // Apply min relevance filter
    filtered = filtered.filter((r) => r.score >= minRelevance);

    // Take top-K
    const topK = filtered.slice(0, maxResults);

    this.logger.debug('Hybrid search complete', {
      fusedCount: fused.length,
      filteredCount: filtered.length,
      returnedCount: topK.length,
    });

    return topK.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      relevanceScore: r.score,
      createdAt: r.createdAt,
      source: r.source,
    }));
  }

  // -------------------------------------------------------------------------
  // Semantic search (embedding-based)
  // -------------------------------------------------------------------------

  private async semanticSearch(
    text: string,
    types: MemoryType[] | undefined,
    maxResults: number,
  ): Promise<RankedResult[]> {
    try {
      const queryEmbedding = await this.embeddingProvider.embed(text);

      const embeddingResults = await this.embeddingStore.search(queryEmbedding, {
        maxResults,
        types,
      });

      // Resolve memory content for each embedding result
      const results: RankedResult[] = [];
      for (const er of embeddingResults) {
        const content = await this.resolveMemoryContent(er.memoryId, er.memoryType);
        if (content) {
          results.push({
            id: er.memoryId,
            type: er.memoryType,
            content: content.content,
            createdAt: content.createdAt,
            source: content.source,
            score: er.score,
          });
        }
      }

      return results;
    } catch (error) {
      this.logger.warn('Semantic search failed, falling back to keyword only', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Keyword search (FTS5-based)
  // -------------------------------------------------------------------------

  private async keywordSearch(
    text: string,
    types: MemoryType[] | undefined,
    maxResults: number,
  ): Promise<RankedResult[]> {
    const results: RankedResult[] = [];
    const searchTerm = sanitizeFtsQuery(text);

    if (!searchTerm) {
      return results;
    }

    // Search each type's FTS table
    const searchTypes: MemoryType[] = types ?? ['episodic', 'semantic', 'procedural'];

    for (const type of searchTypes) {
      try {
        const ftsResults = await this.searchFtsTable(type, searchTerm, maxResults);
        results.push(...ftsResults);
      } catch (error) {
        this.logger.warn(`FTS search failed for ${type}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Sort by FTS rank (lower = more relevant) and normalize to 0-1 score
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  private async searchFtsTable(
    type: MemoryType,
    query: string,
    limit: number,
  ): Promise<RankedResult[]> {
    const tableMap: Record<MemoryType, { fts: string; main: string }> = {
      episodic: { fts: 'episodes_fts', main: 'episodes' },
      semantic: { fts: 'facts_fts', main: 'facts' },
      procedural: { fts: 'procedures_fts', main: 'procedures' },
    };

    const { fts, main } = tableMap[type];

    const rows = await this.db.query<FTSRow>(
      'journal',
      `SELECT m.id, m.content, m.created_at, rank
       FROM ${fts} f
       JOIN ${main} m ON m.rowid = f.rowid
       WHERE ${fts} MATCH ?
       ORDER BY rank
       LIMIT ?`,
      [query, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      type,
      content: row.content,
      createdAt: row.created_at,
      // FTS5 rank is negative (more negative = better match).
      // Negate to get a positive value, then apply diminishing transform to 0-1 range.
      score: 1.0 / (1.0 + Math.abs(row.rank)),
    }));
  }

  // -------------------------------------------------------------------------
  // Memory content resolution
  // -------------------------------------------------------------------------

  private async resolveMemoryContent(
    memoryId: string,
    memoryType: MemoryType,
  ): Promise<{ content: string; createdAt: string; source?: string } | undefined> {
    switch (memoryType) {
      case 'episodic': {
        const episode = await this.memoryStore.getEpisode(memoryId);
        return episode
          ? { content: episode.content, createdAt: episode.createdAt }
          : undefined;
      }
      case 'semantic': {
        const fact = await this.memoryStore.getFact(memoryId);
        return fact
          ? { content: fact.content, createdAt: fact.createdAt, source: fact.category }
          : undefined;
      }
      case 'procedural': {
        const procedure = await this.memoryStore.getProcedure(memoryId);
        return procedure
          ? { content: procedure.content, createdAt: procedure.createdAt, source: procedure.category }
          : undefined;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

/**
 * Combine two ranked result lists using Reciprocal Rank Fusion.
 * Score = sum of 1/(k + rank) for each list where the item appears.
 * k = 60 (standard RRF constant from the original paper).
 */
export function reciprocalRankFusion(
  listA: RankedResult[],
  listB: RankedResult[],
  k: number = RRF_K,
): RankedResult[] {
  const scores = new Map<string, { result: RankedResult; score: number }>();

  // Score from list A
  for (let rank = 0; rank < listA.length; rank++) {
    const item = listA[rank];
    if (!item) continue;
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(item.id, { result: item, score: rrfScore });
    }
  }

  // Score from list B
  for (let rank = 0; rank < listB.length; rank++) {
    const item = listB[rank];
    if (!item) continue;
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(item.id, { result: item, score: rrfScore });
    }
  }

  // Sort by fused score descending
  const results = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));

  return results;
}

// ---------------------------------------------------------------------------
// FTS5 query sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Escapes special characters and wraps terms for safe querying.
 */
export function sanitizeFtsQuery(input: string): string {
  // Remove FTS5 operators and special chars, keep alphanumeric and spaces
  const cleaned = input
    .replace(/[*"():^~{}[\]<>\\|&!+\-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (cleaned.length === 0) {
    return '';
  }

  // Join with OR for broad matching
  return cleaned.map((w) => `"${w}"`).join(' OR ');
}
