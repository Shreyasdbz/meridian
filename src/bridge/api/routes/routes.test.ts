/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { type AuditEntry, type BridgeConfig, DatabaseClient, type Logger, migrate, SecretsVault } from '@meridian/shared';

import { createServer } from '../server.js';

import type { AuditLogReader, QueryAuditOptions } from './audit.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Extract the cookie name=value from a Set-Cookie header string. */
function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : String(setCookieHeader);
  return raw.split(';')[0]!;
}

/** Setup auth and get auth headers for authenticated requests. */
async function setupAuth(
  server: FastifyInstance,
): Promise<{ cookie: string; csrfToken: string }> {
  await server.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'TestPassword123!' },
  });

  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'TestPassword123!' },
  });

  const cookie = extractCookie(loginRes.headers['set-cookie']);
  const body = JSON.parse(loginRes.body) as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

/** In-memory mock AuditLogReader for testing (avoids @meridian/axis dependency). */
class MockAuditLog implements AuditLogReader {
  private entries: AuditEntry[] = [];

  write(opts: { actor: string; action: string; riskLevel: string; jobId?: string }): Promise<void> {
    this.entries.push({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      actor: opts.actor as AuditEntry['actor'],
      action: opts.action,
      riskLevel: opts.riskLevel as AuditEntry['riskLevel'],
      jobId: opts.jobId,
    });
    return Promise.resolve();
  }

  query(options: QueryAuditOptions, _date?: Date): Promise<AuditEntry[]> {
    let filtered = [...this.entries];
    if (options.actor) filtered = filtered.filter((e) => e.actor === options.actor);
    if (options.action) filtered = filtered.filter((e) => e.action === options.action);
    if (options.riskLevel) filtered = filtered.filter((e) => e.riskLevel === options.riskLevel);
    if (options.jobId) filtered = filtered.filter((e) => e.jobId === options.jobId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return Promise.resolve(filtered.slice(offset, offset + limit));
  }

  count(options: Pick<QueryAuditOptions, 'actor' | 'action' | 'riskLevel' | 'jobId'>, _date?: Date): Promise<number> {
    let filtered = [...this.entries];
    if (options.actor) filtered = filtered.filter((e) => e.actor === options.actor);
    if (options.action) filtered = filtered.filter((e) => e.action === options.action);
    if (options.riskLevel) filtered = filtered.filter((e) => e.riskLevel === options.riskLevel);
    if (options.jobId) filtered = filtered.filter((e) => e.jobId === options.jobId);
    return Promise.resolve(filtered.length);
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-routes');
let dbPath: string;
let db: DatabaseClient;

const TEST_CONFIG: BridgeConfig = {
  bind: '127.0.0.1',
  port: 0,
  sessionDurationHours: 168,
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  close: vi.fn(),
};

beforeEach(async () => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  dbPath = join(TEST_DIR, `test-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
  await db.start();
  await db.open('meridian', dbPath);
  await migrate(db, 'meridian', process.cwd());
  vi.clearAllMocks();
});

afterEach(async () => {
  await db.close();
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal');
    if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm');
  } catch {
    // Ignore cleanup errors
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Health routes
// ---------------------------------------------------------------------------

describe('Health routes', () => {
  it('should return alive on GET /api/health/live', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('alive');
    expect(body.timestamp).toBeDefined();

    await server.close();
  });

  it('should return ready when isReady returns true on GET /api/health/ready', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      isReady: () => true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ready');

    await server.close();
  });

  it('should return 503 when isReady returns false on GET /api/health/ready', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      isReady: () => false,
    });

    const res = await server.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('starting');

    await server.close();
  });

  it('should return full health check on GET /api/health', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('healthy');
    expect(body.components.database.status).toBe('healthy');
    expect(typeof body.uptime).toBe('number');

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Conversation routes
// ---------------------------------------------------------------------------

describe('Conversation routes', () => {
  it('should require auth on GET /api/conversations', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/conversations' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });

  it('should create and list conversations', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Create a conversation
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Test Conversation' },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.title).toBe('Test Conversation');
    expect(created.status).toBe('active');
    expect(created.id).toBeDefined();

    // List conversations
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie },
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect(list.items[0].title).toBe('Test Conversation');

    await server.close();
  });

  it('should get a conversation by ID with messages', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Create a conversation
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'My Chat' },
    });
    const conv = JSON.parse(createRes.body);

    // Get by ID
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}`,
      headers: { cookie },
    });

    expect(getRes.statusCode).toBe(200);
    const detail = JSON.parse(getRes.body);
    expect(detail.id).toBe(conv.id);
    expect(detail.title).toBe('My Chat');
    expect(detail.messages).toEqual([]);
    expect(detail.totalMessages).toBe(0);

    await server.close();
  });

  it('should return 404 for non-existent conversation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'GET',
      url: '/api/conversations/nonexistent-id',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);

    await server.close();
  });

  it('should archive a conversation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Create
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Archive Me' },
    });
    const conv = JSON.parse(createRes.body);

    // Archive
    const archiveRes = await server.inject({
      method: 'PUT',
      url: `/api/conversations/${conv.id}/archive`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(archiveRes.statusCode).toBe(200);
    const archived = JSON.parse(archiveRes.body);
    expect(archived.status).toBe('archived');

    // Verify via list with filter
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/conversations?status=archived',
      headers: { cookie },
    });
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(1);

    await server.close();
  });

  it('should reject archiving an already archived conversation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Already Archived' },
    });
    const conv = JSON.parse(createRes.body);

    // Archive first time
    await server.inject({
      method: 'PUT',
      url: `/api/conversations/${conv.id}/archive`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // Archive second time
    const res = await server.inject({
      method: 'PUT',
      url: `/api/conversations/${conv.id}/archive`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(400);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Message routes
// ---------------------------------------------------------------------------

describe('Message routes', () => {
  it('should create a message and job', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Create conversation first
    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    // Send message
    const msgRes = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Hello Meridian!' },
    });

    expect(msgRes.statusCode).toBe(201);
    const msg = JSON.parse(msgRes.body);
    expect(msg.id).toBeDefined();
    expect(msg.jobId).toBeDefined();
    expect(msg.conversationId).toBe(conv.id);

    await server.close();
  });

  it('should reject message to non-existent conversation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: 'nonexistent', content: 'Hello' },
    });

    expect(res.statusCode).toBe(404);

    await server.close();
  });

  it('should reject message to archived conversation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Create and archive
    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);
    await server.inject({
      method: 'PUT',
      url: `/api/conversations/${conv.id}/archive`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // Try to send message
    const res = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Hello' },
    });

    expect(res.statusCode).toBe(400);

    await server.close();
  });

  it('should list messages with pagination', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    // Send 3 messages
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { conversationId: conv.id, content: `Message ${i}` },
      });
    }

    // List with limit
    const listRes = await server.inject({
      method: 'GET',
      url: `/api/messages?conversationId=${conv.id}&limit=2`,
      headers: { cookie },
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(2);
    expect(list.total).toBe(3);
    expect(list.hasMore).toBe(true);

    await server.close();
  });

  it('should reject messages without required fields', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Missing content
    const res = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: 'some-id' },
    });

    expect(res.statusCode).toBe(400);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Job routes
// ---------------------------------------------------------------------------

describe('Job routes', () => {
  it('should list jobs', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Create a conversation + message (which creates a job)
    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Do something' },
    });

    // List jobs
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { cookie },
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].status).toBe('pending');

    await server.close();
  });

  it('should get a job by ID', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    const msgRes = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Do something' },
    });
    const msg = JSON.parse(msgRes.body);

    // Get job by ID
    const jobRes = await server.inject({
      method: 'GET',
      url: `/api/jobs/${msg.jobId}`,
      headers: { cookie },
    });

    expect(jobRes.statusCode).toBe(200);
    const job = JSON.parse(jobRes.body);
    expect(job.id).toBe(msg.jobId);
    expect(job.status).toBe('pending');

    await server.close();
  });

  it('should return 404 for non-existent job', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'GET',
      url: '/api/jobs/nonexistent-id',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);

    await server.close();
  });

  it('should cancel a pending job', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    const msgRes = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Do something' },
    });
    const msg = JSON.parse(msgRes.body);

    // Cancel the job
    const cancelRes = await server.inject({
      method: 'POST',
      url: `/api/jobs/${msg.jobId}/cancel`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(cancelRes.statusCode).toBe(200);
    const cancelled = JSON.parse(cancelRes.body);
    expect(cancelled.status).toBe('cancelled');

    await server.close();
  });

  it('should reject cancelling a terminal job', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    const msgRes = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Do something' },
    });
    const msg = JSON.parse(msgRes.body);

    // Cancel once (should succeed)
    await server.inject({
      method: 'POST',
      url: `/api/jobs/${msg.jobId}/cancel`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // Cancel again (should fail — already terminal)
    const res = await server.inject({
      method: 'POST',
      url: `/api/jobs/${msg.jobId}/cancel`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(409);

    await server.close();
  });

  it('should filter jobs by status', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    // Create a job and cancel it
    const msgRes = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Task 1' },
    });
    const msg = JSON.parse(msgRes.body);
    await server.inject({
      method: 'POST',
      url: `/api/jobs/${msg.jobId}/cancel`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // Create another job (pending)
    await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Task 2' },
    });

    // Filter by pending
    const pendingRes = await server.inject({
      method: 'GET',
      url: '/api/jobs?status=pending',
      headers: { cookie },
    });
    const pending = JSON.parse(pendingRes.body);
    expect(pending.items).toHaveLength(1);

    // Filter by cancelled
    const cancelledRes = await server.inject({
      method: 'GET',
      url: '/api/jobs?status=cancelled',
      headers: { cookie },
    });
    const cancelled = JSON.parse(cancelledRes.body);
    expect(cancelled.items).toHaveLength(1);

    await server.close();
  });

  it('should reject approval with invalid nonce', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const convRes = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { title: 'Chat' },
    });
    const conv = JSON.parse(convRes.body);

    const msgRes = await server.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { conversationId: conv.id, content: 'Do something risky' },
    });
    const msg = JSON.parse(msgRes.body);

    // Try to approve with invalid nonce
    const res = await server.inject({
      method: 'POST',
      url: `/api/jobs/${msg.jobId}/approve`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { nonce: 'invalid-nonce' },
    });

    expect(res.statusCode).toBe(400);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Gear routes
// ---------------------------------------------------------------------------

describe('Gear routes', () => {
  const testManifest = {
    id: 'gear-test-001',
    name: 'test-gear',
    version: '1.0.0',
    description: 'Test gear',
    author: 'Test Author',
    license: 'MIT',
    actions: [
      {
        name: 'test-action',
        description: 'A test action',
        parameters: {},
        returns: {},
        riskLevel: 'low',
      },
    ],
    permissions: {},
    origin: 'user' as const,
    checksum: 'abc123',
  };

  it('should install and list Gear', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Install Gear
    const installRes = await server.inject({
      method: 'POST',
      url: '/api/gear/install',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { manifest: testManifest },
    });

    expect(installRes.statusCode).toBe(201);
    const installed = JSON.parse(installRes.body);
    expect(installed.name).toBe('test-gear');

    // List Gear
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/gear',
      headers: { cookie },
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].name).toBe('test-gear');
    expect(list.items[0].enabled).toBe(true);

    await server.close();
  });

  it('should reject duplicate Gear installation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    await server.inject({
      method: 'POST',
      url: '/api/gear/install',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { manifest: testManifest },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/gear/install',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { manifest: testManifest },
    });

    expect(res.statusCode).toBe(409);

    await server.close();
  });

  it('should uninstall user Gear', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Install
    const installRes = await server.inject({
      method: 'POST',
      url: '/api/gear/install',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { manifest: testManifest },
    });
    const installed = JSON.parse(installRes.body);

    // Uninstall
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/gear/${installed.id}`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(delRes.statusCode).toBe(200);

    // Verify gone
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/gear',
      headers: { cookie },
    });
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(0);

    await server.close();
  });

  it('should reject uninstalling built-in Gear', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const builtinManifest = { ...testManifest, id: 'builtin-gear', origin: 'builtin' as const };
    await server.inject({
      method: 'POST',
      url: '/api/gear/install',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { manifest: builtinManifest },
    });

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/gear/${builtinManifest.id}`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(400);

    await server.close();
  });

  it('should enable and disable Gear', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const installRes = await server.inject({
      method: 'POST',
      url: '/api/gear/install',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { manifest: testManifest },
    });
    const installed = JSON.parse(installRes.body);

    // Disable
    const disableRes = await server.inject({
      method: 'PUT',
      url: `/api/gear/${installed.id}/disable`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(JSON.parse(disableRes.body).enabled).toBe(false);

    // Enable
    const enableRes = await server.inject({
      method: 'PUT',
      url: `/api/gear/${installed.id}/enable`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(enableRes.statusCode).toBe(200);
    expect(JSON.parse(enableRes.body).enabled).toBe(true);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Config routes
// ---------------------------------------------------------------------------

describe('Config routes', () => {
  it('should get and update config', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Set a config value
    const putRes = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { key: 'theme', value: 'dark' },
    });

    expect(putRes.statusCode).toBe(200);
    const put = JSON.parse(putRes.body);
    expect(put.key).toBe('theme');
    expect(put.value).toBe('dark');

    // Get config
    const getRes = await server.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie },
    });

    expect(getRes.statusCode).toBe(200);
    const config = JSON.parse(getRes.body);
    expect(config.items).toHaveLength(1);
    expect(config.items[0].key).toBe('theme');

    await server.close();
  });

  it('should redact secret-like config keys', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { key: 'api_key', value: 'my-secret-value' },
    });

    const getRes = await server.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie },
    });

    const config = JSON.parse(getRes.body);
    const apiKeyItem = config.items.find((i: { key: string }) => i.key === 'api_key');
    expect(apiKeyItem.value).toBe('***REDACTED***');

    await server.close();
  });

  it('should upsert config values', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Set initial
    await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { key: 'theme', value: 'dark' },
    });

    // Update
    await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { key: 'theme', value: 'light' },
    });

    const getRes = await server.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie },
    });

    const config = JSON.parse(getRes.body);
    expect(config.items).toHaveLength(1);
    expect(config.items[0].value).toBe('light');

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Memory routes (v0.1 stub)
// ---------------------------------------------------------------------------

describe('Memory routes', () => {
  it('should list empty memories', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);

    await server.close();
  });

  it('should pause and resume memory recording', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Pause
    const pauseRes = await server.inject({
      method: 'PUT',
      url: '/api/memories/pause',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { paused: true },
    });

    expect(pauseRes.statusCode).toBe(200);
    expect(JSON.parse(pauseRes.body).paused).toBe(true);

    // Resume
    const resumeRes = await server.inject({
      method: 'PUT',
      url: '/api/memories/pause',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { paused: false },
    });

    expect(resumeRes.statusCode).toBe(200);
    expect(JSON.parse(resumeRes.body).paused).toBe(false);

    await server.close();
  });

  it('should export memories as JSON', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/memories/export',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { format: 'json' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.format).toBe('json');
    expect(body.count).toBe(0);

    await server.close();
  });

  it('should export memories as markdown', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/memories/export',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { format: 'markdown' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.format).toBe('markdown');

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// CSRF enforcement on all state-changing routes
// ---------------------------------------------------------------------------

describe('CSRF enforcement', () => {
  it('should require CSRF token on POST /api/conversations', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    // No CSRF token
    const res = await server.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { title: 'Test' },
    });

    expect(res.statusCode).toBe(403);

    await server.close();
  });

  it('should require CSRF token on PUT /api/config', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie },
      payload: { key: 'test', value: 'val' },
    });

    expect(res.statusCode).toBe(403);

    await server.close();
  });

  it('should require CSRF token on DELETE /api/gear/:id', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'DELETE',
      url: '/api/gear/some-id',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Authentication enforcement
// ---------------------------------------------------------------------------

describe('Authentication enforcement', () => {
  it('should require auth on GET /api/jobs', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/jobs' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });

  it('should require auth on GET /api/gear', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/gear' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });

  it('should require auth on GET /api/config', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });

  it('should require auth on GET /api/memories', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const res = await server.inject({ method: 'GET', url: '/api/memories' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });

  it('should NOT require auth on health endpoints', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const liveRes = await server.inject({ method: 'GET', url: '/api/health/live' });
    expect(liveRes.statusCode).toBe(200);

    const readyRes = await server.inject({ method: 'GET', url: '/api/health/ready' });
    expect(readyRes.statusCode).toBe(200);

    const healthRes = await server.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Audit routes
// ---------------------------------------------------------------------------

describe('Audit routes', () => {
  it('should query audit log entries', async () => {
    const auditLog = new MockAuditLog();

    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      auditLog,
    });

    const { cookie } = await setupAuth(server);

    // Write some audit entries
    await auditLog.write({
      actor: 'user',
      action: 'login',
      riskLevel: 'low',
    });
    await auditLog.write({
      actor: 'axis',
      action: 'job.created',
      riskLevel: 'low',
      jobId: 'test-job-1',
    });

    // Query all
    const res = await server.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(2);

    await server.close();
  });

  it('should filter audit entries by actor', async () => {
    const auditLog = new MockAuditLog();

    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      auditLog,
    });

    const { cookie } = await setupAuth(server);

    await auditLog.write({ actor: 'user', action: 'login', riskLevel: 'low' });
    await auditLog.write({ actor: 'axis', action: 'job.created', riskLevel: 'low' });

    // Filter by actor=user
    const res = await server.inject({
      method: 'GET',
      url: '/api/audit?actor=user',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.every((e: { actor: string }) => e.actor === 'user')).toBe(true);

    await server.close();
  });

  it('should filter audit entries by risk level', async () => {
    const auditLog = new MockAuditLog();

    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      auditLog,
    });

    const { cookie } = await setupAuth(server);

    await auditLog.write({ actor: 'user', action: 'config.change', riskLevel: 'medium' });
    await auditLog.write({ actor: 'gear', action: 'file.write', riskLevel: 'high' });

    const res = await server.inject({
      method: 'GET',
      url: '/api/audit?riskLevel=high',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.every((e: { riskLevel: string }) => e.riskLevel === 'high')).toBe(true);

    await server.close();
  });

  it('should require auth on GET /api/audit', async () => {
    const auditLog = new MockAuditLog();

    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      auditLog,
    });

    const res = await server.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Secrets routes
// ---------------------------------------------------------------------------

describe('Secrets routes', () => {
  let vaultPath: string;
  let vault: SecretsVault;

  beforeEach(async () => {
    vaultPath = join(TEST_DIR, `test-vault-${Date.now()}-${Math.random().toString(36).slice(2)}.vault`);
    vault = new SecretsVault(vaultPath);
    await vault.initialize('test-vault-password', 'low-power');
  });

  afterEach(() => {
    vault.lock();
    try {
      if (existsSync(vaultPath)) unlinkSync(vaultPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should list secrets metadata without values', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const { cookie } = await setupAuth(server);

    // Store a secret directly
    await vault.store('API_KEY', Buffer.from('super-secret'), ['test-gear']);

    const res = await server.inject({
      method: 'GET',
      url: '/api/secrets',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('API_KEY');
    expect(body.items[0].allowedGear).toEqual(['test-gear']);
    // SECURITY: value must never be in the response
    expect(body.items[0].value).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('super-secret');

    await server.close();
  });

  it('should store a new secret', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/secrets',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        name: 'DB_PASSWORD',
        value: 'my-database-password',
        allowedGear: ['db-gear', 'backup-gear'],
        rotateAfterDays: 90,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('DB_PASSWORD');
    expect(body.allowedGear).toEqual(['db-gear', 'backup-gear']);
    // SECURITY: value must never be in the response
    expect(body.value).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('my-database-password');

    // Verify secret was actually stored
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/secrets',
      headers: { cookie },
    });
    const list = JSON.parse(listRes.body);
    expect(list.items).toHaveLength(1);

    await server.close();
  });

  it('should delete a secret', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Store first
    await vault.store('TEMP_SECRET', Buffer.from('temp-value'), ['gear-1']);

    // Delete
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/secrets/TEMP_SECRET',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('TEMP_SECRET');

    // Verify deleted
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/secrets',
      headers: { cookie },
    });
    expect(JSON.parse(listRes.body).items).toHaveLength(0);

    await server.close();
  });

  it('should return 404 for deleting non-existent secret', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'DELETE',
      url: '/api/secrets/NONEXISTENT',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(404);

    await server.close();
  });

  it('should update secret ACL', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Store with initial ACL (include __system__ for re-retrieval in ACL update)
    await vault.store('ACL_TEST', Buffer.from('test-value'), ['gear-a', '__system__']);

    // Update ACL
    const res = await server.inject({
      method: 'PUT',
      url: '/api/secrets/ACL_TEST/acl',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { allowedGear: ['gear-b', 'gear-c', '__system__'] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.allowedGear).toEqual(['gear-b', 'gear-c', '__system__']);

    await server.close();
  });

  it('should require auth on GET /api/secrets', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const res = await server.inject({ method: 'GET', url: '/api/secrets' });
    expect(res.statusCode).toBe(401);

    await server.close();
  });

  it('should require CSRF on POST /api/secrets', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      vault,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/secrets',
      headers: { cookie },
      payload: {
        name: 'NO_CSRF',
        value: 'test',
        allowedGear: [],
      },
    });

    expect(res.statusCode).toBe(403);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Memory routes — update and delete
// ---------------------------------------------------------------------------

describe('Memory routes — update and delete', () => {
  it('should create, update, and retrieve a memory entry', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // First, manually insert a memory via the stub table
    await db.exec('meridian', `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'episodic',
        content TEXT NOT NULL,
        source TEXT,
        linked_gear_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
      )
    `);
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO memories (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['mem-1', 'episodic', 'Original content', now, now],
    );

    // Update the memory
    const updateRes = await server.inject({
      method: 'PUT',
      url: '/api/memories/mem-1',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { content: 'Updated content', type: 'semantic' },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(updated.content).toBe('Updated content');
    expect(updated.type).toBe('semantic');

    await server.close();
  });

  it('should delete a memory entry', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Insert a memory
    await db.exec('meridian', `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'episodic',
        content TEXT NOT NULL,
        source TEXT,
        linked_gear_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT CHECK (json_valid(metadata_json) OR metadata_json IS NULL)
      )
    `);
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO memories (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['mem-del-1', 'procedural', 'Delete me', now, now],
    );

    // Delete
    const delRes = await server.inject({
      method: 'DELETE',
      url: '/api/memories/mem-del-1',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).id).toBe('mem-del-1');

    // Verify gone
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/memories',
      headers: { cookie },
    });
    const list = JSON.parse(listRes.body);
    expect(list.items.find((m: { id: string }) => m.id === 'mem-del-1')).toBeUndefined();

    await server.close();
  });

  it('should return 404 for updating non-existent memory', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'PUT',
      url: '/api/memories/nonexistent',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { content: 'Updated' },
    });

    expect(res.statusCode).toBe(404);

    await server.close();
  });

  it('should return 404 for deleting non-existent memory', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'DELETE',
      url: '/api/memories/nonexistent',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(404);

    await server.close();
  });
});
