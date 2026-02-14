// @meridian/journal — Embedding providers & storage (Section 5.4, Phase 10.1)
//
// EmbeddingProvider interface with Ollama and API implementations.
// EmbeddingStore manages storage/search in journal.db, using a pure-JS
// cosine similarity fallback (O(n) per query, acceptable for <10K memories).
//
// Implementation Deviation: sqlite-vec vec0 virtual table deferred.
// Using BLOB-based Float32Array storage with in-process cosine similarity.
// Performance is acceptable for single-user (<10K memories).

import type { DatabaseClient, MemoryType } from '@meridian/shared';
import { generateId } from '@meridian/shared';

// ---------------------------------------------------------------------------
// EmbeddingProvider interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
}

// ---------------------------------------------------------------------------
// Ollama embedding provider
// ---------------------------------------------------------------------------

export interface OllamaEmbeddingConfig {
  baseUrl?: string;
  model?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  readonly dimensions: number = 768;

  constructor(config: OllamaEmbeddingConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'http://127.0.0.1:11434';
    this.model = config.model ?? 'nomic-embed-text';
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (!data.embeddings[0]) {
      throw new Error('Ollama returned empty embeddings');
    }
    return new Float32Array(data.embeddings[0]);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama batch embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (data.embeddings.length !== texts.length) {
      throw new Error('Ollama returned mismatched embedding count');
    }
    return data.embeddings.map((e) => new Float32Array(e));
  }
}

// ---------------------------------------------------------------------------
// API embedding provider (OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface ApiEmbeddingConfig {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  dimensions?: number;
}

export class ApiEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  readonly dimensions: number;

  constructor(config: ApiEmbeddingConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? 1536;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    const first = results[0];
    if (!first) throw new Error('Embedding returned no results');
    return first;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(
        `API embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ---------------------------------------------------------------------------
// Mock embedding provider (for testing)
// ---------------------------------------------------------------------------

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private callCount = 0;

  constructor(dimensions: number = 768) {
    this.dimensions = dimensions;
  }

  embed(text: string): Promise<Float32Array> {
    return Promise.resolve(this.deterministicEmbedding(text));
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.deterministicEmbedding(t)));
  }

  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Generate a deterministic embedding from text content.
   * Similar texts produce similar embeddings (useful for testing search relevance).
   */
  private deterministicEmbedding(text: string): Float32Array {
    this.callCount++;
    const embedding = new Float32Array(this.dimensions);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;
      for (let j = 0; j < word.length; j++) {
        const idx = (word.charCodeAt(j) * 31 + i * 7 + j) % this.dimensions;
        embedding[idx] = (embedding[idx] ?? 0) + 0.1;
      }
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += (embedding[i] ?? 0) * (embedding[i] ?? 0);
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        embedding[i] = (embedding[i] ?? 0) / norm;
      }
    }

    return embedding;
  }
}

// ---------------------------------------------------------------------------
// EmbeddingStore — BLOB-based with cosine similarity
// ---------------------------------------------------------------------------

export interface EmbeddingStoreLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface EmbeddingStoreOptions {
  db: DatabaseClient;
  logger?: EmbeddingStoreLogger;
}

export interface EmbeddingSearchResult {
  memoryId: string;
  memoryType: MemoryType;
  score: number;
}

interface EmbeddingRow {
  id: string;
  memory_id: string;
  memory_type: string;
  embedding: Buffer;
  dimensions: number;
  created_at: string;
}

export class EmbeddingStore {
  private readonly db: DatabaseClient;

  constructor(options: EmbeddingStoreOptions) {
    this.db = options.db;
  }

  /**
   * Store an embedding for a memory.
   */
  async store(
    memoryId: string,
    memoryType: MemoryType,
    embedding: Float32Array,
  ): Promise<void> {
    const id = generateId();
    const now = new Date().toISOString();
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    await this.db.run(
      'journal',
      `INSERT INTO memory_embeddings (id, memory_id, memory_type, embedding, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         embedding = excluded.embedding,
         dimensions = excluded.dimensions,
         created_at = excluded.created_at`,
      [id, memoryId, memoryType, blob, embedding.length, now],
    );
  }

  /**
   * Remove an embedding for a memory.
   */
  async remove(memoryId: string): Promise<void> {
    await this.db.run(
      'journal',
      'DELETE FROM memory_embeddings WHERE memory_id = ?',
      [memoryId],
    );
  }

  /**
   * Search for similar embeddings using cosine similarity.
   * Pure-JS O(n) scan — acceptable for <10K memories in single-user system.
   */
  async search(
    query: Float32Array,
    options: {
      maxResults?: number;
      minScore?: number;
      types?: MemoryType[];
    } = {},
  ): Promise<EmbeddingSearchResult[]> {
    const maxResults = options.maxResults ?? 10;
    const minScore = options.minScore ?? 0.0;

    let sql = 'SELECT * FROM memory_embeddings';
    const params: unknown[] = [];

    if (options.types && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(', ');
      sql += ` WHERE memory_type IN (${placeholders})`;
      params.push(...options.types);
    }

    const rows = await this.db.query<EmbeddingRow>('journal', sql, params);

    const results: EmbeddingSearchResult[] = [];

    for (const row of rows) {
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      const score = cosineSimilarity(query, stored);
      if (score >= minScore) {
        results.push({
          memoryId: row.memory_id,
          memoryType: row.memory_type as MemoryType,
          score,
        });
      }
    }

    // Sort by score descending and take top-K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Get the total number of stored embeddings.
   */
  async count(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      'journal',
      'SELECT COUNT(*) as count FROM memory_embeddings',
    );
    return rows[0]?.count ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
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
