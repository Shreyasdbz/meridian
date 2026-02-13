// @meridian/bridge — Configuration routes (Section 6.5)
// Get and update configuration (secrets redacted).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, Logger } from '@meridian/shared';
// Errors used for validation are handled by Fastify schema validation

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigRouteOptions {
  db: DatabaseClient;
  logger: Logger;
}

interface ConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Secret-redaction patterns
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /credential/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

function redactValue(key: string, value: string): string {
  return isSecretKey(key) ? '***REDACTED***' : value;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function configRoutes(
  server: FastifyInstance,
  options: ConfigRouteOptions,
): void {
  const { db, logger } = options;

  // GET /api/config — Get configuration (secrets redacted)
  server.get('/api/config', {
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
                  key: { type: 'string' },
                  value: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const rows = await db.query<ConfigRow>(
      'meridian',
      'SELECT key, value, updated_at FROM config ORDER BY key',
    );

    const items = rows.map((r) => ({
      key: r.key,
      value: redactValue(r.key, r.value),
      updatedAt: r.updated_at,
    }));

    await reply.send({ items });
  });

  // PUT /api/config — Update configuration
  server.put('/api/config', {
    schema: {
      body: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 200 },
          value: { type: 'string', maxLength: 10000 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as { key: string; value: string };
    const now = new Date().toISOString();

    // Upsert: INSERT OR REPLACE
    await db.run(
      'meridian',
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [body.key, body.value, now],
    );

    logger.info('Config updated', { key: body.key, component: 'bridge' });

    await reply.send({
      key: body.key,
      value: redactValue(body.key, body.value),
      updatedAt: now,
    });
  });
}
