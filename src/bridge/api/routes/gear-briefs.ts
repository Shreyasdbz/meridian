// @meridian/bridge — Gear Brief routes (Phase 11.1)
// List, view, dismiss, refine, and delete Gear briefs from workspace/gear/.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@meridian/shared';
import { NotFoundError, ValidationError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GearBriefRouteOptions {
  workspacePath: string;
  logger: Logger;
}

interface GearBriefContent {
  problem: string;
  proposedSolution: string;
  exampleInput: string;
  exampleOutput: string;
  manifestSkeleton?: string;
  pseudocode?: string;
}

interface GearBriefDocument {
  origin: string;
  createdAt: string;
  status: string;
  brief: GearBriefContent;
}

interface GearBriefListItem {
  id: string;
  fileName: string;
  origin: string;
  createdAt: string;
  status: string;
  brief: GearBriefContent;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEAR_BRIEF_DIR = 'gear';
const BRIEF_FILE_PREFIX = 'brief-';
const BRIEF_FILE_EXTENSION = '.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBriefDir(workspacePath: string): string {
  return join(workspacePath, GEAR_BRIEF_DIR);
}

function ensureBriefDir(workspacePath: string): string {
  const dir = getBriefDir(workspacePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Derive a stable ID from a brief filename by stripping the prefix and extension.
 */
function fileNameToId(fileName: string): string {
  return fileName.replace(BRIEF_FILE_EXTENSION, '');
}

/**
 * Reconstruct the filename from an ID.
 */
function idToFileName(id: string): string {
  if (id.endsWith(BRIEF_FILE_EXTENSION)) {
    return id;
  }
  return `${id}${BRIEF_FILE_EXTENSION}`;
}

/**
 * Read and parse a brief file. Returns null if file does not exist or is invalid.
 */
function readBriefFile(briefDir: string, fileName: string): GearBriefDocument | null {
  const filePath = join(briefDir, fileName);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as GearBriefDocument;
  } catch {
    return null;
  }
}

/**
 * List all brief files in the brief directory.
 */
function listBriefFiles(briefDir: string): string[] {
  if (!existsSync(briefDir)) {
    return [];
  }

  return readdirSync(briefDir)
    .filter((f) => f.startsWith(BRIEF_FILE_PREFIX) && f.endsWith(BRIEF_FILE_EXTENSION))
    .sort()
    .reverse(); // Most recent first (timestamp in name)
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Validate that an ID does not contain path traversal.
 */
function validateBriefId(id: string): void {
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new ValidationError('Invalid brief ID: path traversal detected');
  }
  if (!id.startsWith(BRIEF_FILE_PREFIX)) {
    throw new ValidationError(`Invalid brief ID: must start with '${BRIEF_FILE_PREFIX}'`);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function gearBriefRoutes(
  server: FastifyInstance,
  options: GearBriefRouteOptions,
): void {
  const { workspacePath, logger } = options;

  // GET /api/gear/briefs — List all proposed briefs
  server.get('/api/gear/briefs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['proposed', 'dismissed', 'refined'] },
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
    const statusFilter = query['status'] as string | undefined;

    const briefDir = getBriefDir(workspacePath);
    const files = listBriefFiles(briefDir);

    const items: GearBriefListItem[] = [];

    for (const fileName of files) {
      const doc = readBriefFile(briefDir, fileName);
      if (!doc) continue;

      // Apply status filter
      if (statusFilter && doc.status !== statusFilter) continue;

      items.push({
        id: fileNameToId(fileName),
        fileName,
        origin: doc.origin,
        createdAt: doc.createdAt,
        status: doc.status,
        brief: doc.brief,
      });
    }

    await reply.send({ items, total: items.length });
  });

  // GET /api/gear/briefs/:id — Get a specific brief
  server.get<{ Params: { id: string } }>('/api/gear/briefs/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;
    validateBriefId(id);

    const briefDir = getBriefDir(workspacePath);
    const fileName = idToFileName(id);
    const doc = readBriefFile(briefDir, fileName);

    if (!doc) {
      throw new NotFoundError(`Gear brief '${id}' not found`);
    }

    await reply.send({
      id: fileNameToId(fileName),
      fileName,
      origin: doc.origin,
      createdAt: doc.createdAt,
      status: doc.status,
      brief: doc.brief,
    });
  });

  // POST /api/gear/briefs/:id/dismiss — Dismiss a brief
  server.post<{ Params: { id: string } }>('/api/gear/briefs/:id/dismiss', {
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
            status: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;
    validateBriefId(id);

    const briefDir = ensureBriefDir(workspacePath);
    const fileName = idToFileName(id);
    const filePath = join(briefDir, fileName);

    const doc = readBriefFile(briefDir, fileName);
    if (!doc) {
      throw new NotFoundError(`Gear brief '${id}' not found`);
    }

    // Update status to dismissed
    doc.status = 'dismissed';
    writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8');

    logger.info('Gear brief dismissed', { briefId: id, component: 'bridge' });

    await reply.send({
      id,
      status: 'dismissed',
      message: 'Brief dismissed',
    });
  });

  // POST /api/gear/briefs/:id/refine — Update brief content
  server.post<{ Params: { id: string } }>('/api/gear/briefs/:id/refine', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          problem: { type: 'string' },
          proposedSolution: { type: 'string' },
          exampleInput: { type: 'string' },
          exampleOutput: { type: 'string' },
          manifestSkeleton: { type: 'string' },
          pseudocode: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            brief: {
              type: 'object',
              additionalProperties: true,
            },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const { id } = request.params;
    validateBriefId(id);

    const body = (request.body ?? {}) as Partial<GearBriefContent>;

    const briefDir = ensureBriefDir(workspacePath);
    const fileName = idToFileName(id);
    const filePath = join(briefDir, fileName);

    const doc = readBriefFile(briefDir, fileName);
    if (!doc) {
      throw new NotFoundError(`Gear brief '${id}' not found`);
    }

    // Merge updates into existing brief
    if (body.problem !== undefined) {
      doc.brief.problem = body.problem;
    }
    if (body.proposedSolution !== undefined) {
      doc.brief.proposedSolution = body.proposedSolution;
    }
    if (body.exampleInput !== undefined) {
      doc.brief.exampleInput = body.exampleInput;
    }
    if (body.exampleOutput !== undefined) {
      doc.brief.exampleOutput = body.exampleOutput;
    }
    if (body.manifestSkeleton !== undefined) {
      doc.brief.manifestSkeleton = body.manifestSkeleton;
    }
    if (body.pseudocode !== undefined) {
      doc.brief.pseudocode = body.pseudocode;
    }

    doc.status = 'refined';

    writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8');

    logger.info('Gear brief refined', { briefId: id, component: 'bridge' });

    await reply.send({
      id,
      status: 'refined',
      brief: doc.brief,
      message: 'Brief updated',
    });
  });

  // DELETE /api/gear/briefs/:id — Remove brief file
  server.delete<{ Params: { id: string } }>('/api/gear/briefs/:id', {
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
    validateBriefId(id);

    const briefDir = getBriefDir(workspacePath);
    const fileName = idToFileName(id);
    const filePath = join(briefDir, fileName);

    if (!existsSync(filePath)) {
      throw new NotFoundError(`Gear brief '${id}' not found`);
    }

    unlinkSync(filePath);

    logger.info('Gear brief deleted', { briefId: id, component: 'bridge' });

    await reply.send({
      id,
      message: 'Brief deleted',
    });
  });
}
