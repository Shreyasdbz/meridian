// @meridian/bridge — Cost tracking routes (Phase 9.5)
// REST endpoints for cost data retrieval.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@meridian/shared';
import { ValidationError } from '@meridian/shared';

import type { CostTracker } from '../../../shared/cost-tracker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostRouteOptions {
  costTracker: CostTracker;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) {
    throw new ValidationError(`${name} must be in YYYY-MM-DD format`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function costRoutes(
  server: FastifyInstance,
  options: CostRouteOptions,
): void {
  const { costTracker } = options;

  // GET /api/costs/daily?date=YYYY-MM-DD — Get daily cost summary
  server.get('/api/costs/daily', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          date: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const date = query['date']
      ? validateDate(query['date'], 'date')
      : new Date().toISOString().slice(0, 10);

    const summary = await costTracker.getDailyCost(date);
    const alertLevel = await costTracker.getAlertLevel(date);

    await reply.send({
      ...summary,
      dailyLimitUsd: costTracker.getDailyLimit(),
      alertLevel,
    });
  });

  // GET /api/costs/range?start=YYYY-MM-DD&end=YYYY-MM-DD — Get cost range
  server.get('/api/costs/range', {
    schema: {
      querystring: {
        type: 'object',
        required: ['start', 'end'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const start = validateDate(query['start'], 'start');
    const end = validateDate(query['end'], 'end');

    if (start > end) {
      throw new ValidationError('start date must not be after end date');
    }

    const summaries = await costTracker.getCostRange(start, end);

    await reply.send({
      items: summaries,
      total: summaries.length,
      startDate: start,
      endDate: end,
    });
  });

  // GET /api/costs/job/:id — Get cost for a specific job
  server.get<{ Params: { id: string } }>('/api/costs/job/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = request.params;
    const summary = await costTracker.getJobCost(id);
    await reply.send(summary);
  });
}
