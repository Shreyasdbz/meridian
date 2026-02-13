// @meridian/bridge — Job routes (Section 5.1)
// List, get details, approve, and cancel jobs.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type {
  DatabaseClient,
  ExecutionPlan,
  Job,
  JobPriority,
  JobSource,
  JobStatus,
  Logger,
  ValidationResult,
} from '@meridian/shared';
import { ConflictError, NotFoundError, ValidationError } from '@meridian/shared';

import type { AuthService } from '../auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobRouteOptions {
  db: DatabaseClient;
  logger: Logger;
  authService: AuthService;
}

interface JobRow {
  id: string;
  parent_id: string | null;
  conversation_id: string | null;
  status: string;
  priority: string;
  source_type: string;
  source_message_id: string | null;
  dedup_hash: string | null;
  worker_id: string | null;
  plan_json: string | null;
  validation_json: string | null;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
  revision_count: number;
  replan_count: number;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(
    Math.max(1, Number(query['limit']) || DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Number(query['offset']) || 0);
  return { limit, offset };
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conversationId: row.conversation_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    priority: row.priority as JobPriority,
    source: row.source_type as JobSource,
    workerId: row.worker_id ?? undefined,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as ExecutionPlan) : undefined,
    validation: row.validation_json
      ? (JSON.parse(row.validation_json) as ValidationResult)
      : undefined,
    result: row.result_json
      ? (JSON.parse(row.result_json) as Record<string, unknown>)
      : undefined,
    error: row.error_json
      ? (JSON.parse(row.error_json) as { code: string; message: string; retriable: boolean })
      : undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    completedAt: row.completed_at ?? undefined,
    revisionCount: row.revision_count,
    replanCount: row.replan_count,
    dedupHash: row.dedup_hash ?? undefined,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function jobRoutes(
  server: FastifyInstance,
  options: JobRouteOptions,
): void {
  const { db, logger, authService } = options;

  // GET /api/jobs — List jobs (with status filter, pagination)
  server.get('/api/jobs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
          status: {
            type: 'string',
            enum: [
              'pending', 'planning', 'validating', 'awaiting_approval',
              'executing', 'completed', 'failed', 'cancelled',
            ],
          },
          conversationId: { type: 'string' },
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
    const query = (request.query ?? {}) as Record<string, unknown>;
    const { limit, offset } = parsePagination(query);
    const statusFilter = query['status'] as string | undefined;
    const conversationId = query['conversationId'] as string | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statusFilter) {
      conditions.push('status = ?');
      params.push(statusFilter);
    }
    if (conversationId) {
      conditions.push('conversation_id = ?');
      params.push(conversationId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRows = await db.query<{ count: number }>(
      'meridian',
      `SELECT COUNT(*) as count FROM jobs ${where}`,
      params,
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await db.query<JobRow>(
      'meridian',
      `SELECT * FROM jobs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const items = rows.map(rowToJob);

    await reply.send({ items, total, hasMore: offset + limit < total });
  });

  // GET /api/jobs/:id — Get job details (plan, validation, result, error)
  server.get<{ Params: { id: string } }>('/api/jobs/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;

    const rows = await db.query<JobRow>(
      'meridian',
      'SELECT * FROM jobs WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Job '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const job = rowToJob(rows[0]!);
    await reply.send(job);
  });

  // POST /api/jobs/:id/approve — Approve pending job (requires per-job nonce)
  server.post<{ Params: { id: string } }>('/api/jobs/:id/approve', {
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
        required: ['nonce'],
        properties: {
          nonce: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;
    const body = request.body as { nonce: string };

    // Validate the approval nonce
    const nonceValid = await authService.validateApprovalNonce(id, body.nonce);
    if (!nonceValid) {
      throw new ValidationError('Invalid or expired approval nonce');
    }

    // Get the job
    const rows = await db.query<JobRow>(
      'meridian',
      'SELECT * FROM jobs WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Job '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const row = rows[0]!;

    if (row.status !== 'awaiting_approval') {
      throw new ConflictError(
        `Job '${id}' is in status '${row.status}', expected 'awaiting_approval'`,
      );
    }

    // Transition to executing
    const now = new Date().toISOString();
    const result = await db.run(
      'meridian',
      `UPDATE jobs SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'awaiting_approval'`,
      [now, id],
    );

    if (result.changes === 0) {
      throw new ConflictError(`Job '${id}' state changed concurrently`);
    }

    logger.info('Job approved', { jobId: id, component: 'bridge' });

    await reply.send({
      id,
      status: 'executing',
      message: 'Job approved and queued for execution',
    });
  });

  // POST /api/jobs/:id/cancel — Cancel a job
  server.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', {
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
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;

    const rows = await db.query<JobRow>(
      'meridian',
      'SELECT * FROM jobs WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Job '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const row = rows[0]!;

    if (TERMINAL_STATES.has(row.status)) {
      throw new ConflictError(
        `Job '${id}' is in terminal status '${row.status}' and cannot be cancelled`,
      );
    }

    const now = new Date().toISOString();
    const result = await db.run(
      'meridian',
      `UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
      [now, now, id, row.status],
    );

    if (result.changes === 0) {
      throw new ConflictError(`Job '${id}' state changed concurrently`);
    }

    logger.info('Job cancelled', { jobId: id, component: 'bridge' });

    await reply.send({
      id,
      status: 'cancelled',
      message: 'Job cancelled',
    });
  });
}
