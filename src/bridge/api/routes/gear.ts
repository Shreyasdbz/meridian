// @meridian/bridge — Gear routes (Section 5.6)
// List, install, uninstall, enable, and disable Gear plugins.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient, GearManifest, GearOrigin, Logger } from '@meridian/shared';
import { generateId, NotFoundError, ValidationError, ConflictError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GearRouteOptions {
  db: DatabaseClient;
  logger: Logger;
}

interface GearRow {
  id: string;
  name: string;
  version: string;
  manifest_json: string;
  origin: string;
  draft: number;
  installed_at: string;
  enabled: number;
  config_json: string | null;
  signature: string | null;
  checksum: string;
}

// ---------------------------------------------------------------------------
// Pagination defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(
    Math.max(1, Number(query['limit']) || DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Number(query['offset']) || 0);
  return { limit, offset };
}

function rowToGear(row: GearRow): {
  id: string;
  name: string;
  version: string;
  manifest: GearManifest;
  origin: GearOrigin;
  draft: boolean;
  installedAt: string;
  enabled: boolean;
  checksum: string;
} {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    manifest: JSON.parse(row.manifest_json) as GearManifest,
    origin: row.origin as GearOrigin,
    draft: row.draft === 1,
    installedAt: row.installed_at,
    enabled: row.enabled === 1,
    checksum: row.checksum,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function gearRoutes(
  server: FastifyInstance,
  options: GearRouteOptions,
): void {
  const { db, logger } = options;

  // GET /api/gear — List installed Gear
  server.get('/api/gear', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
          origin: { type: 'string', enum: ['builtin', 'user', 'journal'] },
          enabled: { type: 'boolean' },
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
    const originFilter = query['origin'] as string | undefined;
    const enabledFilter = query['enabled'] as boolean | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (originFilter) {
      conditions.push('origin = ?');
      params.push(originFilter);
    }
    if (enabledFilter !== undefined) {
      conditions.push('enabled = ?');
      params.push(enabledFilter ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRows = await db.query<{ count: number }>(
      'meridian',
      `SELECT COUNT(*) as count FROM gear ${where}`,
      params,
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await db.query<GearRow>(
      'meridian',
      `SELECT * FROM gear ${where}
       ORDER BY installed_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const items = rows.map(rowToGear);

    await reply.send({ items, total, hasMore: offset + limit < total });
  });

  // POST /api/gear/install — Install Gear (manifest review required)
  server.post('/api/gear/install', {
    schema: {
      body: {
        type: 'object',
        required: ['manifest'],
        properties: {
          manifest: {
            type: 'object',
            required: ['id', 'name', 'version', 'description', 'author', 'license', 'actions', 'permissions', 'origin', 'checksum'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              version: { type: 'string' },
              description: { type: 'string' },
              author: { type: 'string' },
              license: { type: 'string' },
              actions: { type: 'array' },
              permissions: { type: 'object' },
              origin: { type: 'string', enum: ['builtin', 'user', 'journal'] },
              checksum: { type: 'string' },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            version: { type: 'string' },
            installedAt: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as { manifest: GearManifest };
    const manifest = body.manifest;

    // Check for duplicate name+version
    const existing = await db.query<{ id: string }>(
      'meridian',
      'SELECT id FROM gear WHERE name = ? AND version = ?',
      [manifest.name, manifest.version],
    );

    if (existing.length > 0) {
      throw new ConflictError(
        `Gear '${manifest.name}' version '${manifest.version}' is already installed`,
      );
    }

    const id = manifest.id || generateId();
    const now = new Date().toISOString();

    await db.run(
      'meridian',
      `INSERT INTO gear (id, name, version, manifest_json, origin, draft, installed_at, enabled, config_json, signature, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        id,
        manifest.name,
        manifest.version,
        JSON.stringify(manifest),
        manifest.origin,
        manifest.draft ? 1 : 0,
        now,
        manifest.signature ?? null,
        manifest.checksum,
      ],
    );

    logger.info('Gear installed', {
      gearId: id,
      name: manifest.name,
      version: manifest.version,
      component: 'bridge',
    });

    await reply.status(201).send({
      id,
      name: manifest.name,
      version: manifest.version,
      installedAt: now,
      message: `Gear '${manifest.name}' installed successfully`,
    });
  });

  // DELETE /api/gear/:id — Uninstall Gear
  server.delete<{ Params: { id: string } }>('/api/gear/:id', {
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

    const rows = await db.query<GearRow>(
      'meridian',
      'SELECT * FROM gear WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Gear '${id}' not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const gear = rows[0]!;

    if (gear.origin === 'builtin') {
      throw new ValidationError('Cannot uninstall built-in Gear');
    }

    await db.run(
      'meridian',
      'DELETE FROM gear WHERE id = ?',
      [id],
    );

    logger.info('Gear uninstalled', { gearId: id, name: gear.name, component: 'bridge' });

    await reply.send({
      id,
      message: `Gear '${gear.name}' uninstalled`,
    });
  });

  // PUT /api/gear/:id/enable — Enable Gear
  server.put<{ Params: { id: string } }>('/api/gear/:id/enable', {
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
            enabled: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;

    const rows = await db.query<GearRow>(
      'meridian',
      'SELECT * FROM gear WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Gear '${id}' not found`);
    }

    await db.run(
      'meridian',
      'UPDATE gear SET enabled = 1 WHERE id = ?',
      [id],
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    logger.info('Gear enabled', { gearId: id, name: rows[0]!.name, component: 'bridge' });

    await reply.send({
      id,
      enabled: true,
      message: 'Gear enabled',
    });
  });

  // PUT /api/gear/:id/disable — Disable Gear
  server.put<{ Params: { id: string } }>('/api/gear/:id/disable', {
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
            enabled: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;

    const rows = await db.query<GearRow>(
      'meridian',
      'SELECT * FROM gear WHERE id = ?',
      [id],
    );

    if (rows.length === 0) {
      throw new NotFoundError(`Gear '${id}' not found`);
    }

    await db.run(
      'meridian',
      'UPDATE gear SET enabled = 0 WHERE id = ?',
      [id],
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    logger.info('Gear disabled', { gearId: id, name: rows[0]!.name, component: 'bridge' });

    await reply.send({
      id,
      enabled: false,
      message: 'Gear disabled',
    });
  });
}
