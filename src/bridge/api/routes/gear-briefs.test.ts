// @meridian/bridge — Gear brief route tests (Phase 11.1)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@meridian/shared';

import { gearBriefRoutes } from './gear-briefs.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let server: FastifyInstance;
let workspacePath: string;
let briefDir: string;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  level: 'info',
  context: {},
  outputs: [],
  child: vi.fn().mockReturnThis(),
  isEnabled: vi.fn().mockReturnValue(true),
  close: vi.fn(),
} as unknown as Logger;

function createBriefFile(
  name: string,
  options?: { status?: string; problem?: string; proposedSolution?: string },
): void {
  const doc = {
    origin: 'journal',
    createdAt: new Date().toISOString(),
    status: options?.status ?? 'proposed',
    brief: {
      problem: options?.problem ?? 'Test problem',
      proposedSolution: options?.proposedSolution ?? 'Test solution',
      exampleInput: 'test input',
      exampleOutput: 'test output',
    },
  };

  writeFileSync(join(briefDir, name), JSON.stringify(doc, null, 2), 'utf-8');
}

beforeEach(async () => {
  workspacePath = join(
    tmpdir(),
    `meridian-test-briefs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  briefDir = join(workspacePath, 'gear');
  mkdirSync(briefDir, { recursive: true });

  server = Fastify({ logger: false });
  gearBriefRoutes(server, { workspacePath, logger: mockLogger });

  // Register error handler matching server.ts behavior
  server.setErrorHandler(async (error: Error, _request, reply) => {
    if ('code' in error) {
      const meridianError = error as Error & { code: string };
      const statusMap: Record<string, number> = {
        ERR_NOT_FOUND: 404,
        ERR_VALIDATION: 400,
        ERR_CONFLICT: 409,
      };
      const status = statusMap[meridianError.code] ?? 500;
      await reply.status(status).send({
        error: meridianError.message,
        code: meridianError.code,
      });
      return;
    }
    await reply.status(500).send({ error: error.message });
  });

  await server.ready();
});

afterEach(async () => {
  await server.close();
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/gear/briefs
// ---------------------------------------------------------------------------

describe('GET /api/gear/briefs', () => {
  it('should return empty list when no briefs exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/gear/briefs',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('should list existing brief files', async () => {
    createBriefFile('brief-2026-01-01T00-00-00-000Z-abc123-test-problem.json');
    createBriefFile('brief-2026-01-02T00-00-00-000Z-def456-another-problem.json');

    const response = await server.inject({
      method: 'GET',
      url: '/api/gear/briefs',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.items[0].brief.problem).toBe('Test problem');
  });

  it('should filter by status', async () => {
    createBriefFile('brief-2026-01-01T00-00-00-000Z-abc-proposed.json', { status: 'proposed' });
    createBriefFile('brief-2026-01-02T00-00-00-000Z-def-dismissed.json', { status: 'dismissed' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/gear/briefs?status=proposed',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].status).toBe('proposed');
  });

  it('should ignore non-brief files', async () => {
    createBriefFile('brief-2026-01-01T00-00-00-000Z-abc-test.json');
    writeFileSync(join(briefDir, 'not-a-brief.json'), '{}', 'utf-8');

    const response = await server.inject({
      method: 'GET',
      url: '/api/gear/briefs',
    });

    const body = response.json();
    expect(body.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/gear/briefs/:id
// ---------------------------------------------------------------------------

describe('GET /api/gear/briefs/:id', () => {
  it('should return a specific brief', async () => {
    const fileName = 'brief-2026-01-01T00-00-00-000Z-abc-test.json';
    createBriefFile(fileName);

    const id = fileName.replace('.json', '');
    const response = await server.inject({
      method: 'GET',
      url: `/api/gear/briefs/${id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(id);
    expect(body.brief.problem).toBe('Test problem');
  });

  it('should return 404 for non-existent brief', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/gear/briefs/brief-nonexistent',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should reject path traversal in ID', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/gear/briefs/${encodeURIComponent('brief-../../etc/passwd')}`,
    });

    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/gear/briefs/:id/dismiss
// ---------------------------------------------------------------------------

describe('POST /api/gear/briefs/:id/dismiss', () => {
  it('should dismiss an existing brief', async () => {
    const fileName = 'brief-2026-01-01T00-00-00-000Z-abc-test.json';
    createBriefFile(fileName);

    const id = fileName.replace('.json', '');
    const response = await server.inject({
      method: 'POST',
      url: `/api/gear/briefs/${id}/dismiss`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('dismissed');
    expect(body.message).toBe('Brief dismissed');

    // Verify file was updated
    const updated = JSON.parse(readFileSync(join(briefDir, fileName), 'utf-8'));
    expect(updated.status).toBe('dismissed');
  });

  it('should return 404 for non-existent brief', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/gear/briefs/brief-nonexistent/dismiss',
    });

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/gear/briefs/:id/refine
// ---------------------------------------------------------------------------

describe('POST /api/gear/briefs/:id/refine', () => {
  it('should refine brief content', async () => {
    const fileName = 'brief-2026-01-01T00-00-00-000Z-abc-test.json';
    createBriefFile(fileName);

    const id = fileName.replace('.json', '');
    const response = await server.inject({
      method: 'POST',
      url: `/api/gear/briefs/${id}/refine`,
      payload: {
        problem: 'Updated problem description',
        proposedSolution: 'Updated solution',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('refined');
    expect(body.brief.problem).toBe('Updated problem description');
    expect(body.brief.proposedSolution).toBe('Updated solution');
    // Unchanged fields should be preserved
    expect(body.brief.exampleInput).toBe('test input');
  });

  it('should update individual fields without overwriting others', async () => {
    const fileName = 'brief-2026-01-01T00-00-00-000Z-abc-test.json';
    createBriefFile(fileName, { problem: 'Original problem' });

    const id = fileName.replace('.json', '');
    const response = await server.inject({
      method: 'POST',
      url: `/api/gear/briefs/${id}/refine`,
      payload: {
        proposedSolution: 'New solution only',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.brief.problem).toBe('Original problem');
    expect(body.brief.proposedSolution).toBe('New solution only');
  });

  it('should return 404 for non-existent brief', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/gear/briefs/brief-nonexistent/refine',
      payload: { problem: 'test' },
    });

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/gear/briefs/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/gear/briefs/:id', () => {
  it('should delete a brief file', async () => {
    const fileName = 'brief-2026-01-01T00-00-00-000Z-abc-test.json';
    createBriefFile(fileName);

    const id = fileName.replace('.json', '');
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/gear/briefs/${id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message).toBe('Brief deleted');

    // Verify file was removed
    expect(existsSync(join(briefDir, fileName))).toBe(false);
  });

  it('should return 404 for non-existent brief', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/gear/briefs/brief-nonexistent',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should reject path traversal attempts', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/gear/briefs/${encodeURIComponent('brief-../../important-file')}`,
    });

    expect(response.statusCode).toBe(400);
  });
});
