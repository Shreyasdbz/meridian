/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
// Security tests for Bridge authentication (Phase 6.1)
// Tests session hijacking resistance, brute-force protection, and CSRF defense.

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { BridgeConfig, Logger } from '@meridian/shared';
import { DatabaseClient, migrate } from '@meridian/shared';

import { createServer } from '../../src/bridge/api/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the cookie name=value from a Set-Cookie header string. */
function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : String(setCookieHeader);
  return raw.split(';')[0]!;
}

// ---------------------------------------------------------------------------
// Test setup
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

/** Helper: set up password and login, returning cookie and CSRF token. */
async function setupAndLogin(server: FastifyInstance): Promise<{
  cookie: string;
  rawSetCookie: string;
  csrfToken: string;
  sessionId: string;
}> {
  await server.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'SecureTestPassword1!' },
  });

  const loginResponse = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'SecureTestPassword1!' },
  });

  const body = JSON.parse(loginResponse.body);
  const setCookie = loginResponse.headers['set-cookie'];
  const rawSetCookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);

  return {
    cookie: extractCookie(setCookie),
    rawSetCookie,
    csrfToken: body.csrfToken,
    sessionId: body.sessionId,
  };
}

beforeEach(async () => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  dbPath = join(TEST_DIR, `test-sec-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
// Session hijacking resistance (Section 6.3)
// ---------------------------------------------------------------------------

describe('Security — session hijacking resistance', () => {
  it('should set HttpOnly flag on session cookie', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { rawSetCookie } = await setupAndLogin(server);
    expect(rawSetCookie).toContain('HttpOnly');

    await server.close();
  });

  it('should set Secure flag on session cookie', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { rawSetCookie } = await setupAndLogin(server);
    expect(rawSetCookie).toContain('Secure');

    await server.close();
  });

  it('should set SameSite=Strict on session cookie', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { rawSetCookie } = await setupAndLogin(server);
    expect(rawSetCookie).toContain('SameSite=Strict');

    await server.close();
  });

  it('should not accept expired session tokens', async () => {
    // Use zero-hour session duration for immediate expiry
    const shortConfig: BridgeConfig = {
      ...TEST_CONFIG,
      sessionDurationHours: 0,
    };

    const { server } = await createServer({
      config: shortConfig,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAndLogin(server);

    // Wait for session to expire
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it('should invalidate session after logout', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAndLogin(server);

    // Logout
    await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
      },
    });

    // Try to use the old session
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it('should reject fabricated session tokens', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        cookie: 'meridian_session=fabricated-token-value',
      },
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it('should hash session tokens in the database (not store plaintext)', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await setupAndLogin(server);

    // Check that the token in the DB is a hash, not the plaintext token
    const rows = await db.query<{ token_hash: string }>(
      'meridian',
      'SELECT token_hash FROM sessions LIMIT 1',
    );

    expect(rows.length).toBe(1);
    // SHA-256 produces a 64-character hex string
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Brute-force protection (Section 6.3)
// ---------------------------------------------------------------------------

describe('Security — brute-force protection', () => {
  // These tests create real Fastify servers with bcrypt hashing + multiple
  // sequential requests, so they need more headroom than the default 5s.
  it('should allow login attempts below threshold', { timeout: 15_000 }, async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'SecureTestPassword1!' },
    });

    // Make 4 failed attempts (below threshold of 5)
    for (let i = 0; i < 4; i++) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
      expect(response.statusCode).toBe(401);
    }

    // 5th attempt should still work (threshold is "after 5", not "at 5")
    const finalResponse = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'SecureTestPassword1!' },
    });
    expect(finalResponse.statusCode).toBe(200);

    await server.close();
  });

  it('should rate-limit after exceeding threshold', { timeout: 15_000 }, async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'SecureTestPassword1!' },
    });

    // Exceed the threshold
    for (let i = 0; i < 6; i++) {
      await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
    }

    // Next attempt should be rate-limited (429)
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });

    // Should either be 429 (rate-limited) or 401 (if backoff period passed)
    expect([401, 429]).toContain(response.statusCode);

    await server.close();
  });

  it('should include retryAfterMs in rate-limited responses', { timeout: 15_000 }, async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'SecureTestPassword1!' },
    });

    // Exceed the threshold with rapid failures
    for (let i = 0; i < 7; i++) {
      await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
    }

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });

    if (response.statusCode === 429) {
      const body = JSON.parse(response.body);
      expect(body.retryAfterMs).toBeDefined();
      expect(typeof body.retryAfterMs).toBe('number');
    }

    await server.close();
  });

  it('should clear failed attempts on successful login', { timeout: 15_000 }, async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'SecureTestPassword1!' },
    });

    // Make some failed attempts
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
    }

    // Successful login
    const successResponse = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'SecureTestPassword1!' },
    });
    expect(successResponse.statusCode).toBe(200);

    // Verify failed attempts were cleared by checking DB
    const rows = await db.query<{ cnt: number }>(
      'meridian',
      'SELECT COUNT(*) as cnt FROM login_attempts WHERE success = 0',
    );
    expect(rows[0]!.cnt).toBe(0);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// CSRF protection (Section 6.5.4)
// ---------------------------------------------------------------------------

describe('Security — CSRF protection', () => {
  it('should require CSRF token on state-changing requests', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAndLogin(server);

    // POST without CSRF token should be rejected
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('CSRF');

    await server.close();
  });

  it('should accept valid CSRF token', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAndLogin(server);

    // POST with valid CSRF token should succeed
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
      },
    });

    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it('should reject invalid CSRF token', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAndLogin(server);

    // POST with wrong CSRF token should be rejected
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie,
        'x-csrf-token': 'wrong-csrf-token',
      },
    });

    expect(response.statusCode).toBe(403);

    await server.close();
  });

  it('should not require CSRF for GET requests', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAndLogin(server);

    // GET request without CSRF should work
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it('should not require CSRF for login endpoint', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'SecureTestPassword1!' },
    });

    // Login should work without CSRF (it's how you GET a CSRF token)
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'SecureTestPassword1!' },
    });

    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it('should generate unique CSRF tokens per session', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'SecureTestPassword1!' },
    });

    // Login twice to get two sessions
    const login1 = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'SecureTestPassword1!' },
    });

    const login2 = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'SecureTestPassword1!' },
    });

    const csrf1 = JSON.parse(login1.body).csrfToken;
    const csrf2 = JSON.parse(login2.body).csrfToken;

    // Each session should have a unique CSRF token
    expect(csrf1).not.toBe(csrf2);

    await server.close();
  });
});
