// @meridian/bridge — Authentication & CSRF middleware (Section 6.3, 6.5.4)
// Provides Fastify hooks for session-based auth, CSRF validation,
// and request context decoration.
// Uses fastify-plugin to avoid encapsulation so hooks apply globally.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

import type { AuthContext } from '@meridian/shared';

import type { AuthService } from './auth.js';

// ---------------------------------------------------------------------------
// Request decoration — attach AuthContext to requests
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

// ---------------------------------------------------------------------------
// Paths that skip authentication
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/health/live',
  '/api/health/ready',
  '/api/health',
]);

/** Check if a path should skip authentication. */
function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

// ---------------------------------------------------------------------------
// Authentication middleware (Section 6.3)
// ---------------------------------------------------------------------------

export interface AuthMiddlewareOptions {
  authService: AuthService;
}

/**
 * Register authentication middleware that validates sessions
 * via cookie or Bearer token on every request.
 * Wrapped with fastify-plugin to escape encapsulation.
 */
export const authMiddleware = fp<AuthMiddlewareOptions>(
  // eslint-disable-next-line @typescript-eslint/require-await -- fp requires async plugin signature
  async (server: FastifyInstance, options: AuthMiddlewareOptions): Promise<void> => {
    const { authService } = options;

    server.decorateRequest('auth', undefined);

    server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      // Skip auth for public endpoints
      const path = request.url.split('?')[0];
      if (path && isPublicPath(path)) {
        return;
      }

      // Extract token from cookie or Authorization header
      let token: string | undefined;

      // 1. Try session cookie
      const cookies = request.cookies as Record<string, string | undefined> | undefined;
      if (cookies?.['meridian_session']) {
        token = cookies['meridian_session'];
      }

      // 2. Fall back to Bearer token
      if (!token) {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          token = authHeader.slice(7);
        }
      }

      if (!token) {
        reply.status(401).send({ error: 'Authentication required' });
        return reply;
      }

      const session = await authService.validateSession(token);
      if (!session) {
        reply.status(401).send({ error: 'Invalid or expired session' });
        return reply;
      }

      // Attach auth context to request
      request.auth = {
        sessionId: session.id,
        csrfToken: session.csrfToken,
      };
    });
  },
  {
    name: 'meridian-auth',
    dependencies: ['@fastify/cookie'],
  },
);

// ---------------------------------------------------------------------------
// CSRF middleware (Section 6.5.4)
// ---------------------------------------------------------------------------

const CSRF_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** Paths that are exempt from CSRF validation (e.g., login sets the token). */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/setup',
]);

export interface CsrfMiddlewareOptions {
  authService: AuthService;
}

/**
 * Register CSRF protection middleware.
 * All state-changing requests (POST, PUT, DELETE, PATCH) must include
 * a valid X-CSRF-Token header matching the session's CSRF token.
 * Wrapped with fastify-plugin to escape encapsulation.
 */
export const csrfMiddleware = fp<CsrfMiddlewareOptions>(
  // eslint-disable-next-line @typescript-eslint/require-await -- fp requires async plugin signature
  async (server: FastifyInstance, options: CsrfMiddlewareOptions): Promise<void> => {
    const { authService } = options;

    server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      // Only check state-changing methods
      if (!CSRF_METHODS.has(request.method)) {
        return;
      }

      const path = request.url.split('?')[0] ?? '';

      // Skip for exempt paths
      if (CSRF_EXEMPT_PATHS.has(path)) {
        return;
      }

      // Skip for public paths (no auth = no CSRF)
      if (isPublicPath(path)) {
        return;
      }

      // Auth must have already been validated
      if (!request.auth) {
        return; // Auth middleware already rejected
      }

      const csrfToken = request.headers['x-csrf-token'] as string | undefined;
      if (!csrfToken) {
        reply.status(403).send({ error: 'CSRF token required' });
        return reply;
      }

      const valid = await authService.validateCsrfToken(request.auth.sessionId, csrfToken);
      if (!valid) {
        reply.status(403).send({ error: 'Invalid CSRF token' });
        return reply;
      }
    });
  },
  {
    name: 'meridian-csrf',
    dependencies: ['meridian-auth'],
  },
);
