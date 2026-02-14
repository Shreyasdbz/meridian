// @meridian/bridge — Fastify server creation (Section 6.5)
// Sets up HTTP server with security headers, CORS, rate limiting,
// credential filtering, and system prompt leakage detection.

import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { join } from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type {
  BridgeConfig,
  DatabaseClient,
  Job,
  JobStatus,
  Logger,
  SecretsVault,
  WSApprovalRequiredMessage,
  WSStatusMessage,
} from '@meridian/shared';
import { API_RATE_LIMIT_PER_MINUTE, redact } from '@meridian/shared';

import type { CostTracker } from '../../shared/cost-tracker.js';

import { AuthService, authRoutes } from './auth.js';
import { authMiddleware, csrfMiddleware } from './middleware.js';
import {
  type AuditLogReader,
  type ComponentHealth,
  type MetricsProvider,
  healthRoutes,
  conversationRoutes,
  messageRoutes,
  jobRoutes,
  gearRoutes,
  configRoutes,
  memoryRoutes,
  auditRoutes,
  secretRoutes,
  metricsRoutes,
  scheduleRoutes,
  costRoutes,
  trustRoutes,
  dataRoutes,
} from './routes/index.js';
import { buildHstsHeader, buildHttpsOptions, shouldAddHsts } from './tls.js';
import { type WebSocketManager, websocketRoutes } from './websocket.js';

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

/**
 * Structural interface for Sentinel Memory (avoids bridge → sentinel import).
 * Compatible with SentinelMemory from @meridian/sentinel.
 */
export interface SentinelMemoryLike {
  listActiveDecisions(): Promise<Array<Record<string, unknown>>>;
  deleteDecision(id: string): Promise<void>;
  pruneExpired(): Promise<number>;
}

export interface CreateServerOptions {
  config: BridgeConfig;
  db: DatabaseClient;
  logger: Logger;
  /** Override rate limit for testing. */
  rateLimitMax?: number;
  /** Disable rate limiting entirely (for tests). */
  disableRateLimit?: boolean;
  /** Audit log instance for audit routes. */
  auditLog?: AuditLogReader;
  /** Secrets vault instance for secrets routes. */
  vault?: SecretsVault;
  /** Metrics provider for /api/metrics endpoint (opt-in). */
  metricsProvider?: MetricsProvider;
  /** Cost tracker for /api/costs endpoints (opt-in). */
  costTracker?: CostTracker;
  /** Sentinel Memory instance for trust decision routes (Phase 10.3). */
  sentinelMemory?: SentinelMemoryLike;
  /** Data directory for right-to-deletion route (Phase 10.6). */
  dataDir?: string;
  /** Application version string (e.g. "0.1.0"). */
  version?: string;
  /** Callback to check if the server has completed full startup. */
  isReady?: () => boolean;
  /** Callback to get component health status (Section 12.3). */
  getComponentStatus?: () => Record<string, ComponentHealth>;
  /** Override max WebSocket connections (defaults to MAX_WS_CONNECTIONS_DESKTOP). */
  maxWsConnections?: number;
}

/**
 * Create and configure the Fastify server with all security features.
 * Does NOT start listening — call server.listen() separately.
 */
export async function createServer(options: CreateServerOptions): Promise<{
  server: FastifyInstance;
  authService: AuthService;
  wsManager: WebSocketManager;
}> {
  const { config, db, logger, rateLimitMax, disableRateLimit, auditLog, vault, metricsProvider, costTracker, sentinelMemory, dataDir, version, isReady, getComponentStatus, maxWsConnections } = options;

  // ----- TLS (Phase 9.7) -----
  const httpsOptions = buildHttpsOptions(config, logger);
  const isTls = !!httpsOptions;

  const server = Fastify({
    logger: false, // We use our own logger
    trustProxy: false,
    ...(httpsOptions ? { https: httpsOptions } : {}),
  }) as FastifyInstance<HttpsServer | HttpServer>;

  // ----- Cookie plugin (for session cookies) -----
  await server.register(cookie);

  // ----- WebSocket plugin (Section 6.5.2) -----
  await server.register(websocket);

  // ----- CORS (Section 6.5.1) — exact origin only, no wildcard -----
  const protocol = isTls ? 'https' : 'http';
  await server.register(cors, {
    origin: `${protocol}://${config.bind}:${config.port}`,
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
    // HSTS header when TLS is active (Phase 9.7)
    if (shouldAddHsts(config)) {
      reply.header('Strict-Transport-Security', buildHstsHeader(config));
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

  // ----- REST API routes (Phase 6.2) -----
  healthRoutes(server, {
    db,
    logger,
    version: version ?? '0.1.0',
    isReady: isReady ?? (() => true),
    getComponentStatus,
  });

  conversationRoutes(server, { db, logger });
  messageRoutes(server, { db, logger });
  jobRoutes(server, { db, logger, authService });
  gearRoutes(server, { db, logger });
  configRoutes(server, { db, logger });
  memoryRoutes(server, { db, logger });
  scheduleRoutes(server, { db, logger });

  if (auditLog) {
    auditRoutes(server, { auditLog, logger });
  }

  if (vault) {
    secretRoutes(server, { vault, logger });
  }

  if (metricsProvider) {
    metricsRoutes(server, { metricsProvider });
  }

  if (costTracker) {
    costRoutes(server, { costTracker, logger });
  }

  if (sentinelMemory) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- structural type bridging (avoids bridge → sentinel import)
    trustRoutes(server, { sentinelMemory: sentinelMemory as any, logger });
  }

  if (dataDir) {
    dataRoutes(server, { db, dataDir, logger });
  }

  // ----- WebSocket routes (Phase 6.3) -----
  const wsManager = websocketRoutes(server, {
    db,
    logger,
    authService,
    maxConnections: maxWsConnections,
  });

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

  return { server, authService, wsManager };
}

// ---------------------------------------------------------------------------
// BridgeServer — integrated server with Axis wiring (Phase 6.4)
// ---------------------------------------------------------------------------

/**
 * Minimal interface describing what Bridge needs from Axis.
 * Defined locally to avoid a bridge → axis module dependency.
 * The real Axis class satisfies this interface.
 */
export interface AxisAdapter {
  createJob(options: {
    conversationId?: string;
    source: 'user' | 'schedule' | 'webhook' | 'sub-job';
    sourceMessageId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Job>;
  getJob(jobId: string): Promise<Job | undefined>;
  cancelJob(jobId: string): Promise<boolean>;
  isReady(): boolean;
  internals: {
    jobQueue: {
      onStatusChange(
        listener: (jobId: string, from: JobStatus, to: JobStatus, job: Job) => void,
      ): void;
      transition(
        jobId: string,
        from: JobStatus,
        to: JobStatus,
        options?: Record<string, unknown>,
      ): Promise<boolean>;
    };
  };
}

export interface BridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly server: FastifyInstance;
  readonly wsManager: WebSocketManager;
  readonly authService: AuthService;
}

/**
 * Create a fully-wired Bridge server connected to an Axis runtime.
 *
 * This is the recommended entry point for production. It:
 * 1. Creates a Fastify server with Axis wired into message and job routes
 * 2. Registers job status change listeners that broadcast via WebSocket
 * 3. Serves static frontend files in production (if dist/ exists)
 * 4. Returns a `BridgeServer` with start/stop lifecycle
 *
 * The existing `createServer()` continues to work without Axis for
 * backward compatibility and standalone testing.
 */
export async function createBridgeServer(
  config: BridgeConfig,
  axis: AxisAdapter,
  options: { db: DatabaseClient; logger: Logger } & Partial<Omit<CreateServerOptions, 'config' | 'db' | 'logger'>>,
): Promise<BridgeServer> {
  const { db, logger } = options;

  // 1. Create the server with Axis wired into routes
  const { server, authService, wsManager } = await createServerWithAxis({
    config,
    db,
    logger,
    axis,
    rateLimitMax: options.rateLimitMax,
    disableRateLimit: options.disableRateLimit,
    auditLog: options.auditLog,
    vault: options.vault,
    metricsProvider: options.metricsProvider,
    costTracker: options.costTracker,
    version: options.version,
    isReady: options.isReady ?? (() => axis.isReady()),
    getComponentStatus: options.getComponentStatus,
    maxWsConnections: options.maxWsConnections,
  });

  // 2. Register job status change listener for WebSocket broadcasts
  axis.internals.jobQueue.onStatusChange((jobId, _from, to, job) => {
    // Broadcast status update for every transition
    const statusMsg: WSStatusMessage = {
      type: 'status',
      jobId,
      status: to,
    };
    wsManager.broadcast(statusMsg);

    // On awaiting_approval, also broadcast approval_required with plan + risks.
    // NOTE: Nonce creation is async, so approval_required may arrive a few ms
    // after the status message. Clients should handle both independently.
    if (to === 'awaiting_approval' && job.plan) {
      const plan = job.plan;
      const risks = job.validation?.stepResults ?? [];
      void authService.createApprovalNonce(jobId).then((nonce) => {
        const approvalMsg: WSApprovalRequiredMessage = {
          type: 'approval_required',
          jobId,
          plan,
          risks,
          metadata: { nonce },
        };
        wsManager.broadcast(approvalMsg);
      }).catch((error: unknown) => {
        logger.error('Failed to create approval nonce for WS broadcast', {
          component: 'bridge',
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  // 3. Static file serving for production SPA (conditional)
  const distDir = join(process.cwd(), 'src', 'bridge', 'ui', 'dist');
  if (existsSync(distDir)) {
    await server.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
    });

    // SPA fallback: serve index.html for non-API routes
    server.setNotFoundHandler(async (request, reply) => {
      if (!request.url.startsWith('/api/')) {
        return reply.sendFile('index.html', distDir);
      }
      await reply.status(404).send({ error: 'Not found' });
    });
  }

  // 4. Return BridgeServer with lifecycle
  return {
    server,
    wsManager,
    authService,

    async start(): Promise<void> {
      await server.listen({ port: config.port, host: config.bind });
      const tlsEnabled = !!config.tls?.enabled;
      logger.info('Bridge server started', {
        component: 'bridge',
        bind: config.bind,
        port: config.port,
        tls: tlsEnabled,
      });
    },

    async stop(): Promise<void> {
      wsManager.close();
      await server.close();
      logger.info('Bridge server stopped', { component: 'bridge' });
    },
  };
}

/**
 * Internal: create a server with Axis wired into message and job routes.
 * Same as createServer but passes axis to route registrations.
 */
async function createServerWithAxis(options: CreateServerOptions & { axis: AxisAdapter }): Promise<{
  server: FastifyInstance;
  authService: AuthService;
  wsManager: WebSocketManager;
}> {
  const {
    config, db, logger, axis,
    rateLimitMax, disableRateLimit, auditLog, vault, metricsProvider, costTracker,
    version, isReady, getComponentStatus, maxWsConnections,
  } = options;

  // ----- TLS (Phase 9.7) -----
  const httpsOptions = buildHttpsOptions(config, logger);
  const isTls = !!httpsOptions;

  const server = Fastify({
    logger: false,
    trustProxy: false,
    ...(httpsOptions ? { https: httpsOptions } : {}),
  }) as FastifyInstance<HttpsServer | HttpServer>;

  // ----- Plugins -----
  await server.register(cookie);
  await server.register(websocket);
  const protocol = isTls ? 'https' : 'http';
  await server.register(cors, {
    origin: `${protocol}://${config.bind}:${config.port}`,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  if (!disableRateLimit) {
    await server.register(rateLimit, {
      max: rateLimitMax ?? API_RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
    });
  }

  // ----- Security headers -----
  server.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(header, value);
    }
    // HSTS header when TLS is active (Phase 9.7)
    if (shouldAddHsts(config)) {
      reply.header('Strict-Transport-Security', buildHstsHeader(config));
    }
  });

  // ----- Credential filtering -----
  server.addHook(
    'onSend',
    async (_request: FastifyRequest, _reply: FastifyReply, payload: unknown): Promise<unknown> => {
      if (typeof payload !== 'string') return payload;
      if (containsCredentials(payload)) {
        logger.warn('Credential pattern detected in response, redacting', {
          component: 'bridge',
        });
        return filterCredentials(payload);
      }
      return payload;
    },
  );

  // ----- System prompt leakage detection -----
  server.addHook(
    'onSend',
    async (_request: FastifyRequest, _reply: FastifyReply, payload: unknown): Promise<unknown> => {
      if (typeof payload !== 'string') return payload;
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

  // ----- Auth -----
  const authService = new AuthService({ db, config, logger });
  await server.register(authMiddleware, { authService });
  await server.register(csrfMiddleware, { authService });
  authRoutes(server, authService);

  // ----- Routes (with Axis wired in) -----
  healthRoutes(server, {
    db,
    logger,
    version: version ?? '0.1.0',
    isReady: isReady ?? (() => true),
    getComponentStatus,
  });
  conversationRoutes(server, { db, logger });
  messageRoutes(server, { db, logger, axis });
  jobRoutes(server, { db, logger, authService, axis });
  gearRoutes(server, { db, logger });
  configRoutes(server, { db, logger });
  memoryRoutes(server, { db, logger });
  scheduleRoutes(server, { db, logger });

  if (auditLog) {
    auditRoutes(server, { auditLog, logger });
  }
  if (vault) {
    secretRoutes(server, { vault, logger });
  }
  if (metricsProvider) {
    metricsRoutes(server, { metricsProvider });
  }
  if (costTracker) {
    costRoutes(server, { costTracker, logger });
  }

  // ----- WebSocket -----
  const wsManager = websocketRoutes(server, {
    db,
    logger,
    authService,
    maxConnections: maxWsConnections,
  });

  // ----- Error handler -----
  server.setErrorHandler(
    async (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = 'statusCode' in error
        ? (error as { statusCode: number }).statusCode
        : undefined;

      if (statusCode && statusCode >= 400 && statusCode < 500) {
        await reply.status(statusCode).send({
          error: error.message,
          ...(statusCode === 429 ? { retryAfterMs: 60_000 } : {}),
        });
        return;
      }

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

      logger.error('Unhandled error', {
        component: 'bridge',
        error: error.message,
        stack: error.stack,
      });
      await reply.status(500).send({ error: 'Internal server error' });
    },
  );

  return { server, authService, wsManager };
}
