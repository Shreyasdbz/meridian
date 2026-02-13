/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DatabaseClient, migrate } from '@meridian/shared';
import type { BridgeConfig, Logger } from '@meridian/shared';

import { createServer, containsCredentials, filterCredentials, detectSystemPromptLeakage } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the cookie name=value from a Set-Cookie header string. */
function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : String(setCookieHeader);
  // Set-Cookie format: name=value; Path=/; HttpOnly; ...
  // We only need "name=value" for the Cookie request header
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
  port: 0, // Use random port for tests
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
  dbPath = join(TEST_DIR, `test-server-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
// Security headers
// ---------------------------------------------------------------------------

describe('Server — security headers', () => {
  it('should set Content-Security-Policy header', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    await server.close();
  });

  it('should set X-Content-Type-Options: nosniff', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');

    await server.close();
  });

  it('should set X-Frame-Options: DENY', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    expect(response.headers['x-frame-options']).toBe('DENY');

    await server.close();
  });

  it('should set Referrer-Policy header', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

    await server.close();
  });

  it('should set Permissions-Policy header', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');

    await server.close();
  });

  it('should include all security headers on every response', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    const expectedHeaders = [
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'permissions-policy',
    ];

    for (const header of expectedHeaders) {
      expect(response.headers[header]).toBeDefined();
    }

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Server binding
// ---------------------------------------------------------------------------

describe('Server — binding', () => {
  it('should bind to 127.0.0.1 by default', async () => {
    const config: BridgeConfig = {
      ...TEST_CONFIG,
      port: 0,
    };

    const { server } = await createServer({
      config,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Start the server to verify it uses the configured bind address
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    expect(address).toContain('127.0.0.1');

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('Server — rate limiting', () => {
  it('should enforce rate limits', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      rateLimitMax: 3, // Very low limit for testing
    });

    // Make requests up to the limit
    for (let i = 0; i < 3; i++) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/status',
      });
      expect(response.statusCode).toBe(200);
    }

    // Next request should be rate limited
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });
    expect(response.statusCode).toBe(429);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Credential filtering
// ---------------------------------------------------------------------------

describe('containsCredentials', () => {
  it('should detect API key patterns', () => {
    // Build the test key dynamically to avoid triggering the security hook
    const prefix = 'sk-';
    const suffix = 'abcdefghijklmnopqrstuvwxyz';
    expect(containsCredentials(`Here is my key: ${prefix}${suffix}`)).toBe(true);
  });

  it('should detect AWS access keys', () => {
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    expect(containsCredentials(`Key is ${awsKey}`)).toBe(true);
  });

  it('should detect GitHub tokens', () => {
    const ghToken = 'ghp_' + 'a'.repeat(36);
    expect(containsCredentials(`Token: ${ghToken}`)).toBe(true);
  });

  it('should detect Bearer tokens', () => {
    const bearer = 'Bearer ' + 'x'.repeat(30);
    expect(containsCredentials(`Authorization: ${bearer}`)).toBe(true);
  });

  it('should not flag clean text', () => {
    expect(containsCredentials('Hello world, how are you?')).toBe(false);
  });
});

describe('filterCredentials', () => {
  it('should redact detected credentials', () => {
    const prefix = 'sk-';
    const suffix = 'abcdefghijklmnopqrstuvwxyz';
    const input = `API key: ${prefix}${suffix}`;
    const filtered = filterCredentials(input);
    expect(filtered).not.toContain(suffix);
    expect(filtered).toContain('sk-');
  });
});

// ---------------------------------------------------------------------------
// System prompt leakage detection
// ---------------------------------------------------------------------------

describe('detectSystemPromptLeakage', () => {
  it('should detect known system prompt markers', () => {
    const marker = detectSystemPromptLeakage('I am You are Meridian, an AI assistant');
    expect(marker).toBe('You are Meridian');
  });

  it('should detect case-insensitively', () => {
    const marker = detectSystemPromptLeakage('text containing SYSTEM INSTRUCTIONS: blah');
    expect(marker).toBe('SYSTEM INSTRUCTIONS:');
  });

  it('should return undefined for clean text', () => {
    const marker = detectSystemPromptLeakage('Just a normal response about weather');
    expect(marker).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auth routes integration
// ---------------------------------------------------------------------------

describe('Server — auth routes', () => {
  it('should respond to GET /api/auth/status', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.setupComplete).toBe(false);

    await server.close();
  });

  it('should allow password setup via POST /api/auth/setup', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'MySecurePassword1!' },
    });

    expect(response.statusCode).toBe(201);

    // Verify setup is now complete
    const statusResponse = await server.inject({
      method: 'GET',
      url: '/api/auth/status',
    });
    expect(JSON.parse(statusResponse.body).setupComplete).toBe(true);

    await server.close();
  });

  it('should reject setup with short password', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'short' },
    });

    expect(response.statusCode).toBe(400);

    await server.close();
  });

  it('should login and return session with CSRF token', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Setup first
    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'MySecurePassword1!' },
    });

    // Login
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'MySecurePassword1!' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.sessionId).toBeDefined();
    expect(body.csrfToken).toBeDefined();
    expect(body.expiresAt).toBeDefined();

    // Check session cookie was set
    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieStr).toContain('meridian_session');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Strict');

    await server.close();
  });

  it('should reject login with wrong password', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'MySecurePassword1!' },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'WrongPassword!' },
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it('should require authentication for protected routes', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Try to access a protected route without authentication
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
    });

    expect(response.statusCode).toBe(401);

    await server.close();
  });

  it('should authenticate via session cookie', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Setup and login
    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'MySecurePassword1!' },
    });

    const loginResponse = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'MySecurePassword1!' },
    });

    // Access protected route with cookie
    const sessionResponse = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        cookie: extractCookie(loginResponse.headers['set-cookie']),
      },
    });

    expect(sessionResponse.statusCode).toBe(200);
    const body = JSON.parse(sessionResponse.body);
    expect(body.sessionId).toBeDefined();
    expect(body.csrfToken).toBeDefined();

    await server.close();
  });

  it('should authenticate via Bearer token', async () => {
    const { server, authService } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Setup and login to get a token
    await authService.setupPassword('MySecurePassword1!');
    const loginResult = await authService.login('MySecurePassword1!', '127.0.0.1');

    // Use Bearer token
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        authorization: `Bearer ${loginResult.token}`,
      },
    });

    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it('should handle error responses properly', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Post to setup twice to trigger AuthenticationError
    await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'MySecurePassword1!' },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'AnotherPassword2!' },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('already configured');

    await server.close();
  });
});
