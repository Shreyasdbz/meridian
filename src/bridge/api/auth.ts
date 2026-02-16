// @meridian/bridge — Authentication service & routes (Section 6.3)
// Handles password management, session lifecycle, CSRF protection,
// brute-force prevention, per-job approval nonces, and TOTP integration.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcrypt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type {
  BridgeConfig,
  BruteForceStatus,
  DatabaseClient,
  Logger,
  LoginResult,
  Session,
} from '@meridian/shared';
import { detectDeploymentTier, SecretsVault } from '@meridian/shared';
import {
  APPROVAL_NONCE_BYTES,
  APPROVAL_NONCE_TTL_HOURS,
  AuthenticationError,
  BCRYPT_SALT_ROUNDS,
  BRUTE_FORCE_LOCKOUT,
  BRUTE_FORCE_LOCKOUT_DURATION_MINUTES,
  BRUTE_FORCE_THRESHOLD,
  CSRF_TOKEN_BYTES,
  SESSION_TOKEN_BYTES,
  generateId,
} from '@meridian/shared';

import { isTOTPEnabled, validateTOTPToken } from './routes/totp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash of a session token for storage. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generate a cryptographically random hex string. */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

export interface AuthServiceOptions {
  db: DatabaseClient;
  config: BridgeConfig;
  logger: Logger;
  vault?: SecretsVault;
}

export class AuthService {
  private readonly db: DatabaseClient;
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private readonly vault?: SecretsVault;

  constructor(options: AuthServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.vault = options.vault;
  }

  /** Access the database client (used by TOTP integration). */
  getDb(): DatabaseClient {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------

  /** Check if the initial password has been set. */
  async isSetupComplete(): Promise<boolean> {
    const rows = await this.db.query<{ id: number }>(
      'meridian',
      'SELECT id FROM auth WHERE id = 1',
    );
    return rows.length > 0;
  }

  /** Create the initial password during onboarding. */
  async setupPassword(password: string): Promise<void> {
    const existing = await this.isSetupComplete();
    if (existing) {
      throw new AuthenticationError('Password already configured');
    }

    if (password.length < 8) {
      throw new AuthenticationError('Password must be at least 8 characters');
    }

    const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const now = new Date().toISOString();

    await this.db.run(
      'meridian',
      'INSERT INTO auth (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)',
      [hash, now, now],
    );

    // Initialize or unlock the secrets vault with the same password
    if (this.vault && !this.vault.isUnlocked) {
      try {
        const tier = detectDeploymentTier();
        const vaultTier = tier === 'pi' ? 'low-power' : 'standard';
        await this.vault.initialize(password, vaultTier);
        this.logger.info('Secrets vault initialized');
      } catch {
        // Vault file already exists (e.g. auth reset without vault reset).
        // Try unlocking — if the password matches the old vault, reuse it.
        try {
          await this.vault.unlock(password);
          this.logger.info('Secrets vault unlocked (existing vault)');
        } catch {
          // Old vault has a different password — reset it.
          await this.vault.reset();
          const tier = detectDeploymentTier();
          const vaultTier = tier === 'pi' ? 'low-power' : 'standard';
          await this.vault.initialize(password, vaultTier);
          this.logger.warn('Secrets vault reset and re-initialized (password mismatch)');
        }
      }
    }

    this.logger.info('Initial password configured');
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /** Attempt to log in with a password. */
  async login(
    password: string,
    ip: string,
    userAgent?: string,
  ): Promise<LoginResult> {
    // Check brute-force protection first
    const bruteForce = await this.checkBruteForce(ip);
    if (!bruteForce.allowed) {
      await this.recordLoginAttempt(ip, false);
      return {
        success: false,
        error: bruteForce.lockedOut
          ? 'Account locked due to too many failed attempts'
          : 'Too many failed attempts, please wait',
        retryAfterMs: bruteForce.retryAfterMs,
      };
    }

    // Verify password
    const rows = await this.db.query<{ password_hash: string }>(
      'meridian',
      'SELECT password_hash FROM auth WHERE id = 1',
    );

    if (rows.length === 0) {
      return { success: false, error: 'Setup not complete' };
    }

    const row = rows[0];
    if (!row) {
      return { success: false, error: 'Setup not complete' };
    }
    const valid = await bcrypt.compare(password, row.password_hash);

    await this.recordLoginAttempt(ip, valid);

    if (!valid) {
      const updatedStatus = await this.checkBruteForce(ip);
      return {
        success: false,
        error: 'Invalid password',
        retryAfterMs: updatedStatus.retryAfterMs,
      };
    }

    // Ensure the secrets vault is unlocked (or initialize if it doesn't exist yet)
    if (this.vault && !this.vault.isUnlocked) {
      try {
        await this.vault.unlock(password);
        this.logger.info('Secrets vault unlocked');
      } catch {
        // Vault file doesn't exist or password mismatch — try initialize, then reset.
        try {
          const tier = detectDeploymentTier();
          const vaultTier = tier === 'pi' ? 'low-power' : 'standard';
          await this.vault.initialize(password, vaultTier);
          this.logger.info('Secrets vault initialized on first login');
        } catch {
          // Vault exists but password doesn't match (e.g. auth was reset).
          // Reset vault and re-initialize with current password.
          try {
            await this.vault.reset();
            const tier = detectDeploymentTier();
            const vaultTier = tier === 'pi' ? 'low-power' : 'standard';
            await this.vault.initialize(password, vaultTier);
            this.logger.warn('Secrets vault reset and re-initialized (password mismatch on login)');
          } catch (resetErr: unknown) {
            this.logger.warn('Failed to reset secrets vault', {
              error: resetErr instanceof Error ? resetErr.message : String(resetErr),
            });
          }
        }
      }
    }

    // Create session
    const token = randomHex(SESSION_TOKEN_BYTES);
    const session = await this.createSession(token, ip, userAgent);

    this.logger.info('Login successful', { ip, sessionId: session.id });

    return { success: true, session, token };
  }

  /** Logout by invalidating a session. */
  async logout(sessionId: string): Promise<void> {
    await this.db.run(
      'meridian',
      'DELETE FROM sessions WHERE id = ?',
      [sessionId],
    );
    this.logger.info('Session ended', { sessionId });
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /** Create a new session and store it. */
  async createSession(
    token: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Session> {
    const id = generateId();
    const tokenHash = hashToken(token);
    const csrfToken = randomHex(CSRF_TOKEN_BYTES);
    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + this.config.sessionDurationHours * 60 * 60 * 1000,
    ).toISOString();

    const session: Session = {
      id,
      tokenHash,
      csrfToken,
      createdAt: now,
      expiresAt,
      lastActiveAt: now,
      ipAddress: ip,
      userAgent,
    };

    await this.db.run(
      'meridian',
      `INSERT INTO sessions (id, token_hash, csrf_token, created_at, expires_at, last_active_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.tokenHash,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
        session.lastActiveAt,
        session.ipAddress ?? null,
        session.userAgent ?? null,
      ],
    );

    return session;
  }

  /** Validate a session token. Returns the session if valid, null otherwise. */
  async validateSession(token: string): Promise<Session | null> {
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const rows = await this.db.query<{
      id: string;
      token_hash: string;
      csrf_token: string;
      created_at: string;
      expires_at: string;
      last_active_at: string;
      ip_address: string | null;
      user_agent: string | null;
    }>(
      'meridian',
      'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?',
      [tokenHash, now],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }
    const session: Session = {
      id: row.id,
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastActiveAt: row.last_active_at,
      ipAddress: row.ip_address ?? undefined,
      userAgent: row.user_agent ?? undefined,
    };

    // Update last activity timestamp
    await this.db.run(
      'meridian',
      'UPDATE sessions SET last_active_at = ? WHERE id = ?',
      [now, session.id],
    );

    return session;
  }

  /** Get the CSRF token for a session. */
  async getCsrfToken(sessionId: string): Promise<string | null> {
    const rows = await this.db.query<{ csrf_token: string }>(
      'meridian',
      'SELECT csrf_token FROM sessions WHERE id = ?',
      [sessionId],
    );
    return rows[0]?.csrf_token ?? null;
  }

  /** Remove expired sessions. */
  async cleanExpiredSessions(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      'meridian',
      'DELETE FROM sessions WHERE expires_at <= ?',
      [now],
    );
    if (result.changes > 0) {
      this.logger.info('Cleaned expired sessions', { count: result.changes });
    }
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Brute-force protection (Section 6.3)
  // -------------------------------------------------------------------------

  /** Check whether login is allowed for this IP address. */
  async checkBruteForce(ip: string): Promise<BruteForceStatus> {
    // Count recent failed attempts (within the lockout window)
    const windowStart = new Date(
      Date.now() - BRUTE_FORCE_LOCKOUT_DURATION_MINUTES * 60 * 1000,
    ).toISOString();

    const rows = await this.db.query<{ cnt: number }>(
      'meridian',
      `SELECT COUNT(*) as cnt FROM login_attempts
       WHERE ip_address = ? AND attempted_at > ? AND success = 0`,
      [ip, windowStart],
    );

    const recentFailures = rows[0]?.cnt ?? 0;

    // Full lockout after BRUTE_FORCE_LOCKOUT (20) failures
    if (recentFailures >= BRUTE_FORCE_LOCKOUT) {
      const lastAttemptRows = await this.db.query<{ attempted_at: string }>(
        'meridian',
        `SELECT attempted_at FROM login_attempts
         WHERE ip_address = ? AND success = 0
         ORDER BY attempted_at DESC LIMIT 1`,
        [ip],
      );

      const lastAttempt = lastAttemptRows[0]?.attempted_at;
      const lockoutEnd = lastAttempt
        ? new Date(lastAttempt).getTime() + BRUTE_FORCE_LOCKOUT_DURATION_MINUTES * 60 * 1000
        : 0;
      const retryAfterMs = Math.max(0, lockoutEnd - Date.now());

      return {
        allowed: retryAfterMs <= 0,
        recentFailures,
        retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined,
        lockedOut: retryAfterMs > 0,
      };
    }

    // Exponential backoff after BRUTE_FORCE_THRESHOLD (5) failures
    if (recentFailures >= BRUTE_FORCE_THRESHOLD) {
      const lastAttemptRows = await this.db.query<{ attempted_at: string }>(
        'meridian',
        `SELECT attempted_at FROM login_attempts
         WHERE ip_address = ? AND success = 0
         ORDER BY attempted_at DESC LIMIT 1`,
        [ip],
      );

      const lastAttempt = lastAttemptRows[0]?.attempted_at;
      if (lastAttempt) {
        // Exponential backoff: 2^(failures - threshold) seconds, capped at lockout duration
        const maxBackoffSeconds = BRUTE_FORCE_LOCKOUT_DURATION_MINUTES * 60;
        const backoffSeconds = Math.min(
          Math.pow(2, recentFailures - BRUTE_FORCE_THRESHOLD),
          maxBackoffSeconds,
        );
        const backoffMs = backoffSeconds * 1000;
        const lastAttemptTime = new Date(lastAttempt).getTime();
        const retryAfterMs = Math.max(0, lastAttemptTime + backoffMs - Date.now());

        if (retryAfterMs > 0) {
          return {
            allowed: false,
            recentFailures,
            retryAfterMs,
            lockedOut: false,
          };
        }
      }
    }

    return {
      allowed: true,
      recentFailures,
      lockedOut: false,
    };
  }

  /** Record a login attempt for brute-force tracking. */
  async recordLoginAttempt(ip: string, success: boolean): Promise<void> {
    const id = generateId();
    const now = new Date().toISOString();

    await this.db.run(
      'meridian',
      'INSERT INTO login_attempts (id, ip_address, attempted_at, success) VALUES (?, ?, ?, ?)',
      [id, ip, now, success ? 1 : 0],
    );

    // If successful, clear previous failures for this IP
    if (success) {
      await this.db.run(
        'meridian',
        'DELETE FROM login_attempts WHERE ip_address = ? AND success = 0',
        [ip],
      );
    }
  }

  // -------------------------------------------------------------------------
  // CSRF protection (Section 6.5.4)
  // -------------------------------------------------------------------------

  /** Validate a CSRF token against the session. */
  async validateCsrfToken(sessionId: string, token: string): Promise<boolean> {
    const rows = await this.db.query<{ csrf_token: string }>(
      'meridian',
      'SELECT csrf_token FROM sessions WHERE id = ?',
      [sessionId],
    );

    const row = rows[0];
    if (!row) {
      return false;
    }

    // Constant-time comparison using crypto.timingSafeEqual
    const expected = Buffer.from(row.csrf_token, 'utf-8');
    const provided = Buffer.from(token, 'utf-8');

    if (expected.length !== provided.length) {
      // Perform a dummy comparison to avoid leaking length via timing
      timingSafeEqual(expected, expected);
      return false;
    }

    return timingSafeEqual(expected, provided);
  }

  // -------------------------------------------------------------------------
  // Per-job approval nonces (Section 6.5.4)
  // -------------------------------------------------------------------------

  /** Create a one-time nonce for approving a specific job. */
  async createApprovalNonce(jobId: string): Promise<string> {
    const id = generateId();
    const nonce = randomHex(APPROVAL_NONCE_BYTES);
    const now = new Date().toISOString();

    await this.db.run(
      'meridian',
      'INSERT INTO approval_nonces (id, job_id, nonce, created_at) VALUES (?, ?, ?, ?)',
      [id, jobId, nonce, now],
    );

    return nonce;
  }

  /** Validate and consume an approval nonce. Returns true if valid. */
  async validateApprovalNonce(jobId: string, nonce: string): Promise<boolean> {
    const now = new Date().toISOString();

    // Atomically consume the nonce (set consumed_at if it hasn't been consumed)
    const result = await this.db.run(
      'meridian',
      `UPDATE approval_nonces
       SET consumed_at = ?
       WHERE job_id = ? AND nonce = ? AND consumed_at IS NULL`,
      [now, jobId, nonce],
    );

    return result.changes > 0;
  }

  /** Remove consumed and stale approval nonces older than the configured TTL. */
  async cleanExpiredNonces(): Promise<number> {
    const cutoff = new Date(
      Date.now() - APPROVAL_NONCE_TTL_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const result = await this.db.run(
      'meridian',
      'DELETE FROM approval_nonces WHERE consumed_at IS NOT NULL OR created_at < ?',
      [cutoff],
    );

    if (result.changes > 0) {
      this.logger.info('Cleaned expired approval nonces', { count: result.changes });
    }
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Fastify route registration
// ---------------------------------------------------------------------------

interface SetupBody {
  password: string;
}

interface LoginBody {
  password: string;
  totpToken?: string;
}

/** Register auth routes on a Fastify server. */
export function authRoutes(
  server: FastifyInstance,
  authService: AuthService,
): void {
  // GET /api/auth/status — Check if setup is complete (no auth required)
  server.get('/api/auth/status', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            setupComplete: { type: 'boolean' },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const setupComplete = await authService.isSetupComplete();
    await reply.send({ setupComplete });
  });

  // POST /api/auth/setup — Create initial password (no auth required)
  server.post<{ Body: SetupBody }>('/api/auth/setup', {
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 8 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: SetupBody }>, reply: FastifyReply): Promise<void> => {
    await authService.setupPassword(request.body.password);
    await reply.status(201).send({ message: 'Password configured' });
  });

  // POST /api/auth/login — Login (no auth required)
  server.post<{ Body: LoginBody }>('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string' },
          totpToken: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply): Promise<void> => {
    const ip = request.ip;
    const userAgent = request.headers['user-agent'];

    const result = await authService.login(request.body.password, ip, userAgent);

    if (!result.success) {
      const statusCode = result.retryAfterMs ? 429 : 401;
      await reply.status(statusCode).send({
        error: result.error,
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }

    const session = result.session;
    const token = result.token;
    if (!session || !token) {
      await reply.status(500).send({ error: 'Internal server error' });
      return;
    }

    // Check if TOTP is enabled (Phase 11.3)
    const totpEnabled = await isTOTPEnabled(authService.getDb());
    if (totpEnabled) {
      const { totpToken } = request.body;

      // If no TOTP token provided, signal that TOTP is required
      if (!totpToken) {
        // Clean up the session since we can't complete login yet
        await authService.logout(session.id);
        await reply.send({
          requiresTOTP: true,
        });
        return;
      }

      // Validate the TOTP token
      const totpValid = await validateTOTPToken(
        authService.getDb(),
        totpToken,
      );
      if (!totpValid) {
        // Clean up the session
        await authService.logout(session.id);
        await reply.status(401).send({
          error: 'Invalid TOTP token',
          requiresTOTP: true,
        });
        return;
      }
    }

    // Set session cookie: HTTP-only, Secure, SameSite=Strict (Section 6.3)
    reply.setCookie('meridian_session', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: session.expiresAt
        ? Math.floor(
            (new Date(session.expiresAt).getTime() - Date.now()) / 1000,
          )
        : undefined,
    });

    await reply.send({
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });

  // POST /api/auth/logout — Logout (requires auth)
  server.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (request as FastifyRequest & { auth?: { sessionId: string } }).auth;
    if (!auth) {
      await reply.status(401).send({ error: 'Not authenticated' });
      return;
    }

    await authService.logout(auth.sessionId);

    // Clear the session cookie
    reply.setCookie('meridian_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 0,
    });

    await reply.send({ message: 'Logged out' });
  });

  // GET /api/auth/session — Validate current session (requires auth)
  server.get('/api/auth/session', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (request as FastifyRequest & { auth?: { sessionId: string; csrfToken: string } }).auth;
    if (!auth) {
      await reply.status(401).send({ error: 'Not authenticated' });
      return;
    }

    await reply.send({
      sessionId: auth.sessionId,
      csrfToken: auth.csrfToken,
    });
  });
}
