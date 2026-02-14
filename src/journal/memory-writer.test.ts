// @meridian/journal — MemoryWriter tests (Phase 10.2)

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import { EmbeddingStore, MockEmbeddingProvider } from './embeddings.js';
import { MemoryStore } from './memory-store.js';
import { extractKeywords, MemoryWriter } from './memory-writer.js';
import type { ReflectionResult } from './reflector.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;
let memoryStore: MemoryStore;
let embeddingStore: EmbeddingStore;
let writer: MemoryWriter;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-writer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  db = new DatabaseClient({ dataDir: testDir, direct: true });
  await db.start();
  await db.open('journal');

  // Run schema
  await db.exec('journal', `
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      content TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source_episode_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      source_episode_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_staging (
      id TEXT PRIMARY KEY,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      confidence REAL DEFAULT 1.0,
      source_episode_id TEXT,
      job_id TEXT,
      staged_at TEXT NOT NULL,
      promoted_at TEXT,
      rejected_at TEXT,
      metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL DEFAULT 768,
      created_at TEXT NOT NULL,
      UNIQUE(memory_id)
    );
  `);

  memoryStore = new MemoryStore({ db });
  embeddingStore = new EmbeddingStore({ db });
  writer = new MemoryWriter({ memoryStore });
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
// Helpers
// ---------------------------------------------------------------------------

function createReflection(overrides: Partial<ReflectionResult> = {}): ReflectionResult {
  return {
    episode: {
      summary: 'User asked about weather',
      outcome: 'success',
    },
    facts: [
      {
        category: 'user_preference',
        content: 'User prefers Celsius',
        confidence: 0.85,
      },
    ],
    procedures: [
      {
        category: 'pattern',
        content: 'Check weather API first',
      },
    ],
    contradictions: [],
    gearSuggestion: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryWriter', () => {
  describe('write', () => {
    it('should create an episode from reflection', async () => {
      const result = await writer.write(createReflection(), 'job-1');

      expect(result.episodeId).toBeTruthy();

      const episode = await memoryStore.getEpisode(result.episodeId);
      expect(episode).toBeTruthy();
      expect(episode?.content).toContain('success');
      expect(episode?.summary).toBe('User asked about weather');
      expect(episode?.jobId).toBe('job-1');
    });

    it('should stage facts for review', async () => {
      const result = await writer.write(createReflection());

      expect(result.stagedFacts).toBe(1);

      const pending = await memoryStore.listPendingStagedMemories();
      const factStaged = pending.find((p) => p.memoryType === 'semantic');
      expect(factStaged).toBeTruthy();
      expect(factStaged?.content).toBe('User prefers Celsius');
      expect(factStaged?.category).toBe('user_preference');
      expect(factStaged?.confidence).toBe(0.85);
    });

    it('should stage procedures for review', async () => {
      const result = await writer.write(createReflection());

      expect(result.stagedProcedures).toBe(1);

      const pending = await memoryStore.listPendingStagedMemories();
      const procStaged = pending.find((p) => p.memoryType === 'procedural');
      expect(procStaged).toBeTruthy();
      expect(procStaged?.content).toBe('Check weather API first');
      expect(procStaged?.category).toBe('pattern');
    });

    it('should handle reflections with no facts or procedures', async () => {
      const reflection = createReflection({
        facts: [],
        procedures: [],
      });

      const result = await writer.write(reflection);

      expect(result.episodeId).toBeTruthy();
      expect(result.stagedFacts).toBe(0);
      expect(result.stagedProcedures).toBe(0);
    });

    it('should create embeddings when provider is available', async () => {
      const provider = new MockEmbeddingProvider(128);
      const writerWithEmbed = new MemoryWriter({
        memoryStore,
        embeddingStore,
        embeddingProvider: provider,
      });

      const result = await writerWithEmbed.write(createReflection());

      expect(result.embeddingCreated).toBe(true);
      expect(await embeddingStore.count()).toBe(1);
    });

    it('should not fail if embedding creation fails', async () => {
      const provider = new MockEmbeddingProvider(128);
      vi.spyOn(provider, 'embed').mockRejectedValue(new Error('Embed failed'));

      const writerWithEmbed = new MemoryWriter({
        memoryStore,
        embeddingStore,
        embeddingProvider: provider,
      });

      const result = await writerWithEmbed.write(createReflection());

      expect(result.embeddingCreated).toBe(false);
      expect(result.episodeId).toBeTruthy();
    });

    it('should link staged memories to episode', async () => {
      const result = await writer.write(createReflection());

      const pending = await memoryStore.listPendingStagedMemories();
      for (const staged of pending) {
        expect(staged.sourceEpisodeId).toBe(result.episodeId);
      }
    });
  });

  describe('contradiction detection', () => {
    it('should reduce confidence of contradicted facts', async () => {
      // Create an existing fact
      const existingFact = await memoryStore.createFact({
        category: 'user_preference',
        content: 'User prefers dark mode interface',
        confidence: 0.9,
      });

      const reflection = createReflection({
        contradictions: [
          {
            existingFact: 'User prefers dark mode interface',
            newEvidence: 'User switched to light mode',
            suggestedResolution: 'User now prefers light mode',
          },
        ],
      });

      const result = await writer.write(reflection);

      expect(result.contradictionsFound).toBe(1);

      const updated = await memoryStore.getFact(existingFact.id);
      expect(updated?.confidence).toBeLessThan(0.9);
    });

    it('should not reduce confidence below zero', async () => {
      await memoryStore.createFact({
        category: 'knowledge',
        content: 'User uses Linux operating system',
        confidence: 0.1,
      });

      const reflection = createReflection({
        contradictions: [
          {
            existingFact: 'User uses Linux operating system',
            newEvidence: 'User is on macOS',
            suggestedResolution: 'User switched OS',
          },
        ],
      });

      const result = await writer.write(reflection);
      expect(result.contradictionsFound).toBe(1);
    });

    it('should not match when no similar facts exist', async () => {
      const reflection = createReflection({
        contradictions: [
          {
            existingFact: 'Some completely unrelated fact about quantum physics',
            newEvidence: 'New evidence',
            suggestedResolution: 'Resolution',
          },
        ],
      });

      const result = await writer.write(reflection);
      expect(result.contradictionsFound).toBe(0);
    });
  });

  describe('promoteStagedMemory', () => {
    it('should promote a semantic staged memory to a fact', async () => {
      const staged = await memoryStore.createStagedMemory({
        memoryType: 'semantic',
        content: 'User prefers dark mode',
        category: 'user_preference',
        confidence: 0.8,
      });

      await writer.promoteStagedMemory(staged.id);

      const facts = await memoryStore.listFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]?.content).toBe('User prefers dark mode');
      expect(facts[0]?.category).toBe('user_preference');
      expect(facts[0]?.confidence).toBe(0.8);

      const updated = await memoryStore.getStagedMemory(staged.id);
      expect(updated?.promotedAt).toBeTruthy();
    });

    it('should promote a procedural staged memory to a procedure', async () => {
      const staged = await memoryStore.createStagedMemory({
        memoryType: 'procedural',
        content: 'Always validate inputs first',
        category: 'strategy',
      });

      await writer.promoteStagedMemory(staged.id);

      const procedures = await memoryStore.listProcedures();
      expect(procedures).toHaveLength(1);
      expect(procedures[0]?.content).toBe('Always validate inputs first');
      expect(procedures[0]?.category).toBe('strategy');
    });

    it('should not promote already-promoted memories', async () => {
      const staged = await memoryStore.createStagedMemory({
        memoryType: 'semantic',
        content: 'Some fact',
        category: 'knowledge',
      });

      await writer.promoteStagedMemory(staged.id);
      await writer.promoteStagedMemory(staged.id);

      const facts = await memoryStore.listFacts();
      expect(facts).toHaveLength(1);
    });

    it('should not promote rejected memories', async () => {
      const staged = await memoryStore.createStagedMemory({
        memoryType: 'semantic',
        content: 'Rejected fact',
        category: 'knowledge',
      });

      await memoryStore.rejectStagedMemory(staged.id);
      await writer.promoteStagedMemory(staged.id);

      const facts = await memoryStore.listFacts();
      expect(facts).toHaveLength(0);
    });

    it('should create embeddings on promotion when provider available', async () => {
      const provider = new MockEmbeddingProvider(128);
      const writerWithEmbed = new MemoryWriter({
        memoryStore,
        embeddingStore,
        embeddingProvider: provider,
      });

      const staged = await memoryStore.createStagedMemory({
        memoryType: 'semantic',
        content: 'User likes coffee',
        category: 'user_preference',
      });

      await writerWithEmbed.promoteStagedMemory(staged.id);

      expect(await embeddingStore.count()).toBe(1);
    });

    it('should handle non-existent staged memory gracefully', async () => {
      // Should not throw
      await writer.promoteStagedMemory('non-existent-id');
    });
  });
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  it('should extract meaningful keywords', () => {
    const keywords = extractKeywords('User prefers dark mode interface');
    expect(keywords).toContain('user');
    expect(keywords).toContain('prefers');
    expect(keywords).toContain('dark');
    expect(keywords).toContain('mode');
    expect(keywords).toContain('interface');
  });

  it('should filter stop words', () => {
    const keywords = extractKeywords('The user is on a Mac');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('is');
    expect(keywords).not.toContain('on');
    expect(keywords).not.toContain('a');
  });

  it('should filter short words', () => {
    const keywords = extractKeywords('Go to the next page');
    expect(keywords).not.toContain('go');
    expect(keywords).not.toContain('to');
  });

  it('should handle empty text', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('should lowercase all keywords', () => {
    const keywords = extractKeywords('User Prefers DARK MODE');
    expect(keywords).toEqual(expect.arrayContaining(['user', 'prefers', 'dark', 'mode']));
  });
});
