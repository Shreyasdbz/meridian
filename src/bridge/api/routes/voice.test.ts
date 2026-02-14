/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { type BridgeConfig, DatabaseClient, type Logger, migrate } from '@meridian/shared';

import { createServer } from '../server.js';

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

/**
 * Build a multipart request body with an audio file.
 */
function buildMultipartBody(
  filename: string,
  mimeType: string,
  data: Buffer,
): { body: Buffer; boundary: string } {
  const boundary = '----TestBoundary12345';
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, data, epilogue]);
  return { body, boundary };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-voice');
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
  dbPath = join(TEST_DIR, `test-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
// Voice transcription routes
// ---------------------------------------------------------------------------

describe('Voice transcription routes', () => {
  it('should reject non-multipart requests', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain('multipart/form-data');

    await server.close();
  });

  it('should reject unsupported audio formats', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const { body: payload, boundary } = buildMultipartBody(
      'test.txt',
      'text/plain',
      Buffer.from('not audio data'),
    );

    const res = await server.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain('Unsupported audio format');

    await server.close();
  });

  it('should reject empty audio files', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    const { cookie, csrfToken } = await setupAuth(server);

    const { body: payload, boundary } = buildMultipartBody(
      'test.wav',
      'audio/wav',
      Buffer.alloc(0),
    );

    const res = await server.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain('empty');

    await server.close();
  });

  it('should return 503 when transcription service is unavailable', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      // Point to a non-existent endpoint
      whisperEndpoint: 'http://127.0.0.1:19999',
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Fake WAV header (44 bytes minimum)
    const fakeWav = Buffer.alloc(100);
    fakeWav.write('RIFF', 0);
    fakeWav.writeUInt32LE(92, 4);
    fakeWav.write('WAVE', 8);

    const { body: payload, boundary } = buildMultipartBody(
      'test.wav',
      'audio/wav',
      fakeWav,
    );

    const res = await server.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBeDefined();

    await server.close();
  });

  it('should accept valid audio file extensions', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
      whisperEndpoint: 'http://127.0.0.1:19999',
    });

    const { cookie, csrfToken } = await setupAuth(server);

    // Test that .webm is accepted (even without MIME type match)
    const { body: payload, boundary } = buildMultipartBody(
      'test.webm',
      'audio/webm',
      Buffer.alloc(50, 0xff),
    );

    const res = await server.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    // Should be 503 (service unavailable) not 400 (bad request)
    // which proves the file was accepted
    expect(res.statusCode).toBe(503);

    await server.close();
  });

  it('should require authentication', async () => {
    const { server } = await createServer({
      config: TEST_CONFIG,
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });

    // Don't setup auth
    const res = await server.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        'content-type': 'multipart/form-data; boundary=test',
      },
    });

    // Should get 401 from auth middleware
    expect(res.statusCode).toBe(401);

    await server.close();
  });
});
