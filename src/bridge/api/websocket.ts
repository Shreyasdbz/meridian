// @meridian/bridge — WebSocket server (Section 6.5.2, 9.2, 11.5)
// Real-time event streaming with authenticated WebSocket connections.
// Authentication flow: origin validation → session cookie → one-time token → periodic re-validation.

import { createHash, randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';

import type { DatabaseClient, Logger, WSMessage } from '@meridian/shared';
import {
  generateId,
  MAX_MISSED_PONGS,
  MAX_WS_CONNECTIONS_DESKTOP,
  WS_CONNECTION_TOKEN_BYTES,
  WS_CONNECTION_TOKEN_TTL_MS,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_RATE_LIMIT_PER_MINUTE,
  WS_REVALIDATION_INTERVAL_MS,
} from '@meridian/shared';

import type { AuthService } from './auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tracked state for each WebSocket connection. */
interface TrackedConnection {
  socket: WebSocket;
  sessionId: string;
  sessionToken: string;
  authenticated: boolean;
  missedPongs: number;
  messageCount: number;
  messageWindowStart: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  revalidationTimer: ReturnType<typeof setInterval> | null;
}

export interface WebSocketOptions {
  db: DatabaseClient;
  logger: Logger;
  authService: AuthService;
  maxConnections?: number;
}

export interface WebSocketManager {
  /** Broadcast a message to all authenticated connections. */
  broadcast: (message: WSMessage) => void;
  /** Broadcast a message to connections associated with a specific session. */
  broadcastToSession: (sessionId: string, message: WSMessage) => void;
  /** Get the number of active connections. */
  connectionCount: () => number;
  /** Clean up all connections and timers. */
  close: () => void;
}

// ---------------------------------------------------------------------------
// Connection token management
// ---------------------------------------------------------------------------

async function createConnectionToken(
  db: DatabaseClient,
  sessionId: string,
): Promise<string> {
  const id = generateId();
  const token = randomHex(WS_CONNECTION_TOKEN_BYTES);
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();

  await db.run(
    'meridian',
    `INSERT INTO ws_connection_tokens (id, session_id, token_hash, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, sessionId, tokenHash, now],
  );

  return token;
}

async function validateAndConsumeToken(
  db: DatabaseClient,
  token: string,
  sessionId: string,
): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();

  // Check token exists, belongs to this session, is unconsumed, and not expired
  const cutoff = new Date(Date.now() - WS_CONNECTION_TOKEN_TTL_MS).toISOString();

  const result = await db.run(
    'meridian',
    `UPDATE ws_connection_tokens
     SET consumed_at = ?
     WHERE token_hash = ? AND session_id = ? AND consumed_at IS NULL AND created_at > ?`,
    [now, tokenHash, sessionId, cutoff],
  );

  return result.changes > 0;
}

async function cleanExpiredTokens(db: DatabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - WS_CONNECTION_TOKEN_TTL_MS).toISOString();

  await db.run(
    'meridian',
    'DELETE FROM ws_connection_tokens WHERE consumed_at IS NOT NULL OR created_at < ?',
    [cutoff],
  );
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function checkRateLimit(conn: TrackedConnection): boolean {
  const now = Date.now();

  // Reset window if more than 60 seconds have passed
  if (now - conn.messageWindowStart >= 60_000) {
    conn.messageCount = 0;
    conn.messageWindowStart = now;
  }

  conn.messageCount++;
  return conn.messageCount <= WS_RATE_LIMIT_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Ping/pong lifecycle
// ---------------------------------------------------------------------------

function startPingPong(
  conn: TrackedConnection,
  logger: Logger,
  removeConnection: (conn: TrackedConnection, code: number, reason: string) => void,
): void {
  conn.pingTimer = setInterval(() => {
    if (conn.socket.readyState !== 1 /* OPEN */) {
      return;
    }

    // Send application-level ping
    const pingMsg: WSMessage = { type: 'ping' };
    conn.socket.send(JSON.stringify(pingMsg));

    // Clear any stale pong timer before starting a new one
    if (conn.pongTimer) {
      clearTimeout(conn.pongTimer);
    }
    conn.pongTimer = setTimeout(() => {
      conn.missedPongs++;
      logger.debug('Missed pong', {
        component: 'bridge',
        sessionId: conn.sessionId,
        missedPongs: conn.missedPongs,
      });

      if (conn.missedPongs >= MAX_MISSED_PONGS) {
        logger.warn('Connection terminated: too many missed pongs', {
          component: 'bridge',
          sessionId: conn.sessionId,
        });
        removeConnection(conn, 4002, 'Pong timeout');
      }
    }, WS_PONG_TIMEOUT_MS);
  }, WS_PING_INTERVAL_MS);
}

function handlePong(conn: TrackedConnection): void {
  conn.missedPongs = 0;
  if (conn.pongTimer) {
    clearTimeout(conn.pongTimer);
    conn.pongTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Session re-validation
// ---------------------------------------------------------------------------

function startRevalidation(
  conn: TrackedConnection,
  authService: AuthService,
  logger: Logger,
  removeConnection: (conn: TrackedConnection, code: number, reason: string) => void,
): void {
  conn.revalidationTimer = setInterval(() => {
    void (async () => {
      try {
        const session = await authService.validateSession(conn.sessionToken);
        if (!session) {
          logger.info('WebSocket session expired during re-validation', {
            component: 'bridge',
            sessionId: conn.sessionId,
          });
          removeConnection(conn, 4001, 'Session Expired');
        }
      } catch (error) {
        logger.error('Session re-validation error', {
          component: 'bridge',
          sessionId: conn.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, WS_REVALIDATION_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// WebSocket route registration
// ---------------------------------------------------------------------------

export function websocketRoutes(
  server: FastifyInstance,
  options: WebSocketOptions,
): WebSocketManager {
  const { db, logger, authService, maxConnections = MAX_WS_CONNECTIONS_DESKTOP } = options;
  const connections = new Set<TrackedConnection>();

  // ----- Helper: close and clean up a connection -----
  function removeConnection(
    conn: TrackedConnection,
    code: number,
    reason: string,
  ): void {
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
    if (conn.pongTimer) {
      clearTimeout(conn.pongTimer);
      conn.pongTimer = null;
    }
    if (conn.revalidationTimer) {
      clearInterval(conn.revalidationTimer);
      conn.revalidationTimer = null;
    }
    connections.delete(conn);

    if (conn.socket.readyState === 1 /* OPEN */ || conn.socket.readyState === 0 /* CONNECTING */) {
      conn.socket.close(code, reason);
    }

    logger.debug('WebSocket connection removed', {
      component: 'bridge',
      sessionId: conn.sessionId,
      code,
      reason,
      remainingConnections: connections.size,
    });
  }

  // ----- POST /api/ws/token — Issue a one-time connection token -----
  server.post('/api/ws/token', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth) {
      await reply.status(401).send({ error: 'Authentication required' });
      return;
    }

    // Clean up expired tokens periodically
    await cleanExpiredTokens(db);

    const token = await createConnectionToken(db, auth.sessionId);
    await reply.send({ token });
  });

  // ----- WS /api/ws — WebSocket endpoint -----
  server.get('/api/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    // Step 1: Origin validation (already handled via CORS on HTTP upgrade)
    // Step 2: Session validation (already handled via auth middleware on upgrade)

    const auth = request.auth;
    if (!auth) {
      socket.close(4003, 'Authentication required');
      return;
    }

    // Enforce connection limit
    if (connections.size >= maxConnections) {
      logger.warn('WebSocket connection limit reached', {
        component: 'bridge',
        maxConnections,
        currentConnections: connections.size,
      });
      socket.close(4004, 'Connection limit reached');
      return;
    }

    // Extract session token for re-validation
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    let sessionToken = cookies?.['meridian_session'] ?? '';
    if (!sessionToken) {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        sessionToken = authHeader.slice(7);
      }
    }

    const conn: TrackedConnection = {
      socket,
      sessionId: auth.sessionId,
      sessionToken,
      authenticated: false,
      missedPongs: 0,
      messageCount: 0,
      messageWindowStart: Date.now(),
      pingTimer: null,
      pongTimer: null,
      revalidationTimer: null,
    };

    connections.add(conn);

    logger.debug('WebSocket connection opened, awaiting token', {
      component: 'bridge',
      sessionId: auth.sessionId,
      totalConnections: connections.size,
    });

    // Step 3: Wait for one-time connection token as first message
    // Set a timeout for token delivery
    const tokenTimeout = setTimeout(() => {
      if (!conn.authenticated) {
        logger.warn('WebSocket token timeout', {
          component: 'bridge',
          sessionId: conn.sessionId,
        });
        removeConnection(conn, 4003, 'Token timeout');
      }
    }, WS_CONNECTION_TOKEN_TTL_MS);

    socket.on('message', (data: Buffer | string) => {
      void (async () => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');

        // Rate limit check before parsing (prevents invalid-JSON flood bypass)
        if (conn.authenticated && !checkRateLimit(conn)) {
          logger.debug('WebSocket rate limit exceeded', {
            component: 'bridge',
            sessionId: conn.sessionId,
          });
          const errMsg: WSMessage = {
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded',
          };
          socket.send(JSON.stringify(errMsg));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          if (conn.authenticated) {
            const errMsg: WSMessage = {
              type: 'error',
              code: 'INVALID_JSON',
              message: 'Invalid JSON message',
            };
            socket.send(JSON.stringify(errMsg));
          }
          return;
        }

        const msg = parsed as Record<string, unknown>;

        // --- Token authentication (first message) ---
        if (!conn.authenticated) {
          if (typeof msg['token'] !== 'string') {
            removeConnection(conn, 4003, 'Invalid token format');
            return;
          }

          const valid = await validateAndConsumeToken(
            db,
            msg['token'],
            conn.sessionId,
          );

          if (!valid) {
            logger.warn('WebSocket invalid connection token', {
              component: 'bridge',
              sessionId: conn.sessionId,
            });
            removeConnection(conn, 4003, 'Invalid or expired token');
            return;
          }

          clearTimeout(tokenTimeout);
          conn.authenticated = true;

          // Send connected message
          const connectedMsg: WSMessage = {
            type: 'connected',
            sessionId: conn.sessionId,
          };
          socket.send(JSON.stringify(connectedMsg));

          // Start ping/pong heartbeat
          startPingPong(conn, logger, removeConnection);

          // Start periodic session re-validation
          startRevalidation(conn, authService, logger, removeConnection);

          logger.info('WebSocket connection authenticated', {
            component: 'bridge',
            sessionId: conn.sessionId,
          });
          return;
        }

        // --- Authenticated message handling ---

        // Handle pong responses
        if (msg['type'] === 'pong') {
          handlePong(conn);
          return;
        }

        // Handle ping from client (respond with pong)
        if (msg['type'] === 'ping') {
          const pongMsg: WSMessage = { type: 'pong' };
          socket.send(JSON.stringify(pongMsg));
          return;
        }

        // Other client messages are not expected in v0.1 —
        // the WebSocket is primarily server-to-client.
        // Future: client can send messages here for real-time interaction.
      } catch (error) {
        logger.error('WebSocket message handling error', {
          component: 'bridge',
          sessionId: conn.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      })();
    });

    socket.on('close', () => {
      clearTimeout(tokenTimeout);
      removeConnection(conn, 1000, 'Client closed');
    });

    socket.on('error', (error: Error) => {
      logger.error('WebSocket error', {
        component: 'bridge',
        sessionId: conn.sessionId,
        error: error.message,
      });
      clearTimeout(tokenTimeout);
      removeConnection(conn, 1011, 'Internal error');
    });
  });

  // ----- Manager API -----
  const manager: WebSocketManager = {
    broadcast(message: WSMessage): void {
      const payload = JSON.stringify(message);
      // Deduplicate per session — only send to the first active connection
      // for each session to prevent duplicate message delivery when a client
      // has multiple WebSocket connections (e.g., reconnect overlap).
      const sentSessions = new Set<string>();
      for (const conn of connections) {
        if (
          conn.authenticated &&
          conn.socket.readyState === 1 /* OPEN */ &&
          !sentSessions.has(conn.sessionId)
        ) {
          sentSessions.add(conn.sessionId);
          try {
            conn.socket.send(payload);
          } catch {
            // Socket is likely broken; will be cleaned up by 'close' or 'error' event
          }
        }
      }
    },

    broadcastToSession(sessionId: string, message: WSMessage): void {
      const payload = JSON.stringify(message);
      // Send to only the first active connection for the session
      for (const conn of connections) {
        if (
          conn.authenticated &&
          conn.sessionId === sessionId &&
          conn.socket.readyState === 1 /* OPEN */
        ) {
          try {
            conn.socket.send(payload);
          } catch {
            // Socket is likely broken; will be cleaned up by 'close' or 'error' event
          }
          break; // Only send to one connection per session
        }
      }
    },

    connectionCount(): number {
      return connections.size;
    },

    close(): void {
      for (const conn of connections) {
        removeConnection(conn, 1001, 'Server shutting down');
      }
      connections.clear();
    },
  };

  return manager;
}
