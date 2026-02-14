// @meridian/journal — Embedding tests (Phase 10.1)

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import {
  cosineSimilarity,
  EmbeddingStore,
  MockEmbeddingProvider,
} from './embeddings.js';

describe('cosineSimilarity', () => {
  it('should return 1.0 for identical vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('should return -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('should return 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should return 0 for mismatched dimensions', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('MockEmbeddingProvider', () => {
  it('should produce deterministic embeddings', async () => {
    const provider = new MockEmbeddingProvider(128);
    const a = await provider.embed('hello world');
    const b = await provider.embed('hello world');
    expect(a).toEqual(b);
  });

  it('should produce similar embeddings for similar text', async () => {
    const provider = new MockEmbeddingProvider(128);
    const a = await provider.embed('the cat sat on the mat');
    const b = await provider.embed('the cat sat on the rug');
    const c = await provider.embed('quantum physics experiments');

    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);

    expect(simAB).toBeGreaterThan(simAC);
  });

  it('should produce normalized embeddings', async () => {
    const provider = new MockEmbeddingProvider(128);
    const embedding = await provider.embed('test text');

    let norm = 0;
    for (let i = 0; i < embedding.length; i++) {
      norm += (embedding[i] ?? 0) * (embedding[i] ?? 0);
    }
    norm = Math.sqrt(norm);

    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('should support batch embedding', async () => {
    const provider = new MockEmbeddingProvider(128);
    const results = await provider.embedBatch(['hello', 'world']);
    expect(results).toHaveLength(2);
    expect(results[0]).toBeDefined();
    expect(results[0]?.length).toBe(128);
  });

  it('should track call count', async () => {
    const provider = new MockEmbeddingProvider(128);
    await provider.embed('a');
    await provider.embed('b');
    expect(provider.getCallCount()).toBe(2);
  });
});

describe('EmbeddingStore', () => {
  let testDir: string;
  let db: DatabaseClient;
  let embeddingStore: EmbeddingStore;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `meridian-test-embeddings-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    db = new DatabaseClient({ dataDir: testDir, direct: true });
    await db.start();
    await db.open('journal');

    await db.exec('journal', `
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL DEFAULT 768,
        created_at TEXT NOT NULL,
        UNIQUE(memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_memory_type ON memory_embeddings(memory_type);
    `);

    embeddingStore = new EmbeddingStore({ db });
  });

  afterEach(async () => {
    await db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it('should store and search embeddings', async () => {
    const provider = new MockEmbeddingProvider(128);

    const emb1 = await provider.embed('cats and dogs');
    const emb2 = await provider.embed('feline and canine');
    const emb3 = await provider.embed('quantum physics');

    await embeddingStore.store('mem-1', 'semantic', emb1);
    await embeddingStore.store('mem-2', 'semantic', emb2);
    await embeddingStore.store('mem-3', 'episodic', emb3);

    const query = await provider.embed('cats and pets');
    const results = await embeddingStore.search(query, { maxResults: 3 });

    expect(results).toHaveLength(3);
    const catResult = results.find((r) => r.memoryId === 'mem-1');
    const quantumResult = results.find((r) => r.memoryId === 'mem-3');
    expect(catResult).toBeTruthy();
    expect(quantumResult).toBeTruthy();
  });

  it('should filter by memory type', async () => {
    const provider = new MockEmbeddingProvider(128);

    await embeddingStore.store('mem-1', 'semantic', await provider.embed('fact 1'));
    await embeddingStore.store('mem-2', 'episodic', await provider.embed('episode 1'));

    const query = await provider.embed('search');
    const results = await embeddingStore.search(query, { types: ['semantic'] });

    expect(results.every((r) => r.memoryType === 'semantic')).toBe(true);
  });

  it('should remove embeddings', async () => {
    const provider = new MockEmbeddingProvider(128);
    await embeddingStore.store('mem-1', 'semantic', await provider.embed('test'));

    expect(await embeddingStore.count()).toBe(1);

    await embeddingStore.remove('mem-1');
    expect(await embeddingStore.count()).toBe(0);
  });

  it('should upsert on duplicate memory_id', async () => {
    const provider = new MockEmbeddingProvider(128);
    await embeddingStore.store('mem-1', 'semantic', await provider.embed('version 1'));
    await embeddingStore.store('mem-1', 'semantic', await provider.embed('version 2'));

    expect(await embeddingStore.count()).toBe(1);
  });

  it('should apply minScore filter', async () => {
    const provider = new MockEmbeddingProvider(128);
    await embeddingStore.store('mem-1', 'semantic', await provider.embed('relevant topic'));
    await embeddingStore.store('mem-2', 'semantic', await provider.embed('completely different'));

    const query = await provider.embed('relevant topic');
    const results = await embeddingStore.search(query, { minScore: 0.9 });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toBeDefined();
    expect(results[0]?.memoryId).toBe('mem-1');
  });
});
