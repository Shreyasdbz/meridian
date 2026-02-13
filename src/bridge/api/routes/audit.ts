// @meridian/bridge — Audit routes (Section 6.6)
// Query the append-only audit log with date range, actor, and action filters.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuditActor, AuditEntry, Logger, RiskLevel } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Query options for filtering audit entries (local to bridge). */
export interface QueryAuditOptions {
  actor?: AuditActor;
  action?: string;
  riskLevel?: RiskLevel;
  jobId?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

/** Minimal audit log reader interface for bridge dependency boundary. */
export interface AuditLogReader {
  query(options: QueryAuditOptions, date?: Date): Promise<AuditEntry[]>;
  count(options: Pick<QueryAuditOptions, 'actor' | 'action' | 'riskLevel' | 'jobId'>, date?: Date): Promise<number>;
}

export interface AuditRouteOptions {
  auditLog: AuditLogReader;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function auditRoutes(
  server: FastifyInstance,
  options: AuditRouteOptions,
): void {
  const { auditLog } = options;

  // GET /api/audit — Query audit log with date range, actor, action filters
  server.get('/api/audit', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          actor: { type: 'string', enum: ['user', 'scout', 'sentinel', 'axis', 'gear'] },
          action: { type: 'string' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          jobId: { type: 'string' },
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          offset: { type: 'integer', minimum: 0 },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        },
      },
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
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;

    const queryOptions: QueryAuditOptions = {};

    if (query['actor']) {
      queryOptions.actor = query['actor'] as AuditActor;
    }
    if (query['action']) {
      queryOptions.action = query['action'] as string;
    }
    if (query['riskLevel']) {
      queryOptions.riskLevel = query['riskLevel'] as RiskLevel;
    }
    if (query['jobId']) {
      queryOptions.jobId = query['jobId'] as string;
    }
    if (query['startTime']) {
      queryOptions.startTime = query['startTime'] as string;
    }
    if (query['endTime']) {
      queryOptions.endTime = query['endTime'] as string;
    }
    if (query['limit']) {
      queryOptions.limit = Number(query['limit']);
    }
    if (query['offset']) {
      queryOptions.offset = Number(query['offset']);
    }

    // Determine the month to query (defaults to current)
    let date = new Date();
    if (query['month']) {
      const monthStr = query['month'] as string;
      const [year, month] = monthStr.split('-').map(Number);
      if (year !== undefined && month !== undefined) {
        date = new Date(year, month - 1, 1);
      }
    }

    const items = await auditLog.query(queryOptions, date);

    // Get total count for pagination info
    const countOptions: Pick<QueryAuditOptions, 'actor' | 'action' | 'riskLevel' | 'jobId'> = {};
    if (queryOptions.actor) countOptions.actor = queryOptions.actor;
    if (queryOptions.action) countOptions.action = queryOptions.action;
    if (queryOptions.riskLevel) countOptions.riskLevel = queryOptions.riskLevel;
    if (queryOptions.jobId) countOptions.jobId = queryOptions.jobId;

    const total = await auditLog.count(countOptions, date);

    await reply.send({ items, total });
  });
}
