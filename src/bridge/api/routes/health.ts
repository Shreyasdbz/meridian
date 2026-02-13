// @meridian/bridge — Health check routes (Section 12.3)
// Provides liveness, readiness, and full health check endpoints.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Logger } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthRouteOptions {
  db: DatabaseClient;
  logger: Logger;
  /** Callback to check if the server has completed full startup. */
  isReady: () => boolean;
  /** Callback to get component health status. */
  getComponentStatus?: () => Record<string, { status: string; latencyMs?: number }>;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function healthRoutes(
  server: FastifyInstance,
  options: HealthRouteOptions,
): void {
  const { db, logger, isReady, getComponentStatus } = options;

  // GET /api/health/live — Liveness probe (200 after startup step 1)
  server.get('/api/health/live', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await reply.send({
      status: 'alive',
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/health/ready — Readiness probe (200 after step 6, 503 during startup)
  server.get('/api/health/ready', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isReady()) {
      await reply.status(503).send({
        status: 'starting',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    await reply.send({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/health — Full health check with component status (Section 12.3)
  server.get('/api/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
            components: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  latencyMs: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Check database connectivity
    let dbStatus: { status: string; latencyMs?: number } = { status: 'unknown' };
    try {
      const start = Date.now();
      await db.query('meridian', 'SELECT 1');
      dbStatus = { status: 'healthy', latencyMs: Date.now() - start };
    } catch (error) {
      logger.error('Database health check failed', {
        component: 'bridge',
        error: error instanceof Error ? error.message : String(error),
      });
      dbStatus = { status: 'unhealthy' };
    }

    const components: Record<string, { status: string; latencyMs?: number }> = {
      database: dbStatus,
      ...(getComponentStatus?.() ?? {}),
    };

    const overallStatus = Object.values(components).every(
      (c) => c.status === 'healthy',
    )
      ? 'healthy'
      : 'degraded';

    await reply.send({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components,
    });
  });
}
