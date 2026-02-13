// @meridian/bridge — Message routes (Section 5.5)
// Send messages (creates jobs via Axis) and list conversation messages.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Job, Logger } from '@meridian/shared';
import { generateId, NotFoundError, ValidationError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Axis interface for message routes (avoids bridge → axis dependency). */
interface MessageAxisAdapter {
  createJob(options: {
    conversationId?: string;
    source: 'user' | 'schedule' | 'webhook' | 'sub-job';
    sourceMessageId?: string;
  }): Promise<Job>;
}

export interface MessageRouteOptions {
  db: DatabaseClient;
  logger: Logger;
  /** When provided, jobs are created via Axis instead of direct SQL INSERT. */
  axis?: MessageAxisAdapter;
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

export function messageRoutes(
  server: FastifyInstance,
  options: MessageRouteOptions,
): void {
  const { db, logger, axis } = options;

  // POST /api/messages — Send message (creates job via Axis)
  server.post('/api/messages', {
    schema: {
      body: {
        type: 'object',
        required: ['conversationId', 'content'],
        properties: {
          conversationId: { type: 'string' },
          content: { type: 'string', minLength: 1, maxLength: 100000 },
          modality: { type: 'string', enum: ['text', 'voice', 'image', 'video'] },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            conversationId: { type: 'string' },
            jobId: { type: 'string' },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as {
      conversationId: string;
      content: string;
      modality?: string;
    };

    // Verify conversation exists and is active
    const convRows = await db.query<{ id: string; status: string }>(
      'meridian',
      'SELECT id, status FROM conversations WHERE id = ?',
      [body.conversationId],
    );

    if (convRows.length === 0) {
      throw new NotFoundError(`Conversation '${body.conversationId}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (convRows[0]!.status === 'archived') {
      throw new ValidationError('Cannot send messages to an archived conversation');
    }

    const messageId = generateId();
    const now = new Date().toISOString();
    const modality = body.modality ?? 'text';

    // Create the pending job — via Axis when available, direct SQL otherwise
    let jobId: string;
    if (axis) {
      const job = await axis.createJob({
        conversationId: body.conversationId,
        source: 'user',
        sourceMessageId: messageId,
      });
      jobId = job.id;
    } else {
      jobId = generateId();
      await db.run(
        'meridian',
        `INSERT INTO jobs (id, conversation_id, status, priority, source_type, source_message_id, created_at, updated_at)
         VALUES (?, ?, 'pending', 'normal', 'user', ?, ?, ?)`,
        [jobId, body.conversationId, messageId, now, now],
      );
    }

    // Create the user message
    await db.run(
      'meridian',
      `INSERT INTO messages (id, conversation_id, role, content, job_id, modality, created_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      [messageId, body.conversationId, body.content, jobId, modality, now],
    );

    // Update conversation's updated_at timestamp
    await db.run(
      'meridian',
      'UPDATE conversations SET updated_at = ? WHERE id = ?',
      [now, body.conversationId],
    );

    logger.info('Message created with job', {
      messageId,
      jobId,
      conversationId: body.conversationId,
      component: 'bridge',
    });

    await reply.status(201).send({
      id: messageId,
      conversationId: body.conversationId,
      jobId,
      createdAt: now,
    });
  });

  // GET /api/messages — List conversation messages (with pagination)
  server.get('/api/messages', {
    schema: {
      querystring: {
        type: 'object',
        required: ['conversationId'],
        properties: {
          conversationId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
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
                  conversationId: { type: 'string' },
                  role: { type: 'string' },
                  content: { type: 'string' },
                  jobId: { type: 'string' },
                  modality: { type: 'string' },
                  createdAt: { type: 'string' },
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
    const conversationId = query['conversationId'] as string;
    const { limit, offset } = parsePagination(query);

    // Verify conversation exists
    const convRows = await db.query<{ id: string }>(
      'meridian',
      'SELECT id FROM conversations WHERE id = ?',
      [conversationId],
    );

    if (convRows.length === 0) {
      throw new NotFoundError(`Conversation '${conversationId}' not found`);
    }

    const countRows = await db.query<{ count: number }>(
      'meridian',
      'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
      [conversationId],
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await db.query<MessageRow>(
      'meridian',
      `SELECT id, conversation_id, role, content, job_id, modality, attachments_json, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`,
      [conversationId, limit, offset],
    );

    const items = rows.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      role: m.role,
      content: m.content,
      jobId: m.job_id ?? undefined,
      modality: m.modality,
      createdAt: m.created_at,
    }));

    await reply.send({ items, total, hasMore: offset + limit < total });
  });
}
