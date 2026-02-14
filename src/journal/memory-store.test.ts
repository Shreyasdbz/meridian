// @meridian/journal — Memory CRUD tests (Phase 10.1)

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import { MemoryStore } from './memory-store.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let db: DatabaseClient;
let store: MemoryStore;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-journal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  store = new MemoryStore({ db });
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
// Episodes
// ---------------------------------------------------------------------------

describe('MemoryStore', () => {
  describe('episodes', () => {
    it('should create and retrieve an episode', async () => {
      const episode = await store.createEpisode({
        content: 'User asked to check the weather',
        jobId: 'job-123',
      });

      expect(episode.id).toBeTruthy();
      expect(episode.content).toBe('User asked to check the weather');
      expect(episode.jobId).toBe('job-123');
      expect(episode.createdAt).toBeTruthy();

      const retrieved = await store.getEpisode(episode.id);
      expect(retrieved).toEqual(episode);
    });

    it('should update an episode', async () => {
      const episode = await store.createEpisode({ content: 'Original content' });
      const updated = await store.updateEpisode(episode.id, {
        content: 'Updated content',
        summary: 'A brief summary',
      });

      expect(updated.content).toBe('Updated content');
      expect(updated.summary).toBe('A brief summary');
    });

    it('should delete an episode', async () => {
      const episode = await store.createEpisode({ content: 'To be deleted' });
      await store.deleteEpisode(episode.id);

      const retrieved = await store.getEpisode(episode.id);
      expect(retrieved).toBeUndefined();
    });

    it('should throw NotFoundError for non-existent episode delete', async () => {
      await expect(store.deleteEpisode('non-existent')).rejects.toThrow('not found');
    });

    it('should list episodes with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createEpisode({ content: `Episode ${i}` });
      }

      const page1 = await store.listEpisodes({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await store.listEpisodes({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const count = await store.countEpisodes();
      expect(count).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  describe('facts', () => {
    it('should create and retrieve a fact', async () => {
      const fact = await store.createFact({
        category: 'user_preference',
        content: 'User prefers dark mode',
        confidence: 0.9,
      });

      expect(fact.id).toBeTruthy();
      expect(fact.category).toBe('user_preference');
      expect(fact.confidence).toBe(0.9);

      const retrieved = await store.getFact(fact.id);
      expect(retrieved).toEqual(fact);
    });

    it('should default confidence to 1.0', async () => {
      const fact = await store.createFact({
        category: 'environment',
        content: 'Running on macOS',
      });
      expect(fact.confidence).toBe(1.0);
    });

    it('should update a fact', async () => {
      const fact = await store.createFact({
        category: 'knowledge',
        content: 'Original fact',
      });

      // Small delay to ensure updatedAt differs
      await new Promise((r) => setTimeout(r, 5));

      const updated = await store.updateFact(fact.id, {
        content: 'Updated fact',
        confidence: 0.5,
      });

      expect(updated.content).toBe('Updated fact');
      expect(updated.confidence).toBe(0.5);
      expect(updated.updatedAt).not.toBe(fact.updatedAt);
    });

    it('should delete a fact', async () => {
      const fact = await store.createFact({
        category: 'knowledge',
        content: 'To be deleted',
      });
      await store.deleteFact(fact.id);

      const retrieved = await store.getFact(fact.id);
      expect(retrieved).toBeUndefined();
    });

    it('should find facts by content', async () => {
      await store.createFact({ category: 'user_preference', content: 'User likes dark mode' });
      await store.createFact({ category: 'user_preference', content: 'User likes light mode' });
      await store.createFact({ category: 'environment', content: 'Running on Linux' });

      const results = await store.findFactsByContent('mode');
      expect(results).toHaveLength(2);
    });

    it('should list facts with pagination', async () => {
      for (let i = 0; i < 3; i++) {
        await store.createFact({ category: 'knowledge', content: `Fact ${i}` });
      }

      const all = await store.listFacts();
      expect(all).toHaveLength(3);

      const count = await store.countFacts();
      expect(count).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Procedures
  // -------------------------------------------------------------------------

  describe('procedures', () => {
    it('should create and retrieve a procedure', async () => {
      const proc = await store.createProcedure({
        category: 'strategy',
        content: 'Always check for errors before proceeding',
      });

      expect(proc.id).toBeTruthy();
      expect(proc.category).toBe('strategy');
      expect(proc.successCount).toBe(0);
      expect(proc.failureCount).toBe(0);

      const retrieved = await store.getProcedure(proc.id);
      expect(retrieved).toEqual(proc);
    });

    it('should update a procedure', async () => {
      const proc = await store.createProcedure({
        category: 'pattern',
        content: 'Original procedure',
      });

      const updated = await store.updateProcedure(proc.id, {
        content: 'Updated procedure',
        successCount: 5,
      });

      expect(updated.content).toBe('Updated procedure');
      expect(updated.successCount).toBe(5);
    });

    it('should increment success count', async () => {
      const proc = await store.createProcedure({
        category: 'workflow',
        content: 'Test workflow',
      });

      await store.incrementProcedureSuccess(proc.id);
      await store.incrementProcedureSuccess(proc.id);

      const updated = await store.getProcedure(proc.id);
      expect(updated?.successCount).toBe(2);
    });

    it('should increment failure count', async () => {
      const proc = await store.createProcedure({
        category: 'strategy',
        content: 'Test strategy',
      });

      await store.incrementProcedureFailure(proc.id);

      const updated = await store.getProcedure(proc.id);
      expect(updated?.failureCount).toBe(1);
    });

    it('should delete a procedure', async () => {
      const proc = await store.createProcedure({
        category: 'pattern',
        content: 'To be deleted',
      });
      await store.deleteProcedure(proc.id);

      const retrieved = await store.getProcedure(proc.id);
      expect(retrieved).toBeUndefined();
    });

    it('should list and count procedures', async () => {
      for (let i = 0; i < 4; i++) {
        await store.createProcedure({ category: 'strategy', content: `Procedure ${i}` });
      }

      const all = await store.listProcedures();
      expect(all).toHaveLength(4);

      const count = await store.countProcedures();
      expect(count).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------

  describe('staging', () => {
    it('should create and list pending staged memories', async () => {
      await store.createStagedMemory({
        memoryType: 'semantic',
        content: 'Staged fact',
        category: 'knowledge',
      });

      const pending = await store.listPendingStagedMemories();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.content).toBe('Staged fact');
    });

    it('should reject a staged memory', async () => {
      const staged = await store.createStagedMemory({
        memoryType: 'episodic',
        content: 'Rejected memory',
      });

      await store.rejectStagedMemory(staged.id);

      const pending = await store.listPendingStagedMemories();
      expect(pending).toHaveLength(0);
    });

    it('should mark staged memory as promoted', async () => {
      const staged = await store.createStagedMemory({
        memoryType: 'procedural',
        content: 'Promoted memory',
        category: 'pattern',
      });

      await store.markStagedMemoryPromoted(staged.id);

      const pending = await store.listPendingStagedMemories();
      expect(pending).toHaveLength(0);

      const retrieved = await store.getStagedMemory(staged.id);
      expect(retrieved?.promotedAt).toBeTruthy();
    });

    it('should find staged memories ready for promotion', async () => {
      const id = 'old-staged-id';
      const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await db.run(
        'journal',
        `INSERT INTO memory_staging (id, memory_type, content, staged_at)
         VALUES (?, ?, ?, ?)`,
        [id, 'semantic', 'Old staged fact', pastDate],
      );

      const ready = await store.getStagedMemoriesReadyForPromotion(24 * 60 * 60 * 1000);
      expect(ready).toHaveLength(1);
      expect(ready[0]?.id).toBe(id);
    });
  });

  // -------------------------------------------------------------------------
  // User transparency
  // -------------------------------------------------------------------------

  describe('user transparency', () => {
    it('should export all memories', async () => {
      await store.createEpisode({ content: 'Episode 1' });
      await store.createFact({ category: 'knowledge', content: 'Fact 1' });
      await store.createProcedure({ category: 'strategy', content: 'Procedure 1' });

      const exported = await store.exportAll();
      expect(exported.episodes).toHaveLength(1);
      expect(exported.facts).toHaveLength(1);
      expect(exported.procedures).toHaveLength(1);
      expect(exported.exportedAt).toBeTruthy();
    });

    it('should delete all memories', async () => {
      await store.createEpisode({ content: 'Episode 1' });
      await store.createFact({ category: 'knowledge', content: 'Fact 1' });
      await store.createProcedure({ category: 'strategy', content: 'Procedure 1' });
      await store.createStagedMemory({ memoryType: 'episodic', content: 'Staged' });

      await store.deleteAll();

      expect(await store.countEpisodes()).toBe(0);
      expect(await store.countFacts()).toBe(0);
      expect(await store.countProcedures()).toBe(0);
    });
  });
});
