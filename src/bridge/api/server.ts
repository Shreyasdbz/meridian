// @meridian/bridge — Fastify server creation (Section 6.5)
// Sets up HTTP server with security headers, CORS, rate limiting,
// credential filtering, and system prompt leakage detection.

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { BridgeConfig, DatabaseClient, Logger } from '@meridian/shared';
import { API_RATE_LIMIT_PER_MINUTE, redact } from '@meridian/shared';

import { AuthService, authRoutes } from './auth.js';
import { authMiddleware, csrfMiddleware } from './middleware.js';

// ---------------------------------------------------------------------------
// Security headers (Section 6.5.1)
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self' ws://localhost:* wss://localhost:*; " +
    "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// ---------------------------------------------------------------------------
// Credential filtering patterns (Section 6.2 LLM02)
// ---------------------------------------------------------------------------

/** Patterns that indicate credential leakage in response bodies. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic API keys
  /sk-[A-Za-z0-9_-]{20,}/,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/,
  // GitHub tokens
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  // Generic API key patterns
  /api[_-]?key[=:]\s*[A-Za-z0-9_\-/+=]{16,}/i,
  // Bearer tokens in content
  /Bearer\s+[A-Za-z0-9._\-/+=]{20,}/,
  // Password assignments
  /password[=:]\s*\S{8,}/i,
];

/**
 * Check if a string contains potential credential patterns.
 * Returns true if credentials detected.
 */
export function containsCredentials(text: string): boolean {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Redact any credential patterns found in text.
 * Uses the shared redact() function for consistent redaction.
 */
export function filterCredentials(text: string): string {
  return redact(text);
}

// ---------------------------------------------------------------------------
// System prompt leakage detection (Section 6.2 LLM07)
// ---------------------------------------------------------------------------

/** Markers that indicate system prompt leakage. */
const SYSTEM_PROMPT_MARKERS = [
  'You are Meridian',
  'You are an AI assistant named Meridian',
  'SYSTEM INSTRUCTIONS:',
  '<<SYS>>',
  '[INST]',
  'As a helpful assistant, your instructions are',
];

/**
 * Check if text contains fragments that resemble system prompt leakage.
 * Returns the detected marker if found, undefined otherwise.
 */
export function detectSystemPromptLeakage(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      return marker;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export interface CreateServerOptions {
  config: BridgeConfig;
  db: DatabaseClient;
  logger: Logger;
  /** Override rate limit for testing. */
  rateLimitMax?: number;
  /** Disable rate limiting entirely (for tests). */
  disableRateLimit?: boolean;
}

/**
 * Create and configure the Fastify server with all security features.
 * Does NOT start listening — call server.listen() separately.
 */
export async function createServer(options: CreateServerOptions): Promise<{
  server: FastifyInstance;
  authService: AuthService;
}> {
  const { config, db, logger, rateLimitMax, disableRateLimit } = options;

  const server = Fastify({
    logger: false, // We use our own logger
    trustProxy: false,
  });

  // ----- Cookie plugin (for session cookies) -----
  await server.register(cookie);

  // ----- CORS (Section 6.5.1) — exact origin only, no wildcard -----
  await server.register(cors, {
    origin: `http://${config.bind}:${config.port}`,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  // ----- Rate limiting (Section 9.2) -----
  if (!disableRateLimit) {
    await server.register(rateLimit, {
      max: rateLimitMax ?? API_RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
    });
  }

  // ----- Security headers on all responses (Section 6.5.1) -----
  server.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(header, value);
    }
  });

  // ----- Response credential filtering (Section 6.2 LLM02) -----
  server.addHook(
    'onSend',
    async (
      _request: FastifyRequest,
      _reply: FastifyReply,
      payload: unknown,
    ): Promise<unknown> => {
      if (typeof payload !== 'string') {
        return payload;
      }

      // Check for credential patterns in response body
      if (containsCredentials(payload)) {
        logger.warn('Credential pattern detected in response, redacting', {
          component: 'bridge',
        });
        return filterCredentials(payload);
      }

      return payload;
    },
  );

  // ----- System prompt leakage detection (Section 6.2 LLM07) -----
  server.addHook(
    'onSend',
    async (
      _request: FastifyRequest,
      _reply: FastifyReply,
      payload: unknown,
    ): Promise<unknown> => {
      if (typeof payload !== 'string') {
        return payload;
      }

      const marker = detectSystemPromptLeakage(payload);
      if (marker) {
        logger.warn('Possible system prompt leakage detected', {
          component: 'bridge',
          marker,
        });
      }

      return payload;
    },
  );

  // ----- Auth service & middleware -----
  const authService = new AuthService({ db, config, logger });

  await server.register(authMiddleware, { authService });
  await server.register(csrfMiddleware, { authService });

  // ----- Auth routes -----
  authRoutes(server, authService);

  // ----- Error handler -----
  server.setErrorHandler(
    async (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = 'statusCode' in error
        ? (error as { statusCode: number }).statusCode
        : undefined;

      // Fastify built-in errors (validation, rate-limit, etc.) — pass through
      if (statusCode && statusCode >= 400 && statusCode < 500) {
        await reply.status(statusCode).send({
          error: error.message,
          ...(statusCode === 429 ? { retryAfterMs: 60_000 } : {}),
        });
        return;
      }

      // Known Meridian errors
      if ('code' in error) {
        const meridianError = error as Error & { code: string };
        const statusMap: Record<string, number> = {
          ERR_AUTH: 401,
          ERR_AUTHZ: 403,
          ERR_NOT_FOUND: 404,
          ERR_CONFLICT: 409,
          ERR_VALIDATION: 400,
          ERR_RATE_LIMIT: 429,
        };
        const status = statusMap[meridianError.code] ?? 500;
        await reply.status(status).send({
          error: meridianError.message,
          code: meridianError.code,
        });
        return;
      }

      // Unknown errors — don't leak internals
      logger.error('Unhandled error', {
        component: 'bridge',
        error: error.message,
        stack: error.stack,
      });
      await reply.status(500).send({ error: 'Internal server error' });
    },
  );

  return { server, authService };
}
