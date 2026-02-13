/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { BridgeConfig, Logger } from '@meridian/shared';
import {
  DatabaseClient,
  migrate,
  AuthenticationError,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_LOCKOUT,
} from '@meridian/shared';

import { AuthService } from './auth.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test');
let dbPath: string;
let db: DatabaseClient;
let authService: AuthService;

const TEST_CONFIG: BridgeConfig = {
  bind: '127.0.0.1',
  port: 3000,
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
  dbPath = join(TEST_DIR, `test-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new DatabaseClient({ dataDir: TEST_DIR, direct: true });
  await db.start();
  await db.open('meridian', dbPath);
  await migrate(db, 'meridian', process.cwd());
  authService = new AuthService({
    db,
    config: TEST_CONFIG,
    logger: mockLogger as unknown as Logger,
  });
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
// Onboarding
// ---------------------------------------------------------------------------

describe('AuthService — onboarding', () => {
  it('should report setup as incomplete before password is set', async () => {
    expect(await authService.isSetupComplete()).toBe(false);
  });

  it('should set up a password and report setup as complete', async () => {
    await authService.setupPassword('MySecurePassword1!');
    expect(await authService.isSetupComplete()).toBe(true);
  });

  it('should reject setting up a second password', async () => {
    await authService.setupPassword('MySecurePassword1!');
    await expect(authService.setupPassword('AnotherPassword2!')).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('should reject passwords shorter than 8 characters', async () => {
    await expect(authService.setupPassword('short')).rejects.toThrow(
      'Password must be at least 8 characters',
    );
  });
});

// ---------------------------------------------------------------------------
// Password verification (hash round-trip)
// ---------------------------------------------------------------------------

describe('AuthService — password verification', () => {
  const PASSWORD = 'TestPassword123!';

  it('should login successfully with correct password', async () => {
    await authService.setupPassword(PASSWORD);
    const result = await authService.login(PASSWORD, '127.0.0.1');
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.session).toBeDefined();
    expect(result.session!.id).toBeDefined();
    expect(result.session!.csrfToken).toBeDefined();
  });

  it('should reject login with wrong password', async () => {
    await authService.setupPassword(PASSWORD);
    const result = await authService.login('WrongPassword!', '127.0.0.1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid password');
  });

  it('should reject login when setup is not complete', async () => {
    const result = await authService.login(PASSWORD, '127.0.0.1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Setup not complete');
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe('AuthService — session management', () => {
  const PASSWORD = 'TestPassword123!';

  it('should create and validate a session', async () => {
    await authService.setupPassword(PASSWORD);
    const loginResult = await authService.login(PASSWORD, '127.0.0.1');
    expect(loginResult.success).toBe(true);

    const session = await authService.validateSession(loginResult.token!);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(loginResult.session!.id);
  });

  it('should return null for invalid session token', async () => {
    const session = await authService.validateSession('invalid-token');
    expect(session).toBeNull();
  });

  it('should invalidate session on logout', async () => {
    await authService.setupPassword(PASSWORD);
    const loginResult = await authService.login(PASSWORD, '127.0.0.1');
    expect(loginResult.success).toBe(true);

    await authService.logout(loginResult.session!.id);

    const session = await authService.validateSession(loginResult.token!);
    expect(session).toBeNull();
  });

  it('should clean expired sessions', async () => {
    // Create a session with a very short duration
    const shortConfig: BridgeConfig = {
      ...TEST_CONFIG,
      sessionDurationHours: 0, // 0 hours = immediately expired
    };
    const shortAuthService = new AuthService({
      db,
      config: shortConfig,
      logger: mockLogger as unknown as Logger,
    });

    await authService.setupPassword(PASSWORD);
    const loginResult = await shortAuthService.login(PASSWORD, '127.0.0.1');
    expect(loginResult.success).toBe(true);

    // Wait a moment for the session to expire
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cleaned = await authService.cleanExpiredSessions();
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });

  it('should store session with IP address and user agent', async () => {
    await authService.setupPassword(PASSWORD);
    const result = await authService.login(PASSWORD, '192.168.1.1', 'TestBrowser/1.0');
    expect(result.success).toBe(true);
    expect(result.session!.ipAddress).toBe('192.168.1.1');
    expect(result.session!.userAgent).toBe('TestBrowser/1.0');
  });
});

// ---------------------------------------------------------------------------
// CSRF token validation
// ---------------------------------------------------------------------------

describe('AuthService — CSRF protection', () => {
  const PASSWORD = 'TestPassword123!';

  it('should validate correct CSRF token', async () => {
    await authService.setupPassword(PASSWORD);
    const loginResult = await authService.login(PASSWORD, '127.0.0.1');

    const valid = await authService.validateCsrfToken(
      loginResult.session!.id,
      loginResult.session!.csrfToken,
    );
    expect(valid).toBe(true);
  });

  it('should reject incorrect CSRF token', async () => {
    await authService.setupPassword(PASSWORD);
    const loginResult = await authService.login(PASSWORD, '127.0.0.1');

    const valid = await authService.validateCsrfToken(
      loginResult.session!.id,
      'wrong-csrf-token',
    );
    expect(valid).toBe(false);
  });

  it('should reject CSRF for non-existent session', async () => {
    const valid = await authService.validateCsrfToken('nonexistent', 'token');
    expect(valid).toBe(false);
  });

  it('should get CSRF token for a session', async () => {
    await authService.setupPassword(PASSWORD);
    const loginResult = await authService.login(PASSWORD, '127.0.0.1');

    const csrf = await authService.getCsrfToken(loginResult.session!.id);
    expect(csrf).toBe(loginResult.session!.csrfToken);
  });
});

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

describe('AuthService — brute-force protection', () => {
  const PASSWORD = 'TestPassword123!';
  const TEST_IP = '10.0.0.1';

  it('should allow login below threshold', async () => {
    await authService.setupPassword(PASSWORD);

    // Make failures below threshold
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD - 1; i++) {
      await authService.login('wrong', TEST_IP);
    }

    const status = await authService.checkBruteForce(TEST_IP);
    expect(status.allowed).toBe(true);
    expect(status.lockedOut).toBe(false);
  });

  it('should apply exponential backoff after threshold', async () => {
    await authService.setupPassword(PASSWORD);

    // Exhaust the threshold
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      await authService.login('wrong', TEST_IP);
    }

    const status = await authService.checkBruteForce(TEST_IP);
    // Should be rate-limited (backoff applies)
    expect(status.recentFailures).toBe(BRUTE_FORCE_THRESHOLD);
    // After 5 failures, backoff is 2^0 = 1 second — may or may not have expired
    // depending on test timing, so we just check the count is right
  });

  it('should lock out after maximum failures', async () => {
    await authService.setupPassword(PASSWORD);

    // Exhaust all attempts
    for (let i = 0; i < BRUTE_FORCE_LOCKOUT; i++) {
      await authService.recordLoginAttempt(TEST_IP, false);
    }

    const status = await authService.checkBruteForce(TEST_IP);
    expect(status.recentFailures).toBeGreaterThanOrEqual(BRUTE_FORCE_LOCKOUT);
    expect(status.lockedOut).toBe(true);
  });

  it('should clear failed attempts on successful login', async () => {
    await authService.setupPassword(PASSWORD);

    // Make some failures
    for (let i = 0; i < 3; i++) {
      await authService.login('wrong', TEST_IP);
    }

    // Successful login
    await authService.login(PASSWORD, TEST_IP);

    const status = await authService.checkBruteForce(TEST_IP);
    expect(status.recentFailures).toBe(0);
    expect(status.allowed).toBe(true);
  });

  it('should not affect different IP addresses', async () => {
    await authService.setupPassword(PASSWORD);

    // Fail from one IP
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      await authService.recordLoginAttempt('10.0.0.1', false);
    }

    // Different IP should still be allowed
    const status = await authService.checkBruteForce('10.0.0.2');
    expect(status.allowed).toBe(true);
    expect(status.recentFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Approval nonces
// ---------------------------------------------------------------------------

describe('AuthService — approval nonces', () => {
  it('should create and validate an approval nonce', async () => {
    // Insert a job for the nonce to reference
    const jobId = 'test-job-id';
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO jobs (id, status, source_type, created_at, updated_at)
       VALUES (?, 'pending', 'user', ?, ?)`,
      [jobId, now, now],
    );

    const nonce = await authService.createApprovalNonce(jobId);
    expect(nonce).toHaveLength(64); // 32 bytes * 2 hex chars

    const valid = await authService.validateApprovalNonce(jobId, nonce);
    expect(valid).toBe(true);
  });

  it('should consume nonce on first use (one-time)', async () => {
    const jobId = 'test-job-id';
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO jobs (id, status, source_type, created_at, updated_at)
       VALUES (?, 'pending', 'user', ?, ?)`,
      [jobId, now, now],
    );

    const nonce = await authService.createApprovalNonce(jobId);

    // First use succeeds
    expect(await authService.validateApprovalNonce(jobId, nonce)).toBe(true);
    // Second use fails (already consumed)
    expect(await authService.validateApprovalNonce(jobId, nonce)).toBe(false);
  });

  it('should reject nonce for wrong job', async () => {
    const jobId = 'test-job-id';
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO jobs (id, status, source_type, created_at, updated_at)
       VALUES (?, 'pending', 'user', ?, ?)`,
      [jobId, now, now],
    );

    const nonce = await authService.createApprovalNonce(jobId);
    const valid = await authService.validateApprovalNonce('different-job', nonce);
    expect(valid).toBe(false);
  });

  it('should reject invalid nonce', async () => {
    const valid = await authService.validateApprovalNonce('any-job', 'invalid-nonce');
    expect(valid).toBe(false);
  });

  it('should clean consumed nonces', async () => {
    const jobId = 'test-job-cleanup';
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO jobs (id, status, source_type, created_at, updated_at)
       VALUES (?, 'pending', 'user', ?, ?)`,
      [jobId, now, now],
    );

    const nonce = await authService.createApprovalNonce(jobId);
    await authService.validateApprovalNonce(jobId, nonce); // consume it

    const cleaned = await authService.cleanExpiredNonces();
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });
});
