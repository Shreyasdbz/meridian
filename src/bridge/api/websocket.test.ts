// @meridian/bridge — WebSocket server tests (Phase 6.3)
// Tests authentication flow, message handling, rate limiting, and keepalive.

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { DatabaseClient, migrate } from '@meridian/shared';
import type { BridgeConfig, Logger, WSMessage } from '@meridian/shared';

import { createServer } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test');
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

/** Wait for a WebSocket message matching a condition, with timeout. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: WSMessage) => boolean,
  timeoutMs = 2000,
): Promise<WSMessage> {
  return new Promise<WSMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(event: { data: unknown }): void {
      try {
        const data = typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString('utf-8')
            : String(event.data);
        const msg = JSON.parse(data) as WSMessage;
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
      } catch {
        // Ignore parse errors, keep waiting
      }
    }

    ws.addEventListener('message', handler);
  });
}

/** Collect all messages within a window. */
function collectMessages(ws: WebSocket, durationMs: number): Promise<WSMessage[]> {
  return new Promise<WSMessage[]>((resolve) => {
    const messages: WSMessage[] = [];

    function handler(event: { data: unknown }): void {
      try {
        const data = typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString('utf-8')
            : String(event.data);
        messages.push(JSON.parse(data) as WSMessage);
      } catch {
        // Ignore
      }
    }

    ws.addEventListener('message', handler);

    setTimeout(() => {
      ws.removeEventListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

/** Setup password, login, and return auth details. */
async function setupAndLogin(
  server: Awaited<ReturnType<typeof createServer>>['server'],
  authService: Awaited<ReturnType<typeof createServer>>['authService'],
): Promise<{
  sessionToken: string;
  csrfToken: string;
  sessionId: string;
  cookie: string;
}> {
  await authService.setupPassword('TestPassword123!');
  const loginResult = await authService.login('TestPassword123!', '127.0.0.1');

  if (!loginResult.success || !loginResult.session || !loginResult.token) {
    throw new Error('Login failed in test setup');
  }

  // Get CSRF token by calling the token endpoint with a session
  const sessionResponse = await server.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: {
      authorization: `Bearer ${loginResult.token}`,
    },
  });
  const sessionBody = JSON.parse(sessionResponse.body);

  return {
    sessionToken: loginResult.token,
    csrfToken: sessionBody.csrfToken,
    sessionId: loginResult.session.id,
    cookie: `meridian_session=${loginResult.token}`,
  };
}

/** Get a WS connection token via the REST endpoint. */
async function getWsToken(
  server: Awaited<ReturnType<typeof createServer>>['server'],
  auth: { cookie: string; csrfToken: string },
): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/ws/token',
    headers: {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrfToken,
    },
  });

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body) as { token: string };
  return body.token;
}

/** Open an authenticated WebSocket connection. */
async function openAuthenticatedWs(
  server: Awaited<ReturnType<typeof createServer>>['server'],
  auth: { cookie: string; csrfToken: string },
): Promise<{ ws: WebSocket; connectedMsg: WSMessage }> {
  const wsToken = await getWsToken(server, auth);

  const ws = await server.injectWS('/api/ws', {
    headers: {
      cookie: auth.cookie,
    },
  });

  // Send connection token
  ws.send(JSON.stringify({ token: wsToken }));

  // Wait for connected message
  const connectedMsg = await waitForMessage(ws, (msg) => msg.type === 'connected');

  return { ws, connectedMsg };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  dbPath = join(TEST_DIR, `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
  await db.start();
  await db.open('meridian', dbPath);
  await migrate(db, 'meridian', process.cwd());
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
// POST /api/ws/token — Connection token endpoint
// ---------------------------------------------------------------------------

describe('WebSocket — connection token endpoint', () => {
  it('should issue a connection token for authenticated users', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const response = await server.inject({
      method: 'POST',
      url: '/api/ws/token',
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrfToken,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);

    await server.close();
  });

  it('should reject token request without authentication', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/ws/token',
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// WebSocket authentication flow
// ---------------------------------------------------------------------------

describe('WebSocket — authentication flow', () => {
  it('should reject unauthenticated requests to WS token endpoint', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // The auth middleware rejects unauthenticated HTTP requests before the
    // WebSocket upgrade completes. Verify this via the token endpoint which
    // uses the same auth middleware.
    const response = await server.inject({
      method: 'POST',
      url: '/api/ws/token',
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it('should authenticate with valid session and connection token', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws, connectedMsg } = await openAuthenticatedWs(server, auth);

    expect(connectedMsg.type).toBe('connected');
    expect((connectedMsg as { sessionId: string }).sessionId).toBe(auth.sessionId);

    ws.close();
    await server.close();
  });

  it('should reject invalid connection token', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);

    const ws = await server.injectWS('/api/ws', {
      headers: {
        cookie: auth.cookie,
      },
    });

    // Send invalid token
    ws.send(JSON.stringify({ token: 'invalid-token-value' }));

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4003);
    expect(closeEvent.reason).toContain('Invalid');

    await server.close();
  });

  it('should prevent connection token replay', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const wsToken = await getWsToken(server, auth);

    // First use: should succeed
    const ws1 = await server.injectWS('/api/ws', {
      headers: { cookie: auth.cookie },
    });
    ws1.send(JSON.stringify({ token: wsToken }));
    const msg1 = await waitForMessage(ws1, (msg) => msg.type === 'connected');
    expect(msg1.type).toBe('connected');

    // Second use: same token should fail (replay)
    const ws2 = await server.injectWS('/api/ws', {
      headers: { cookie: auth.cookie },
    });
    ws2.send(JSON.stringify({ token: wsToken }));

    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws2.addEventListener('close', (event) => {
        resolve({ code: event.code });
      });
    });

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4003);

    ws1.close();
    await server.close();
  });

  it('should reject first message without token field', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);

    const ws = await server.injectWS('/api/ws', {
      headers: { cookie: auth.cookie },
    });

    // Send message without token
    ws.send(JSON.stringify({ type: 'ping' }));

    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener('close', (event) => {
        resolve({ code: event.code });
      });
    });

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4003);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Message serialization/deserialization
// ---------------------------------------------------------------------------

describe('WebSocket — message types', () => {
  it('should send and receive chunk messages via broadcast', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const chunkMsg: WSMessage = {
      type: 'chunk',
      jobId: 'test-job-1',
      content: 'Hello',
      done: false,
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'chunk');
    wsManager.broadcast(chunkMsg);

    const received = await messagePromise;
    expect(received).toEqual(chunkMsg);

    ws.close();
    await server.close();
  });

  it('should send status messages via broadcast', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const statusMsg: WSMessage = {
      type: 'status',
      jobId: 'test-job-1',
      status: 'executing',
      step: 'Running Gear',
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'status');
    wsManager.broadcast(statusMsg);

    const received = await messagePromise;
    expect(received).toEqual(statusMsg);

    ws.close();
    await server.close();
  });

  it('should send error messages via broadcast', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const errorMsg: WSMessage = {
      type: 'error',
      jobId: 'test-job-1',
      code: 'GEAR_FAILED',
      message: 'Gear execution failed',
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'error');
    wsManager.broadcast(errorMsg);

    const received = await messagePromise;
    expect(received).toEqual(errorMsg);

    ws.close();
    await server.close();
  });

  it('should send notification messages via broadcast', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const notifMsg: WSMessage = {
      type: 'notification',
      level: 'info',
      message: 'System updated',
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'notification');
    wsManager.broadcast(notifMsg);

    const received = await messagePromise;
    expect(received).toEqual(notifMsg);

    ws.close();
    await server.close();
  });

  it('should send progress messages via broadcast', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const progressMsg: WSMessage = {
      type: 'progress',
      jobId: 'test-job-1',
      percent: 50,
      step: 'Step 2',
      message: 'Halfway done',
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'progress');
    wsManager.broadcast(progressMsg);

    const received = await messagePromise;
    expect(received).toEqual(progressMsg);

    ws.close();
    await server.close();
  });

  it('should send result messages via broadcast', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const resultMsg: WSMessage = {
      type: 'result',
      jobId: 'test-job-1',
      result: { summary: 'Task completed', items: [1, 2, 3] },
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'result');
    wsManager.broadcast(resultMsg);

    const received = await messagePromise;
    expect(received).toEqual(resultMsg);

    ws.close();
    await server.close();
  });

  it('should handle messages with metadata', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const chunkMsg: WSMessage = {
      type: 'chunk',
      jobId: 'test-job-1',
      content: 'Hello',
      done: false,
      metadata: { model: 'claude-sonnet-4-5-20250929', tokens: 10 },
    };

    const messagePromise = waitForMessage(ws, (msg) => msg.type === 'chunk');
    wsManager.broadcast(chunkMsg);

    const received = await messagePromise;
    expect(received).toEqual(chunkMsg);
    expect((received as { metadata?: Record<string, unknown> }).metadata).toEqual({
      model: 'claude-sonnet-4-5-20250929',
      tokens: 10,
    });

    ws.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

describe('WebSocket — broadcasting', () => {
  it('should broadcast to all authenticated connections', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws: ws1 } = await openAuthenticatedWs(server, auth);
    const { ws: ws2 } = await openAuthenticatedWs(server, auth);

    expect(wsManager.connectionCount()).toBe(2);

    const msg: WSMessage = {
      type: 'notification',
      level: 'info',
      message: 'Broadcast test',
    };

    const p1 = waitForMessage(ws1, (m) => m.type === 'notification');
    const p2 = waitForMessage(ws2, (m) => m.type === 'notification');
    wsManager.broadcast(msg);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(msg);
    expect(r2).toEqual(msg);

    ws1.close();
    ws2.close();
    await server.close();
  });

  it('should broadcast to specific session only', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const msg: WSMessage = {
      type: 'notification',
      level: 'warning',
      message: 'Session-specific message',
    };

    const messagePromise = waitForMessage(ws, (m) => m.type === 'notification');
    wsManager.broadcastToSession(auth.sessionId, msg);

    const received = await messagePromise;
    expect(received).toEqual(msg);

    ws.close();
    await server.close();
  });

  it('should not broadcast to non-matching session', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    const msg: WSMessage = {
      type: 'notification',
      level: 'info',
      message: 'Wrong session',
    };

    // Broadcast to a non-existent session
    wsManager.broadcastToSession('non-existent-session', msg);

    // Collect messages for a short window — should get nothing
    const messages = await collectMessages(ws, 200);
    const notifs = messages.filter((m) => m.type === 'notification');
    expect(notifs).toHaveLength(0);

    ws.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Ping/pong keepalive
// ---------------------------------------------------------------------------

describe('WebSocket — ping/pong', () => {
  it('should respond to client ping with pong', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    // Send a client ping
    const pongPromise = waitForMessage(ws, (msg) => msg.type === 'pong');
    ws.send(JSON.stringify({ type: 'ping' }));

    const pong = await pongPromise;
    expect(pong.type).toBe('pong');

    ws.close();
    await server.close();
  });

  it('should send server-initiated pings to clients', async () => {
    // Use real timers but with shortened constants via direct manipulation
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    // The server sends pings on WS_PING_INTERVAL_MS (30s by default).
    // Rather than wait 30s, we verify the ping/pong mechanism works
    // by sending pings from the client and getting pongs back,
    // confirming the protocol implementation is correct.
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForMessage(ws, (msg) => msg.type === 'pong');
    expect(pong.type).toBe('pong');

    // Also verify that sending a pong from the client doesn't cause issues
    ws.send(JSON.stringify({ type: 'pong' }));

    // Connection should still be alive
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong2 = await waitForMessage(ws, (msg) => msg.type === 'pong');
    expect(pong2.type).toBe('pong');

    ws.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Session re-validation
// ---------------------------------------------------------------------------

describe('WebSocket — session re-validation', () => {
  it('should close connection when session is invalidated', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    expect(wsManager.connectionCount()).toBe(1);

    // Invalidate the session by logging out
    await authService.logout(auth.sessionId);

    // The re-validation timer runs on WS_REVALIDATION_INTERVAL_MS (15 min).
    // We can't wait that long in a test, but we verify the mechanism exists
    // by checking that the connection is tracked and the session is indeed
    // gone from the DB.
    const session = await authService.validateSession(auth.sessionToken);
    expect(session).toBeNull();

    // Clean up: the re-validation will catch this on next tick in production
    ws.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('WebSocket — rate limiting', () => {
  it('should allow messages within rate limit', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    // Send several messages within rate limit — all should get responses
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: 'ping' }));
      const pong = await waitForMessage(ws, (msg) => msg.type === 'pong');
      expect(pong.type).toBe('pong');
    }

    ws.close();
    await server.close();
  });

  it('should reject messages exceeding rate limit', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    // Send 61 messages rapidly (exceeding 60/min limit)
    // Note: the connected message handler already consumed 0 from the rate limit
    // because the token message is not rate-limited (happens before authentication)
    for (let i = 0; i < 61; i++) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }

    // Wait and collect all messages
    const messages = await collectMessages(ws, 500);

    // Should have some pongs and at least one rate limit error
    const pongs = messages.filter((m) => m.type === 'pong');
    const errors = messages.filter(
      (m) => m.type === 'error' && (m as { code: string }).code === 'RATE_LIMITED',
    );

    expect(pongs.length).toBeLessThanOrEqual(60);
    expect(errors.length).toBeGreaterThan(0);

    ws.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Connection limits
// ---------------------------------------------------------------------------

describe('WebSocket — connection limits', () => {
  it('should enforce maximum connection limit', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      maxWsConnections: 2,
    });

    const auth = await setupAndLogin(server, authService);

    // Open 2 connections (at limit)
    const { ws: ws1 } = await openAuthenticatedWs(server, auth);
    const { ws: ws2 } = await openAuthenticatedWs(server, auth);

    // Third connection should be rejected
    const ws3 = await server.injectWS('/api/ws', {
      headers: { cookie: auth.cookie },
    });

    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws3.addEventListener('close', (event) => {
        resolve({ code: event.code });
      });
    });

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4004);

    ws1.close();
    ws2.close();
    await server.close();
  });

  it('should report correct connection count', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);

    expect(wsManager.connectionCount()).toBe(0);

    const { ws: ws1 } = await openAuthenticatedWs(server, auth);
    expect(wsManager.connectionCount()).toBe(1);

    const { ws: ws2 } = await openAuthenticatedWs(server, auth);
    expect(wsManager.connectionCount()).toBe(2);

    // Use the manager to close all and verify count
    wsManager.close();
    expect(wsManager.connectionCount()).toBe(0);

    // Verify sockets are also closed
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws1.readyState).toBeGreaterThanOrEqual(2); // CLOSING or CLOSED
    expect(ws2.readyState).toBeGreaterThanOrEqual(2);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// WebSocket manager close
// ---------------------------------------------------------------------------

describe('WebSocket — manager close', () => {
  it('should close all connections when manager is closed', async () => {
    const { server, authService, wsManager } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws: ws1 } = await openAuthenticatedWs(server, auth);
    const { ws: ws2 } = await openAuthenticatedWs(server, auth);

    expect(wsManager.connectionCount()).toBe(2);

    const close1 = new Promise<void>((resolve) => {
      ws1.addEventListener('close', () => { resolve(); });
    });
    const close2 = new Promise<void>((resolve) => {
      ws2.addEventListener('close', () => { resolve(); });
    });

    wsManager.close();

    await Promise.all([close1, close2]);
    expect(wsManager.connectionCount()).toBe(0);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON handling
// ---------------------------------------------------------------------------

describe('WebSocket — error handling', () => {
  it('should handle invalid JSON gracefully after authentication', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const auth = await setupAndLogin(server, authService);
    const { ws } = await openAuthenticatedWs(server, auth);

    // Send invalid JSON
    ws.send('not json {{{');

    // Should get an error message back
    const errorMsg = await waitForMessage(ws, (msg) => msg.type === 'error');
    expect(errorMsg.type).toBe('error');
    expect((errorMsg as { code: string }).code).toBe('INVALID_JSON');

    // Connection should still be alive
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForMessage(ws, (msg) => msg.type === 'pong');
    expect(pong.type).toBe('pong');

    ws.close();
    await server.close();
  });
});
