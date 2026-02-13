// @meridian/bridge — Memory routes (Section 5.4.5)
// CRUD for Journal memories. Stubbed in v0.1; wired to full Journal in Phase 10.1.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Logger, MemoryType } from '@meridian/shared';
import { NotFoundError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryRouteOptions {
  db: DatabaseClient;
  logger: Logger;
}

// v0.1 stub: memories are stored in a simple table in meridian.db.
// In Phase 10.1, this will be wired to journal.db with vector embeddings.

// ---------------------------------------------------------------------------
// Pagination defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(
    Math.max(1, Number(query['limit']) || DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Number(query['offset']) || 0);
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function memoryRoutes(
  server: FastifyInstance,
  options: MemoryRouteOptions,
): void {
  const { db, logger } = options;

  // Ensure the v0.1 stub memories table exists
  const ensureTable = async (): Promise<void> => {
    await db.exec(
      'meridian',
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'episodic',
        content TEXT NOT NULL,
        source TEXT,
        linked_gear_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
      )`,
    );
  };

  // Initialize the stub table
  let tableReady: Promise<void> | null = null;
  const getReady = (): Promise<void> => {
    if (!tableReady) {
      tableReady = ensureTable();
    }
    return tableReady;
  };

  interface MemoryRow {
    id: string;
    type: string;
    content: string;
    source: string | null;
    linked_gear_id: string | null;
    created_at: string;
    updated_at: string;
    metadata_json: string | null;
  }

  // GET /api/memories — List memories (filter by type, keyword; paginated)
  server.get('/api/memories', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
          type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
          keyword: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: { type: 'array' },
            total: { type: 'integer' },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await getReady();
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { limit, offset } = parsePagination(query);
    const typeFilter = query['type'] as string | undefined;
    const keyword = query['keyword'] as string | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (typeFilter) {
      conditions.push('type = ?');
      params.push(typeFilter);
    }
    if (keyword) {
      conditions.push('content LIKE ?');
      params.push(`%${keyword}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRows = await db.query<{ count: number }>(
      'meridian',
      `SELECT COUNT(*) as count FROM memories ${where}`,
      params,
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await db.query<MemoryRow>(
      'meridian',
      `SELECT * FROM memories ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const items = rows.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      source: r.source ?? undefined,
      linkedGearId: r.linked_gear_id ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata_json
        ? (JSON.parse(r.metadata_json) as Record<string, unknown>)
        : undefined,
    }));

    await reply.send({ items, total, hasMore: offset + limit < total });
  });

  // PUT /api/memories/:id — Update a memory entry
  server.put<{ Params: { id: string } }>('/api/memories/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
          metadata: { type: 'object' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            content: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    await getReady();
    const { id } = request.params;
    const body = request.body as {
      content?: string;
      type?: MemoryType;
      metadata?: Record<string, unknown>;
    };

    const rows = await db.query<MemoryRow>(
      'meridian',
      'SELECT * FROM memories WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Memory '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const existing = rows[0]!;
    const now = new Date().toISOString();

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (body.content !== undefined) {
      setClauses.push('content = ?');
      params.push(body.content);
    }
    if (body.type !== undefined) {
      setClauses.push('type = ?');
      params.push(body.type);
    }
    if (body.metadata !== undefined) {
      setClauses.push('metadata_json = ?');
      params.push(JSON.stringify(body.metadata));
    }

    params.push(id);

    await db.run(
      'meridian',
      `UPDATE memories SET ${setClauses.join(', ')} WHERE id = ?`,
      params,
    );

    logger.info('Memory updated', { memoryId: id, component: 'bridge' });

    await reply.send({
      id,
      type: body.type ?? existing.type,
      content: body.content ?? existing.content,
      updatedAt: now,
    });
  });

  // DELETE /api/memories/:id — Delete a memory entry
  server.delete<{ Params: { id: string } }>('/api/memories/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    await getReady();
    const { id } = request.params;

    const rows = await db.query<{ id: string }>(
      'meridian',
      'SELECT id FROM memories WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Memory '${id}' not found`);
    }

    await db.run(
      'meridian',
      'DELETE FROM memories WHERE id = ?',
      [id],
    );

    logger.info('Memory deleted', { memoryId: id, component: 'bridge' });

    await reply.send({ id, message: 'Memory deleted' });
  });

  // POST /api/memories/export — Export memories (JSON/Markdown)
  server.post('/api/memories/export', {
    schema: {
      body: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'markdown'] },
          type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            format: { type: 'string' },
            count: { type: 'integer' },
            data: {},
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await getReady();
    const body = (request.body ?? {}) as { format?: string; type?: string };
    const format = body.format ?? 'json';
    const typeFilter = body.type;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (typeFilter) {
      conditions.push('type = ?');
      params.push(typeFilter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await db.query<MemoryRow>(
      'meridian',
      `SELECT * FROM memories ${where} ORDER BY created_at ASC`,
      params,
    );

    if (format === 'markdown') {
      const lines = rows.map((r) =>
        `## ${r.type}: ${r.id}\n\n${r.content}\n\n*Created: ${r.created_at}*\n`,
      );
      await reply.send({
        format: 'markdown',
        count: rows.length,
        data: lines.join('\n---\n\n'),
      });
    } else {
      const data = rows.map((r) => ({
        id: r.id,
        type: r.type,
        content: r.content,
        source: r.source ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        metadata: r.metadata_json
          ? (JSON.parse(r.metadata_json) as Record<string, unknown>)
          : undefined,
      }));
      await reply.send({ format: 'json', count: data.length, data });
    }
  });

  // PUT /api/memories/pause — Pause/resume memory recording
  server.put('/api/memories/pause', {
    schema: {
      body: {
        type: 'object',
        required: ['paused'],
        properties: {
          paused: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            paused: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as { paused: boolean };
    const now = new Date().toISOString();

    // Store the pause state in config table
    await db.run(
      'meridian',
      `INSERT INTO config (key, value, updated_at) VALUES ('memory.paused', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [body.paused ? 'true' : 'false', now],
    );

    logger.info('Memory recording state changed', {
      paused: body.paused,
      component: 'bridge',
    });

    await reply.send({
      paused: body.paused,
      message: body.paused ? 'Memory recording paused' : 'Memory recording resumed',
    });
  });
}
