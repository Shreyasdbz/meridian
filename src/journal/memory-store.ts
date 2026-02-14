// @meridian/journal — Memory CRUD (Section 5.4.5, Phase 10.1)
//
// Provides create/read/update/delete operations for episodic, semantic,
// and procedural memories stored in journal.db. Follows the AuditLog
// pattern: constructor accepts { db, logger }, row-to-DTO mappers.
//
// User transparency: exportAll(), deleteAll(), isRecordingPaused().

import type {
  DatabaseClient,
  FactCategory,
  MemoryType,
  ProcedureCategory,
} from '@meridian/shared';
import { generateId, NotFoundError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryStoreLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface MemoryStoreOptions {
  db: DatabaseClient;
  logger?: MemoryStoreLogger;
}

// --- DTOs ---

export interface Episode {
  id: string;
  jobId?: string;
  content: string;
  summary?: string;
  createdAt: string;
  archivedAt?: string;
}

export interface Fact {
  id: string;
  category: FactCategory;
  content: string;
  confidence: number;
  sourceEpisodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Procedure {
  id: string;
  category: ProcedureCategory;
  content: string;
  successCount: number;
  failureCount: number;
  sourceEpisodeId?: string;
  createdAt: string;
  updatedAt: string;
}

export type Memory = Episode | Fact | Procedure;

// --- Create options ---

export interface CreateEpisodeOptions {
  content: string;
  jobId?: string;
  summary?: string;
}

export interface CreateFactOptions {
  category: FactCategory;
  content: string;
  confidence?: number;
  sourceEpisodeId?: string;
}

export interface CreateProcedureOptions {
  category: ProcedureCategory;
  content: string;
  sourceEpisodeId?: string;
}

// --- Update options ---

export interface UpdateEpisodeOptions {
  content?: string;
  summary?: string;
  archivedAt?: string;
}

export interface UpdateFactOptions {
  content?: string;
  confidence?: number;
  category?: FactCategory;
}

export interface UpdateProcedureOptions {
  content?: string;
  category?: ProcedureCategory;
  successCount?: number;
  failureCount?: number;
}

// --- List options ---

export interface ListOptions {
  limit?: number;
  offset?: number;
}

// --- Staging ---

export interface StagedMemory {
  id: string;
  memoryType: MemoryType;
  content: string;
  category?: string;
  confidence?: number;
  sourceEpisodeId?: string;
  jobId?: string;
  stagedAt: string;
  promotedAt?: string;
  rejectedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateStagedMemoryOptions {
  memoryType: MemoryType;
  content: string;
  category?: string;
  confidence?: number;
  sourceEpisodeId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
}

// --- Export ---

export interface MemoryExport {
  episodes: Episode[];
  facts: Fact[];
  procedures: Procedure[];
  exportedAt: string;
}

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface EpisodeRow {
  id: string;
  job_id: string | null;
  content: string;
  summary: string | null;
  created_at: string;
  archived_at: string | null;
}

interface FactRow {
  id: string;
  category: string;
  content: string;
  confidence: number;
  source_episode_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProcedureRow {
  id: string;
  category: string;
  content: string;
  success_count: number;
  failure_count: number;
  source_episode_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StagedMemoryRow {
  id: string;
  memory_type: string;
  content: string;
  category: string | null;
  confidence: number | null;
  source_episode_id: string | null;
  job_id: string | null;
  staged_at: string;
  promoted_at: string | null;
  rejected_at: string | null;
  metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// Row-to-DTO mappers
// ---------------------------------------------------------------------------

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    content: row.content,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    category: row.category as FactCategory,
    content: row.content,
    confidence: row.confidence,
    sourceEpisodeId: row.source_episode_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProcedure(row: ProcedureRow): Procedure {
  return {
    id: row.id,
    category: row.category as ProcedureCategory,
    content: row.content,
    successCount: row.success_count,
    failureCount: row.failure_count,
    sourceEpisodeId: row.source_episode_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStagedMemory(row: StagedMemoryRow): StagedMemory {
  return {
    id: row.id,
    memoryType: row.memory_type as MemoryType,
    content: row.content,
    category: row.category ?? undefined,
    confidence: row.confidence ?? undefined,
    sourceEpisodeId: row.source_episode_id ?? undefined,
    jobId: row.job_id ?? undefined,
    stagedAt: row.staged_at,
    promotedAt: row.promoted_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: MemoryStoreLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly db: DatabaseClient;
  private readonly logger: MemoryStoreLogger;

  constructor(options: MemoryStoreOptions) {
    this.db = options.db;
    this.logger = options.logger ?? noopLogger;
  }

  // -------------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------------

  async createEpisode(options: CreateEpisodeOptions): Promise<Episode> {
    const now = new Date().toISOString();
    const id = generateId();

    await this.db.run(
      'journal',
      `INSERT INTO episodes (id, job_id, content, summary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, options.jobId ?? null, options.content, options.summary ?? null, now],
    );

    this.logger.info('Episode created', { episodeId: id });

    return {
      id,
      jobId: options.jobId,
      content: options.content,
      summary: options.summary,
      createdAt: now,
    };
  }

  async getEpisode(id: string): Promise<Episode | undefined> {
    const rows = await this.db.query<EpisodeRow>(
      'journal',
      'SELECT * FROM episodes WHERE id = ?',
      [id],
    );
    return rows[0] ? rowToEpisode(rows[0]) : undefined;
  }

  async updateEpisode(id: string, options: UpdateEpisodeOptions): Promise<Episode> {
    const existing = await this.getEpisode(id);
    if (!existing) {
      throw new NotFoundError(`Episode '${id}' not found`);
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (options.content !== undefined) {
      setClauses.push('content = ?');
      params.push(options.content);
    }
    if (options.summary !== undefined) {
      setClauses.push('summary = ?');
      params.push(options.summary);
    }
    if (options.archivedAt !== undefined) {
      setClauses.push('archived_at = ?');
      params.push(options.archivedAt);
    }

    if (setClauses.length === 0) {
      return existing;
    }

    params.push(id);
    await this.db.run(
      'journal',
      `UPDATE episodes SET ${setClauses.join(', ')} WHERE id = ?`,
      params,
    );

    return {
      ...existing,
      content: options.content ?? existing.content,
      summary: options.summary ?? existing.summary,
      archivedAt: options.archivedAt ?? existing.archivedAt,
    };
  }

  async deleteEpisode(id: string): Promise<void> {
    const result = await this.db.run(
      'journal',
      'DELETE FROM episodes WHERE id = ?',
      [id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Episode '${id}' not found`);
    }
    this.logger.info('Episode deleted', { episodeId: id });
  }

  async listEpisodes(options: ListOptions = {}): Promise<Episode[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const rows = await this.db.query<EpisodeRow>(
      'journal',
      'SELECT * FROM episodes ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(rowToEpisode);
  }

  async countEpisodes(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      'journal',
      'SELECT COUNT(*) as count FROM episodes',
    );
    return rows[0]?.count ?? 0;
  }

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  async createFact(options: CreateFactOptions): Promise<Fact> {
    const now = new Date().toISOString();
    const id = generateId();

    await this.db.run(
      'journal',
      `INSERT INTO facts (id, category, content, confidence, source_episode_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.category,
        options.content,
        options.confidence ?? 1.0,
        options.sourceEpisodeId ?? null,
        now,
        now,
      ],
    );

    this.logger.info('Fact created', { factId: id, category: options.category });

    return {
      id,
      category: options.category,
      content: options.content,
      confidence: options.confidence ?? 1.0,
      sourceEpisodeId: options.sourceEpisodeId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getFact(id: string): Promise<Fact | undefined> {
    const rows = await this.db.query<FactRow>(
      'journal',
      'SELECT * FROM facts WHERE id = ?',
      [id],
    );
    return rows[0] ? rowToFact(rows[0]) : undefined;
  }

  async updateFact(id: string, options: UpdateFactOptions): Promise<Fact> {
    const existing = await this.getFact(id);
    if (!existing) {
      throw new NotFoundError(`Fact '${id}' not found`);
    }

    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (options.content !== undefined) {
      setClauses.push('content = ?');
      params.push(options.content);
    }
    if (options.confidence !== undefined) {
      setClauses.push('confidence = ?');
      params.push(options.confidence);
    }
    if (options.category !== undefined) {
      setClauses.push('category = ?');
      params.push(options.category);
    }

    params.push(id);
    await this.db.run(
      'journal',
      `UPDATE facts SET ${setClauses.join(', ')} WHERE id = ?`,
      params,
    );

    return {
      ...existing,
      content: options.content ?? existing.content,
      confidence: options.confidence ?? existing.confidence,
      category: options.category ?? existing.category,
      updatedAt: now,
    };
  }

  async deleteFact(id: string): Promise<void> {
    const result = await this.db.run(
      'journal',
      'DELETE FROM facts WHERE id = ?',
      [id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Fact '${id}' not found`);
    }
    this.logger.info('Fact deleted', { factId: id });
  }

  async listFacts(options: ListOptions = {}): Promise<Fact[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const rows = await this.db.query<FactRow>(
      'journal',
      'SELECT * FROM facts ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(rowToFact);
  }

  async countFacts(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      'journal',
      'SELECT COUNT(*) as count FROM facts',
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Find facts by content similarity (exact substring for now).
   * Used by contradiction detection in MemoryWriter.
   */
  async findFactsByContent(keyword: string): Promise<Fact[]> {
    const rows = await this.db.query<FactRow>(
      'journal',
      'SELECT * FROM facts WHERE content LIKE ? ORDER BY confidence DESC LIMIT 20',
      [`%${keyword}%`],
    );
    return rows.map(rowToFact);
  }

  // -------------------------------------------------------------------------
  // Procedures
  // -------------------------------------------------------------------------

  async createProcedure(options: CreateProcedureOptions): Promise<Procedure> {
    const now = new Date().toISOString();
    const id = generateId();

    await this.db.run(
      'journal',
      `INSERT INTO procedures (id, category, content, success_count, failure_count, source_episode_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?)`,
      [
        id,
        options.category,
        options.content,
        options.sourceEpisodeId ?? null,
        now,
        now,
      ],
    );

    this.logger.info('Procedure created', { procedureId: id, category: options.category });

    return {
      id,
      category: options.category,
      content: options.content,
      successCount: 0,
      failureCount: 0,
      sourceEpisodeId: options.sourceEpisodeId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getProcedure(id: string): Promise<Procedure | undefined> {
    const rows = await this.db.query<ProcedureRow>(
      'journal',
      'SELECT * FROM procedures WHERE id = ?',
      [id],
    );
    return rows[0] ? rowToProcedure(rows[0]) : undefined;
  }

  async updateProcedure(id: string, options: UpdateProcedureOptions): Promise<Procedure> {
    const existing = await this.getProcedure(id);
    if (!existing) {
      throw new NotFoundError(`Procedure '${id}' not found`);
    }

    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (options.content !== undefined) {
      setClauses.push('content = ?');
      params.push(options.content);
    }
    if (options.category !== undefined) {
      setClauses.push('category = ?');
      params.push(options.category);
    }
    if (options.successCount !== undefined) {
      setClauses.push('success_count = ?');
      params.push(options.successCount);
    }
    if (options.failureCount !== undefined) {
      setClauses.push('failure_count = ?');
      params.push(options.failureCount);
    }

    params.push(id);
    await this.db.run(
      'journal',
      `UPDATE procedures SET ${setClauses.join(', ')} WHERE id = ?`,
      params,
    );

    return {
      ...existing,
      content: options.content ?? existing.content,
      category: options.category ?? existing.category,
      successCount: options.successCount ?? existing.successCount,
      failureCount: options.failureCount ?? existing.failureCount,
      updatedAt: now,
    };
  }

  async deleteProcedure(id: string): Promise<void> {
    const result = await this.db.run(
      'journal',
      'DELETE FROM procedures WHERE id = ?',
      [id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Procedure '${id}' not found`);
    }
    this.logger.info('Procedure deleted', { procedureId: id });
  }

  async listProcedures(options: ListOptions = {}): Promise<Procedure[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const rows = await this.db.query<ProcedureRow>(
      'journal',
      'SELECT * FROM procedures ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(rowToProcedure);
  }

  async countProcedures(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      'journal',
      'SELECT COUNT(*) as count FROM procedures',
    );
    return rows[0]?.count ?? 0;
  }

  async incrementProcedureSuccess(id: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      'journal',
      'UPDATE procedures SET success_count = success_count + 1, updated_at = ? WHERE id = ?',
      [now, id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Procedure '${id}' not found`);
    }
  }

  async incrementProcedureFailure(id: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      'journal',
      'UPDATE procedures SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?',
      [now, id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Procedure '${id}' not found`);
    }
  }

  // -------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------

  async createStagedMemory(options: CreateStagedMemoryOptions): Promise<StagedMemory> {
    const now = new Date().toISOString();
    const id = generateId();

    await this.db.run(
      'journal',
      `INSERT INTO memory_staging
        (id, memory_type, content, category, confidence, source_episode_id, job_id, staged_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.memoryType,
        options.content,
        options.category ?? null,
        options.confidence ?? null,
        options.sourceEpisodeId ?? null,
        options.jobId ?? null,
        now,
        options.metadata ? JSON.stringify(options.metadata) : null,
      ],
    );

    this.logger.info('Staged memory created', { id, type: options.memoryType });

    return {
      id,
      memoryType: options.memoryType,
      content: options.content,
      category: options.category,
      confidence: options.confidence,
      sourceEpisodeId: options.sourceEpisodeId,
      jobId: options.jobId,
      stagedAt: now,
      metadata: options.metadata,
    };
  }

  async getStagedMemory(id: string): Promise<StagedMemory | undefined> {
    const rows = await this.db.query<StagedMemoryRow>(
      'journal',
      'SELECT * FROM memory_staging WHERE id = ?',
      [id],
    );
    return rows[0] ? rowToStagedMemory(rows[0]) : undefined;
  }

  async listPendingStagedMemories(): Promise<StagedMemory[]> {
    const rows = await this.db.query<StagedMemoryRow>(
      'journal',
      'SELECT * FROM memory_staging WHERE promoted_at IS NULL AND rejected_at IS NULL ORDER BY staged_at ASC',
    );
    return rows.map(rowToStagedMemory);
  }

  async rejectStagedMemory(id: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      'journal',
      'UPDATE memory_staging SET rejected_at = ? WHERE id = ? AND promoted_at IS NULL AND rejected_at IS NULL',
      [now, id],
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Staged memory '${id}' not found or already processed`);
    }
    this.logger.info('Staged memory rejected', { id });
  }

  async markStagedMemoryPromoted(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      'journal',
      'UPDATE memory_staging SET promoted_at = ? WHERE id = ?',
      [now, id],
    );
  }

  /**
   * Get staged memories older than the given threshold that are ready for promotion.
   */
  async getStagedMemoriesReadyForPromotion(olderThanMs: number): Promise<StagedMemory[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = await this.db.query<StagedMemoryRow>(
      'journal',
      `SELECT * FROM memory_staging
       WHERE promoted_at IS NULL AND rejected_at IS NULL AND staged_at < ?
       ORDER BY staged_at ASC`,
      [cutoff],
    );
    return rows.map(rowToStagedMemory);
  }

  // -------------------------------------------------------------------------
  // User transparency
  // -------------------------------------------------------------------------

  async exportAll(): Promise<MemoryExport> {
    const episodes = await this.db.query<EpisodeRow>(
      'journal',
      'SELECT * FROM episodes ORDER BY created_at ASC',
    );
    const facts = await this.db.query<FactRow>(
      'journal',
      'SELECT * FROM facts ORDER BY created_at ASC',
    );
    const procedures = await this.db.query<ProcedureRow>(
      'journal',
      'SELECT * FROM procedures ORDER BY created_at ASC',
    );

    return {
      episodes: episodes.map(rowToEpisode),
      facts: facts.map(rowToFact),
      procedures: procedures.map(rowToProcedure),
      exportedAt: new Date().toISOString(),
    };
  }

  async deleteAll(): Promise<void> {
    await this.db.exec('journal', 'DELETE FROM memory_staging');
    await this.db.exec('journal', 'DELETE FROM memory_embeddings');
    await this.db.exec('journal', 'DELETE FROM procedures');
    await this.db.exec('journal', 'DELETE FROM facts');
    await this.db.exec('journal', 'DELETE FROM episodes');
    this.logger.info('All memories deleted');
  }

  async isRecordingPaused(meridianDb: DatabaseClient): Promise<boolean> {
    const rows = await meridianDb.query<{ value: string }>(
      'meridian',
      "SELECT value FROM config WHERE key = 'memory.paused'",
    );
    return rows[0]?.value === 'true';
  }
}
