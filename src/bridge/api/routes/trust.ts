// @meridian/bridge — Trust decision routes (Phase 10.3)
// REST endpoints for managing Sentinel Memory trust decisions.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Logger, SentinelDecision } from '@meridian/shared';

import type { SentinelMemory } from '../../../sentinel/memory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustRouteOptions {
  sentinelMemory: SentinelMemory;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function trustRoutes(
  server: FastifyInstance,
  options: TrustRouteOptions,
): void {
  const { sentinelMemory, logger } = options;

  // GET /api/trust/decisions — List all active trust decisions
  server.get('/api/trust/decisions', {
    schema: {
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
                  actionType: { type: 'string' },
                  scope: { type: 'string' },
                  verdict: { type: 'string' },
                  createdAt: { type: 'string' },
                  expiresAt: { type: 'string' },
                },
              },
            },
            count: { type: 'integer' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const items = await sentinelMemory.listActiveDecisions();
    await reply.send({
      items: items.map(formatDecision),
      count: items.length,
    });
  });

  // DELETE /api/trust/decisions/:id — Delete a specific trust decision
  server.delete<{ Params: { id: string } }>('/api/trust/decisions/:id', {
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
    const { id } = request.params;

    await sentinelMemory.deleteDecision(id);

    logger.info('Trust decision deleted via API', { id, component: 'bridge' });

    await reply.send({
      id,
      message: `Trust decision '${id}' deleted`,
    });
  });

  // POST /api/trust/decisions/prune — Prune expired decisions
  server.post('/api/trust/decisions/prune', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            pruned: { type: 'integer' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const pruned = await sentinelMemory.pruneExpired();

    logger.info('Trust decisions pruned via API', { pruned, component: 'bridge' });

    await reply.send({
      pruned,
      message: `Pruned ${pruned} expired trust decision(s)`,
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDecision(decision: SentinelDecision): Record<string, unknown> {
  return {
    id: decision.id,
    actionType: decision.actionType,
    scope: decision.scope,
    verdict: decision.verdict,
    createdAt: decision.createdAt,
    expiresAt: decision.expiresAt,
    conditions: decision.conditions,
    jobId: decision.jobId,
  };
}
