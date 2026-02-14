// @meridian/bridge — Data management routes (Phase 10.6)
// POST /api/data/delete-all — Delete all user data (right to deletion)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Logger } from '@meridian/shared';
import { deleteAllUserData } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataRouteOptions {
  db: DatabaseClient;
  dataDir: string;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function dataRoutes(
  server: FastifyInstance,
  options: DataRouteOptions,
): void {
  const { db, dataDir, logger } = options;

  // POST /api/data/delete-all — Delete all user data
  server.post('/api/data/delete-all', {
    schema: {
      body: {
        type: 'object',
        required: ['confirm'],
        properties: {
          confirm: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            executed: { type: 'boolean' },
            deleted: { type: 'object' },
            retained: { type: 'array', items: { type: 'string' } },
            durationMs: { type: 'number' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: async (
      request: FastifyRequest<{ Body: { confirm: boolean } }>,
      reply: FastifyReply,
    ) => {
      const { confirm } = request.body;

      if (!confirm) {
        return reply.status(400).send({
          error: 'Data deletion requires { confirm: true }. This action is irreversible.',
        });
      }

      logger.warn('User-initiated data deletion requested');

      const result = await deleteAllUserData({
        db,
        dataDir,
        confirm: true,
        logger,
      });

      return reply.send(result);
    },
  });
}
