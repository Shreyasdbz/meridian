// @meridian/bridge — Secrets routes (Section 6.4)
// List secret metadata, store, delete, and update ACLs.
// Values are NEVER exposed through the API.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { type Logger, NotFoundError, type SecretsVault } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretRouteOptions {
  vault: SecretsVault;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function secretRoutes(
  server: FastifyInstance,
  options: SecretRouteOptions,
): void {
  const { vault, logger } = options;

  // GET /api/secrets — List secret metadata (names and ACLs, never values)
  server.get('/api/secrets', {
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
                  name: { type: 'string' },
                  allowedGear: { type: 'array', items: { type: 'string' } },
                  createdAt: { type: 'string' },
                  lastUsedAt: { type: 'string' },
                  rotateAfterDays: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const items = await vault.list();
    await reply.send({ items });
  });

  // POST /api/secrets — Store a new secret
  server.post('/api/secrets', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'value', 'allowedGear'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          value: { type: 'string', minLength: 1 },
          allowedGear: { type: 'array', items: { type: 'string' }, minItems: 0 },
          rotateAfterDays: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            allowedGear: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as {
      name: string;
      value: string;
      allowedGear: string[];
      rotateAfterDays?: number;
    };

    // Convert value to Buffer (secrets are never stored as strings)
    const valueBuffer = Buffer.from(body.value, 'utf-8');

    try {
      await vault.store(body.name, valueBuffer, body.allowedGear, {
        rotateAfterDays: body.rotateAfterDays,
      });
    } finally {
      // Zero the buffer after use (security requirement)
      valueBuffer.fill(0);
    }

    logger.info('Secret stored', { name: body.name, component: 'bridge' });

    await reply.status(201).send({
      name: body.name,
      allowedGear: body.allowedGear,
      message: `Secret '${body.name}' stored`,
    });
  });

  // DELETE /api/secrets/:name — Delete a secret
  server.delete<{ Params: { name: string } }>('/api/secrets/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply): Promise<void> => {
    const { name } = request.params;

    await vault.delete(name);

    logger.info('Secret deleted', { name, component: 'bridge' });

    await reply.send({
      name,
      message: `Secret '${name}' deleted`,
    });
  });

  // PUT /api/secrets/:name/acl — Update secret ACL
  server.put<{ Params: { name: string } }>('/api/secrets/:name/acl', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['allowedGear'],
        properties: {
          allowedGear: { type: 'array', items: { type: 'string' }, minItems: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            allowedGear: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply): Promise<void> => {
    const { name } = request.params;
    const body = request.body as { allowedGear: string[] };

    // To update ACL, we need to re-store with the same value.
    // Use a special system gear ID to bypass ACL check for re-reading.
    // NOTE: In v0.1 this is a simplified approach. A dedicated updateAcl()
    // method should be added to SecretsVault in a future version.
    // For now, we validate the secret exists via list().
    const secrets = await vault.list();
    const existing = secrets.find((s) => s.name === name);

    if (!existing) {
      throw new NotFoundError(`Secret '${name}' not found`);
    }

    // Retrieve with a system-level gear identifier, re-store with new ACL
    const value = await vault.retrieve(name, '__system__');
    if (!value) {
      throw new NotFoundError(`Secret '${name}' not found`);
    }

    try {
      await vault.store(name, value, body.allowedGear, {
        rotateAfterDays: existing.rotateAfterDays,
      });
    } finally {
      value.fill(0);
    }

    logger.info('Secret ACL updated', {
      name,
      allowedGear: body.allowedGear,
      component: 'bridge',
    });

    await reply.send({
      name,
      allowedGear: body.allowedGear,
      message: `ACL for secret '${name}' updated`,
    });
  });
}
