/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { type BridgeConfig, DatabaseClient, type Logger, migrate } from '@meridian/shared';

import { createServer } from '../server.js';

import {
  generateTOTPToken,
  validateTOTP,
  encodeBase32,
  buildOtpauthUri,
  generateBackupCodes,
  isTOTPEnabled,
  validateTOTPToken,
} from './totp.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : String(setCookieHeader);
  return raw.split(';')[0]!;
}

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

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-totp');
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
  dbPath = join(TEST_DIR, `test-totp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
// TOTP Core Unit Tests
// ---------------------------------------------------------------------------

describe('TOTP core functions', () => {
  it('should generate a 6-digit token', () => {
    const secret = Buffer.from('12345678901234567890');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const token = generateTOTPToken(secret, timeStep);

    expect(token).toHaveLength(6);
    expect(/^\d{6}$/.test(token)).toBe(true);
  });

  it('should generate consistent tokens for the same time step', () => {
    const secret = Buffer.from('testsecret1234567890');
    const timeStep = 1000;

    const token1 = generateTOTPToken(secret, timeStep);
    const token2 = generateTOTPToken(secret, timeStep);

    expect(token1).toBe(token2);
  });

  it('should generate different tokens for different time steps', () => {
    const secret = Buffer.from('testsecret1234567890');

    const token1 = generateTOTPToken(secret, 1000);
    const token2 = generateTOTPToken(secret, 1001);

    expect(token1).not.toBe(token2);
  });

  it('should validate a correct token', () => {
    const secret = Buffer.from('12345678901234567890');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const token = generateTOTPToken(secret, timeStep);

    expect(validateTOTP(secret, token)).toBe(true);
  });

  it('should reject an invalid token', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(validateTOTP(secret, '000000')).toBe(false);
  });

  it('should encode base32 correctly', () => {
    // Test with known value: "Hello!" -> JBSWY3DPEE======
    // But we'll test with TOTP-relevant values
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21]);
    const result = encodeBase32(buf);
    expect(result).toBe('JBSWY3DPEE');
  });

  it('should build a valid otpauth URI', () => {
    const secret = Buffer.alloc(20, 0xab);
    const uri = buildOtpauthUri(secret, 'Meridian', 'user');

    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('Meridian');
    expect(uri).toContain('user');
    expect(uri).toContain('secret=');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('should generate 10 backup codes of 8 hex chars', () => {
    const codes = generateBackupCodes();

    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(code)).toBe(true);
    }
  });

  it('should generate unique backup codes', () => {
    const codes = generateBackupCodes();
    const unique = new Set(codes);
    // Extremely unlikely to have duplicates with 4 bytes of entropy each
    expect(unique.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// TOTP Routes
// ---------------------------------------------------------------------------

describe('TOTP routes', () => {
  it('should report TOTP as disabled by default', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie } = await setupAuth(server);

    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/totp/status',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { enabled: boolean };
    expect(body.enabled).toBe(false);

    await server.close();
  });

  it('should setup TOTP and return secret + backup codes', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      otpauthUri: string;
      secret: string;
      backupCodes: string[];
    };

    expect(body.otpauthUri).toContain('otpauth://totp/');
    expect(body.secret).toBeDefined();
    expect(body.secret.length).toBeGreaterThan(0);
    expect(body.backupCodes).toHaveLength(10);

    // TOTP should still be disabled (not yet verified)
    const statusRes = await server.inject({
      method: 'GET',
      url: '/api/auth/totp/status',
      headers: { cookie },
    });
    const statusBody = JSON.parse(statusRes.body) as { enabled: boolean };
    expect(statusBody.enabled).toBe(false);

    await server.close();
  });

  it('should reject verification with invalid token', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup first
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // Try to verify with an invalid token
    const verifyRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: '000000' },
    });

    expect(verifyRes.statusCode).toBe(400);
    const body = JSON.parse(verifyRes.body) as { error: string };
    expect(body.error).toContain('Invalid TOTP token');

    await server.close();
  });

  it('should complete full TOTP setup flow', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Step 1: Setup
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // Get the secret from the database to generate a valid token
    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secretHex = rows[0]!.secret_hex;
    const secret = Buffer.from(secretHex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    // Step 2: Verify with valid token
    const verifyRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = JSON.parse(verifyRes.body) as { enabled: boolean };
    expect(verifyBody.enabled).toBe(true);

    // Step 3: Status should now be enabled
    const statusRes = await server.inject({
      method: 'GET',
      url: '/api/auth/totp/status',
      headers: { cookie },
    });
    const statusBody = JSON.parse(statusRes.body) as { enabled: boolean };
    expect(statusBody.enabled).toBe(true);

    await server.close();
  });

  it('should validate TOTP token after enabling', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup and enable TOTP
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secret = Buffer.from(rows[0]!.secret_hex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    // Validate with a fresh token
    const freshToken = generateTOTPToken(secret, timeStep);
    const validateRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/validate',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: freshToken },
    });

    expect(validateRes.statusCode).toBe(200);
    const body = JSON.parse(validateRes.body) as { valid: boolean };
    expect(body.valid).toBe(true);

    await server.close();
  });

  it('should reject invalid TOTP token on validation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup and enable TOTP
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secret = Buffer.from(rows[0]!.secret_hex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    // Validate with invalid token
    const validateRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/validate',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: '999999' },
    });

    expect(validateRes.statusCode).toBe(401);

    await server.close();
  });

  it('should accept backup codes for validation', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup TOTP
    const setupRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const setupBody = JSON.parse(setupRes.body) as { backupCodes: string[] };
    const backupCode = setupBody.backupCodes[0]!;

    // Enable TOTP
    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secret = Buffer.from(rows[0]!.secret_hex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    // Validate with backup code
    const validateRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/validate',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: backupCode },
    });

    expect(validateRes.statusCode).toBe(200);
    const body = JSON.parse(validateRes.body) as { valid: boolean };
    expect(body.valid).toBe(true);

    // Same backup code should NOT work again
    const secondRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/validate',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: backupCode },
    });

    expect(secondRes.statusCode).toBe(401);

    await server.close();
  });

  it('should disable TOTP with valid password', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup and enable TOTP
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secret = Buffer.from(rows[0]!.secret_hex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    // Disable with correct password
    const disableRes = await server.inject({
      method: 'DELETE',
      url: '/api/auth/totp',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { password: 'TestPassword123!' },
    });

    expect(disableRes.statusCode).toBe(200);
    const body = JSON.parse(disableRes.body) as { disabled: boolean };
    expect(body.disabled).toBe(true);

    // Status should be disabled
    const statusRes = await server.inject({
      method: 'GET',
      url: '/api/auth/totp/status',
      headers: { cookie },
    });
    const statusBody = JSON.parse(statusRes.body) as { enabled: boolean };
    expect(statusBody.enabled).toBe(false);

    await server.close();
  });

  it('should reject disable with wrong password', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup and enable TOTP
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secret = Buffer.from(rows[0]!.secret_hex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    // Try to disable with wrong password
    const disableRes = await server.inject({
      method: 'DELETE',
      url: '/api/auth/totp',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { password: 'WrongPassword!' },
    });

    expect(disableRes.statusCode).toBe(401);

    await server.close();
  });

  it('should reject re-setup when already enabled', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Setup and enable
    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const rows = await db.query<{ secret_hex: string }>(
      'meridian',
      'SELECT secret_hex FROM totp_config WHERE id = 1',
    );
    const secret = Buffer.from(rows[0]!.secret_hex, 'hex');
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const validToken = generateTOTPToken(secret, timeStep);

    await server.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { token: validToken },
    });

    // Try to setup again
    const setupRes = await server.inject({
      method: 'POST',
      url: '/api/auth/totp/setup',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(setupRes.statusCode).toBe(409);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// TOTP helper function tests
// ---------------------------------------------------------------------------

describe('isTOTPEnabled', () => {
  it('should return false when no config exists', async () => {
    expect(await isTOTPEnabled(db)).toBe(false);
  });

  it('should return false when config exists but not enabled', async () => {
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO totp_config (id, secret_hex, enabled, backup_codes_json, created_at, updated_at)
       VALUES (1, 'abc123', 0, '[]', ?, ?)`,
      [now, now],
    );
    expect(await isTOTPEnabled(db)).toBe(false);
  });

  it('should return true when config is enabled', async () => {
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO totp_config (id, secret_hex, enabled, backup_codes_json, created_at, updated_at)
       VALUES (1, 'abc123', 1, '[]', ?, ?)`,
      [now, now],
    );
    expect(await isTOTPEnabled(db)).toBe(true);
  });
});

describe('validateTOTPToken helper', () => {
  it('should return false when TOTP is not enabled', async () => {
    expect(await validateTOTPToken(db, '000000')).toBe(false);
  });

  it('should validate a correct TOTP token', async () => {
    const secret = Buffer.from('12345678901234567890');
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO totp_config (id, secret_hex, enabled, backup_codes_json, created_at, updated_at)
       VALUES (1, ?, 1, '[]', ?, ?)`,
      [secret.toString('hex'), now, now],
    );

    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const token = generateTOTPToken(secret, timeStep);

    expect(await validateTOTPToken(db, token)).toBe(true);
  });

  it('should validate a backup code and consume it', async () => {
    const secret = Buffer.from('12345678901234567890');
    const backupCodes = ['aabbccdd', 'eeffaabb'];
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      `INSERT INTO totp_config (id, secret_hex, enabled, backup_codes_json, created_at, updated_at)
       VALUES (1, ?, 1, ?, ?, ?)`,
      [secret.toString('hex'), JSON.stringify(backupCodes), now, now],
    );

    // First use: should succeed
    expect(await validateTOTPToken(db, 'aabbccdd')).toBe(true);

    // Second use: should fail (consumed)
    expect(await validateTOTPToken(db, 'aabbccdd')).toBe(false);

    // Other backup code should still work
    expect(await validateTOTPToken(db, 'eeffaabb')).toBe(true);
  });
});
