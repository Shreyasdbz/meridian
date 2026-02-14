// @meridian/bridge — Update check routes (Phase 9.8)
// Provides an endpoint for checking whether security patches or new versions
// are available. In v0.1 this returns current version info only; future
// versions will query a release endpoint for update notifications.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateRouteOptions {
  logger: Logger;
  currentVersion: string;
}

interface UpdateCheckResponse {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function updateRoutes(
  server: FastifyInstance,
  options: UpdateRouteOptions,
): void {
  const { logger, currentVersion } = options;

  // GET /api/updates/check — Check for available updates
  server.get('/api/updates/check', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            currentVersion: { type: 'string' },
            updateAvailable: { type: 'boolean' },
            latestVersion: { type: 'string' },
            checkedAt: { type: 'string' },
          },
          required: ['currentVersion', 'updateAvailable', 'latestVersion', 'checkedAt'],
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // In production, this would check a release endpoint (e.g., GitHub Releases API).
    // For now, return current version info indicating no update is available.
    logger.info('Update check requested', { component: 'bridge' });

    const response: UpdateCheckResponse = {
      currentVersion,
      updateAvailable: false,
      latestVersion: currentVersion,
      checkedAt: new Date().toISOString(),
    };

    await reply.send(response);
  });
}
