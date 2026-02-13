// @meridian/bridge — Conversation routes (Section 5.5)
// CRUD operations on conversations with message retrieval.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ConversationStatus, DatabaseClient, Logger } from '@meridian/shared';
import { generateId, NotFoundError, ValidationError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationRouteOptions {
  db: DatabaseClient;
  logger: Logger;
}

interface ConversationRow {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  job_id: string | null;
  modality: string;
  attachments_json: string | null;
  created_at: string;
}

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

export function conversationRoutes(
  server: FastifyInstance,
  options: ConversationRouteOptions,
): void {
  const { db, logger } = options;

  // GET /api/conversations — List conversations
  server.get('/api/conversations', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['active', 'archived'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
            total: { type: 'integer' },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { limit, offset } = parsePagination(query);
    const statusFilter = query['status'] as string | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statusFilter) {
      conditions.push('status = ?');
      params.push(statusFilter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRows = await db.query<{ count: number }>(
      'meridian',
      `SELECT COUNT(*) as count FROM conversations ${where}`,
      params,
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await db.query<ConversationRow>(
      'meridian',
      `SELECT id, title, status, created_at, updated_at
       FROM conversations ${where}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const items = rows.map((r) => ({
      id: r.id,
      title: r.title ?? 'Untitled',
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    await reply.send({ items, total, hasMore: offset + limit < total });
  });

  // POST /api/conversations — Create new conversation
  server.post('/api/conversations', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (request.body ?? {}) as { title?: string };
    const id = generateId();
    const now = new Date().toISOString();
    const title = body.title ?? 'New Conversation';

    await db.run(
      'meridian',
      `INSERT INTO conversations (id, title, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
      [id, title, now, now],
    );

    logger.info('Conversation created', { conversationId: id, component: 'bridge' });

    await reply.status(201).send({
      id,
      title,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });

  // GET /api/conversations/:id — Get conversation with messages
  server.get<{ Params: { id: string } }>('/api/conversations/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  role: { type: 'string' },
                  content: { type: 'string' },
                  jobId: { type: 'string' },
                  modality: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
            },
            totalMessages: { type: 'integer' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { limit, offset } = parsePagination(query);

    const convRows = await db.query<ConversationRow>(
      'meridian',
      'SELECT id, title, status, created_at, updated_at FROM conversations WHERE id = ?',
      [id],
    );

    if (convRows.length === 0) {
      throw new NotFoundError(`Conversation '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conv = convRows[0]!;

    const countRows = await db.query<{ count: number }>(
      'meridian',
      'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
      [id],
    );
    const totalMessages = countRows[0]?.count ?? 0;

    const msgRows = await db.query<MessageRow>(
      'meridian',
      `SELECT id, conversation_id, role, content, job_id, modality, attachments_json, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`,
      [id, limit, offset],
    );

    const messages = msgRows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      jobId: m.job_id ?? undefined,
      modality: m.modality,
      createdAt: m.created_at,
    }));

    await reply.send({
      id: conv.id,
      title: conv.title ?? 'Untitled',
      status: conv.status,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      messages,
      totalMessages,
    });
  });

  // PUT /api/conversations/:id/archive — Archive conversation
  server.put<{ Params: { id: string } }>('/api/conversations/:id/archive', {
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
            status: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;

    const rows = await db.query<ConversationRow>(
      'meridian',
      'SELECT id, status FROM conversations WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Conversation '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conv = rows[0]!;

    if (conv.status === 'archived') {
      throw new ValidationError('Conversation is already archived');
    }

    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ?`,
      [now, id],
    );

    logger.info('Conversation archived', { conversationId: id, component: 'bridge' });

    await reply.send({
      id,
      status: 'archived' as ConversationStatus,
      updatedAt: now,
    });
  });
}
