// @meridian/bridge — TOTP two-factor authentication routes (Phase 11.3)
// Implements RFC 6238 TOTP using Node.js crypto (no external packages).
// Supports setup, verification, validation, disable, and status endpoints.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcrypt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseClient } from '@meridian/shared';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TOTPRouteOptions {
  db: DatabaseClient;
  logger?: TOTPRouteLogger;
}

export interface TOTPRouteLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

interface VerifyBody {
  token: string;
}

interface ValidateBody {
  token: string;
}

interface DisableBody {
  password: string;
}

// ---------------------------------------------------------------------------
// TOTP Core (RFC 6238)
// ---------------------------------------------------------------------------

/** Number of bytes for TOTP secret (160 bits = 20 bytes, per RFC 4226). */
const TOTP_SECRET_BYTES = 20;

/** Number of backup codes to generate. */
const BACKUP_CODE_COUNT = 10;

/** Backup code length in hex characters (8 chars = 4 bytes). */
const BACKUP_CODE_BYTES = 4;

/** Window tolerance: accept tokens from T-1, T, T+1. */
const TOTP_WINDOW = 1;

/**
 * Generate a TOTP token for the given secret and time step.
 * Implements HMAC-based One-Time Password (RFC 4226 / RFC 6238).
 */
function generateTOTPToken(secret: Buffer, timeStep: number): string {
  // Convert time step to 8-byte big-endian buffer
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
  timeBuffer.writeUInt32BE(timeStep >>> 0, 4);

  // HMAC-SHA1 as per RFC 6238
  const hmac = createHmac('sha1', secret);
  hmac.update(timeBuffer);
  const hash = hmac.digest();

  // Dynamic truncation (RFC 4226 Section 5.4)
  const offset = (hash[hash.length - 1] as number) & 0x0f;
  const binary =
    (((hash[offset] as number) & 0x7f) << 24) |
    (((hash[offset + 1] as number) & 0xff) << 16) |
    (((hash[offset + 2] as number) & 0xff) << 8) |
    ((hash[offset + 3] as number) & 0xff);

  // Generate TOTP_DIGITS-length code
  const otp = binary % Math.pow(10, TOTP_DIGITS);
  return String(otp).padStart(TOTP_DIGITS, '0');
}

/**
 * Get the current time step for TOTP validation.
 */
function getCurrentTimeStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Validate a TOTP token against a secret with window tolerance.
 */
function validateTOTP(secret: Buffer, token: string): boolean {
  const currentStep = getCurrentTimeStep();

  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const expected = generateTOTPToken(secret, currentStep + i);
    const expectedBuf = Buffer.from(expected, 'utf-8');
    const tokenBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length === tokenBuf.length && timingSafeEqual(expectedBuf, tokenBuf)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a random TOTP secret.
 */
function generateSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/**
 * Encode a Buffer to Base32 (RFC 4648) for use in otpauth:// URIs.
 */
function encodeBase32(buffer: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }

  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    if (chunk.length < 5) {
      // Pad the last chunk
      result += alphabet[parseInt(chunk.padEnd(5, '0'), 2)] as string;
    } else {
      result += alphabet[parseInt(chunk, 2)] as string;
    }
  }

  return result;
}

/**
 * Build an otpauth:// URI for authenticator apps.
 */
function buildOtpauthUri(secret: Buffer, issuer: string, account: string): string {
  const base32Secret = encodeBase32(secret);
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(account);

  return (
    `otpauth://totp/${encodedIssuer}:${encodedAccount}` +
    `?secret=${base32Secret}` +
    `&issuer=${encodedIssuer}` +
    `&algorithm=${TOTP_ALGORITHM}` +
    `&digits=${String(TOTP_DIGITS)}` +
    `&period=${String(TOTP_PERIOD_SECONDS)}`
  );
}

/**
 * Generate backup codes (hex strings).
 */
function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    codes.push(randomBytes(BACKUP_CODE_BYTES).toString('hex'));
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

interface TOTPConfigRow {
  secret_hex: string;
  enabled: number;
  backup_codes_json: string;
  created_at: string;
}

async function getTOTPConfig(db: DatabaseClient): Promise<TOTPConfigRow | null> {
  const rows = await db.query<TOTPConfigRow>(
    'meridian',
    'SELECT secret_hex, enabled, backup_codes_json, created_at FROM totp_config WHERE id = 1',
  );
  return rows[0] ?? null;
}

async function savePendingTOTPConfig(
  db: DatabaseClient,
  secretHex: string,
  backupCodesJson: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    `INSERT INTO totp_config (id, secret_hex, enabled, backup_codes_json, created_at, updated_at)
     VALUES (1, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       secret_hex = excluded.secret_hex,
       enabled = 0,
       backup_codes_json = excluded.backup_codes_json,
       updated_at = excluded.updated_at`,
    [secretHex, backupCodesJson, now, now],
  );
}

async function enableTOTP(db: DatabaseClient): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    'UPDATE totp_config SET enabled = 1, updated_at = ? WHERE id = 1',
    [now],
  );
}

async function deleteTOTPConfig(db: DatabaseClient): Promise<void> {
  await db.run('meridian', 'DELETE FROM totp_config WHERE id = 1');
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTOTPRoutes(
  app: FastifyInstance,
  options: TOTPRouteOptions,
): void {
  const { db, logger } = options;

  // -------------------------------------------------------------------------
  // POST /api/auth/totp/setup — Initialize TOTP setup
  // -------------------------------------------------------------------------
  app.post('/api/auth/totp/setup', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            otpauthUri: { type: 'string' },
            secret: { type: 'string' },
            backupCodes: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['otpauthUri', 'secret', 'backupCodes'],
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Check if TOTP is already enabled
    const existing = await getTOTPConfig(db);
    if (existing && existing.enabled === 1) {
      await reply.status(409).send({
        error: 'TOTP is already enabled. Disable it first before re-setup.',
      });
      return;
    }

    // Generate new secret and backup codes
    const secret = generateSecret();
    const backupCodes = generateBackupCodes();

    // Store pending config (enabled = false until verified)
    await savePendingTOTPConfig(
      db,
      secret.toString('hex'),
      JSON.stringify(backupCodes),
    );

    const otpauthUri = buildOtpauthUri(secret, 'Meridian', 'user');
    const base32Secret = encodeBase32(secret);

    // Zero the secret buffer after use
    secret.fill(0);

    logger?.info('TOTP setup initiated', { component: 'bridge' });

    await reply.send({
      otpauthUri,
      secret: base32Secret,
      backupCodes,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/totp/verify — Verify TOTP and enable it
  // -------------------------------------------------------------------------
  app.post<{ Body: VerifyBody }>('/api/auth/totp/verify', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: TOTP_DIGITS, maxLength: TOTP_DIGITS },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (
    request: FastifyRequest<{ Body: VerifyBody }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { token } = request.body;

    // Get pending config
    const config = await getTOTPConfig(db);
    if (!config) {
      await reply.status(400).send({
        error: 'No TOTP setup in progress. Call POST /api/auth/totp/setup first.',
      });
      return;
    }

    if (config.enabled === 1) {
      await reply.status(400).send({
        error: 'TOTP is already enabled.',
      });
      return;
    }

    // Validate the token against the pending secret
    const secret = Buffer.from(config.secret_hex, 'hex');
    const isValid = validateTOTP(secret, token);

    // Zero the secret buffer
    secret.fill(0);

    if (!isValid) {
      logger?.warn('TOTP verification failed — invalid token', { component: 'bridge' });
      await reply.status(400).send({
        error: 'Invalid TOTP token. Check your authenticator app and try again.',
      });
      return;
    }

    // Enable TOTP
    await enableTOTP(db);

    logger?.info('TOTP enabled successfully', { component: 'bridge' });

    await reply.send({ enabled: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/totp/validate — Validate TOTP during login
  // -------------------------------------------------------------------------
  app.post<{ Body: ValidateBody }>('/api/auth/totp/validate', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (
    request: FastifyRequest<{ Body: ValidateBody }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { token } = request.body;

    // Get TOTP config
    const config = await getTOTPConfig(db);
    if (!config || config.enabled !== 1) {
      await reply.status(400).send({
        error: 'TOTP is not enabled.',
      });
      return;
    }

    // First try the TOTP token
    const secret = Buffer.from(config.secret_hex, 'hex');
    const isValid = validateTOTP(secret, token);
    secret.fill(0);

    if (isValid) {
      logger?.info('TOTP validation successful', { component: 'bridge' });
      await reply.send({ valid: true });
      return;
    }

    // Try backup codes if TOTP token didn't match
    const backupCodes = JSON.parse(config.backup_codes_json) as string[];
    const tokenNormalized = token.toLowerCase().trim();
    const backupIndex = backupCodes.findIndex(
      (code) => code.toLowerCase() === tokenNormalized,
    );

    if (backupIndex !== -1) {
      // Consume the backup code (mark as used by removing it)
      backupCodes.splice(backupIndex, 1);
      const now = new Date().toISOString();
      await db.run(
        'meridian',
        'UPDATE totp_config SET backup_codes_json = ?, updated_at = ? WHERE id = 1',
        [JSON.stringify(backupCodes), now],
      );

      logger?.info('TOTP validation via backup code', {
        component: 'bridge',
        remainingBackupCodes: backupCodes.length,
      });

      await reply.send({ valid: true });
      return;
    }

    logger?.warn('TOTP validation failed', { component: 'bridge' });
    await reply.status(401).send({
      error: 'Invalid TOTP token or backup code.',
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/auth/totp — Disable TOTP
  // -------------------------------------------------------------------------
  app.delete<{ Body: DisableBody }>('/api/auth/totp', {
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            disabled: { type: 'boolean' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (
    request: FastifyRequest<{ Body: DisableBody }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { password } = request.body;

    // Verify the current password
    const rows = await db.query<{ password_hash: string }>(
      'meridian',
      'SELECT password_hash FROM auth WHERE id = 1',
    );

    const row = rows[0];
    if (!row) {
      await reply.status(401).send({ error: 'Authentication required' });
      return;
    }

    const passwordValid = await bcrypt.compare(password, row.password_hash);
    if (!passwordValid) {
      await reply.status(401).send({ error: 'Invalid password' });
      return;
    }

    // Check TOTP is actually enabled
    const config = await getTOTPConfig(db);
    if (!config || config.enabled !== 1) {
      await reply.status(400).send({ error: 'TOTP is not currently enabled' });
      return;
    }

    // Delete TOTP config
    await deleteTOTPConfig(db);

    logger?.info('TOTP disabled', { component: 'bridge' });

    await reply.send({ disabled: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/totp/status — Check if TOTP is enabled
  // -------------------------------------------------------------------------
  app.get('/api/auth/totp/status', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const config = await getTOTPConfig(db);
    const enabled = config ? config.enabled === 1 : false;

    await reply.send({ enabled });
  });
}

// ---------------------------------------------------------------------------
// Exported helpers for use in auth.ts integration
// ---------------------------------------------------------------------------

/**
 * Check whether TOTP is enabled for the user.
 */
export async function isTOTPEnabled(db: DatabaseClient): Promise<boolean> {
  const config = await getTOTPConfig(db);
  return config ? config.enabled === 1 : false;
}

/**
 * Validate a TOTP token. Used by the auth login flow.
 */
export async function validateTOTPToken(
  db: DatabaseClient,
  token: string,
): Promise<boolean> {
  const config = await getTOTPConfig(db);
  if (!config || config.enabled !== 1) {
    return false;
  }

  const secret = Buffer.from(config.secret_hex, 'hex');
  const isValid = validateTOTP(secret, token);
  secret.fill(0);

  if (isValid) {
    return true;
  }

  // Check backup codes
  const backupCodes = JSON.parse(config.backup_codes_json) as string[];
  const tokenNormalized = token.toLowerCase().trim();
  const backupIndex = backupCodes.findIndex(
    (code) => code.toLowerCase() === tokenNormalized,
  );

  if (backupIndex !== -1) {
    backupCodes.splice(backupIndex, 1);
    const now = new Date().toISOString();
    await db.run(
      'meridian',
      'UPDATE totp_config SET backup_codes_json = ?, updated_at = ? WHERE id = 1',
      [JSON.stringify(backupCodes), now],
    );
    return true;
  }

  return false;
}

// Export for testing
export { generateTOTPToken, validateTOTP, encodeBase32, buildOtpauthUri, generateBackupCodes };
