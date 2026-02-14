// @meridian/bridge — Schedule routes (Phase 9.4)
// CRUD REST endpoints for cron schedules.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Logger } from '@meridian/shared';
import { NotFoundError, ValidationError, generateId } from '@meridian/shared';

import {
  getNextRun,
  isValidCronExpression,
  parseCronExpression,
} from '../../../axis/cron-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleRouteOptions {
  db: DatabaseClient;
  logger: Logger;
}

interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  job_template_json: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

interface ScheduleResponse {
  id: string;
  name: string;
  cronExpression: string;
  jobTemplate: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSchedule(row: ScheduleRow): ScheduleResponse {
  return {
    id: row.id,
    name: row.name,
    cronExpression: row.cron_expression,
    jobTemplate: JSON.parse(row.job_template_json) as Record<string, unknown>,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}

function calculateNextRun(cronExpression: string): string | null {
  try {
    const schedule = parseCronExpression(cronExpression);
    const next = getNextRun(schedule);
    return next?.toISOString() ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function scheduleRoutes(
  server: FastifyInstance,
  options: ScheduleRouteOptions,
): void {
  const { db, logger } = options;

  // GET /api/schedules — List all schedules
  server.get('/api/schedules', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            items: { type: 'array' },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const rows = await db.query<ScheduleRow>(
      'meridian',
      'SELECT * FROM schedules ORDER BY created_at DESC',
      [],
    );

    const items = rows.map(rowToSchedule);
    await reply.send({ items, total: items.length });
  });

  // POST /api/schedules — Create a new schedule
  server.post('/api/schedules', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'cronExpression'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          cronExpression: { type: 'string', minLength: 1 },
          jobTemplate: { type: 'object' },
          enabled: { type: 'boolean' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            cronExpression: { type: 'string' },
            enabled: { type: 'boolean' },
            nextRunAt: { type: ['string', 'null'] },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as {
      name: string;
      cronExpression: string;
      jobTemplate?: Record<string, unknown>;
      enabled?: boolean;
    };

    // Validate cron expression
    if (!isValidCronExpression(body.cronExpression)) {
      throw new ValidationError(`Invalid cron expression: ${body.cronExpression}`);
    }

    const id = generateId();
    const now = new Date().toISOString();
    const enabled = body.enabled !== false;
    const jobTemplate = body.jobTemplate ?? {};
    const nextRunAt = enabled ? calculateNextRun(body.cronExpression) : null;

    await db.run(
      'meridian',
      `INSERT INTO schedules (id, name, cron_expression, job_template_json, enabled, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, body.name, body.cronExpression, JSON.stringify(jobTemplate), enabled ? 1 : 0, nextRunAt, now],
    );

    logger.info('Schedule created', {
      scheduleId: id,
      name: body.name,
      component: 'bridge',
    });

    await reply.status(201).send({
      id,
      name: body.name,
      cronExpression: body.cronExpression,
      jobTemplate,
      enabled,
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
    });
  });

  // PUT /api/schedules/:id — Update a schedule
  server.put<{ Params: { id: string } }>('/api/schedules/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          cronExpression: { type: 'string', minLength: 1 },
          jobTemplate: { type: 'object' },
        },
      },
    },
  }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = request.params;
    const body = request.body as {
      name?: string;
      cronExpression?: string;
      jobTemplate?: Record<string, unknown>;
    };

    // Check existence
    const rows = await db.query<ScheduleRow>(
      'meridian',
      'SELECT * FROM schedules WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Schedule '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const existing = rows[0]!;

    // Validate new cron expression if provided
    const cronExpression = body.cronExpression ?? existing.cron_expression;
    if (body.cronExpression && !isValidCronExpression(body.cronExpression)) {
      throw new ValidationError(`Invalid cron expression: ${body.cronExpression}`);
    }

    const name = body.name ?? existing.name;
    const jobTemplate = body.jobTemplate
      ? JSON.stringify(body.jobTemplate)
      : existing.job_template_json;
    const nextRunAt = existing.enabled === 1 ? calculateNextRun(cronExpression) : null;

    await db.run(
      'meridian',
      `UPDATE schedules SET name = ?, cron_expression = ?, job_template_json = ?, next_run_at = ?
       WHERE id = ?`,
      [name, cronExpression, jobTemplate, nextRunAt, id],
    );

    logger.info('Schedule updated', {
      scheduleId: id,
      component: 'bridge',
    });

    // Re-fetch for response
    const updated = await db.query<ScheduleRow>(
      'meridian',
      'SELECT * FROM schedules WHERE id = ?',
      [id],
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await reply.send(rowToSchedule(updated[0]!));
  });

  // DELETE /api/schedules/:id — Delete a schedule
  server.delete<{ Params: { id: string } }>('/api/schedules/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = request.params;

    const result = await db.run(
      'meridian',
      'DELETE FROM schedules WHERE id = ?',
      [id],
    );

    if (result.changes === 0) {
      throw new NotFoundError(`Schedule '${id}' not found`);
    }

    logger.info('Schedule deleted', {
      scheduleId: id,
      component: 'bridge',
    });

    await reply.send({ id, deleted: true });
  });

  // POST /api/schedules/:id/toggle — Enable/disable a schedule
  server.post<{ Params: { id: string } }>('/api/schedules/:id/toggle', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = request.params;

    const rows = await db.query<ScheduleRow>(
      'meridian',
      'SELECT * FROM schedules WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Schedule '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const schedule = rows[0]!;
    const newEnabled = schedule.enabled === 0;
    const nextRunAt = newEnabled ? calculateNextRun(schedule.cron_expression) : null;

    await db.run(
      'meridian',
      'UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?',
      [newEnabled ? 1 : 0, nextRunAt, id],
    );

    logger.info('Schedule toggled', {
      scheduleId: id,
      enabled: newEnabled,
      component: 'bridge',
    });

    await reply.send({ id, enabled: newEnabled, nextRunAt });
  });
}
