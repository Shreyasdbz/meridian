// @meridian/axis — Message router with middleware chain
// In-process typed function dispatch for inter-component communication.

import type {
  AxisMessage,
  AuditEntry,
  ComponentId,
  RiskLevel,
  SignedEnvelope,
  SigningService,
} from '@meridian/shared';
import {
  generateId,
  MeridianError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  AuthenticationError,
  MAX_MESSAGE_SIZE_BYTES,
  MESSAGE_WARNING_THRESHOLD_BYTES,
} from '@meridian/shared';

import type { ComponentRegistryImpl } from './registry.js';

// ---------------------------------------------------------------------------
// AuditWriter interface
// ---------------------------------------------------------------------------

/**
 * Interface for writing audit log entries.
 * Initially a no-op/in-memory stub; replaced by the real SQLite-backed
 * writer in Phase 2.7.
 */
export interface AuditWriter {
  write(entry: AuditEntry): void;
}

/**
 * No-op audit writer used as the default until the real audit system
 * is wired up.
 */
export class NoOpAuditWriter implements AuditWriter {
  write(_entry: AuditEntry): void {
    // Intentionally empty — stub for Phase 2.1
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware function wrapping message dispatch.
 * Receives the message and a `next` function to continue the chain.
 */
export type Middleware = (
  message: AxisMessage,
  signal: AbortSignal,
  next: (message: AxisMessage, signal: AbortSignal) => Promise<AxisMessage>,
) => Promise<AxisMessage>;

// ---------------------------------------------------------------------------
// Router options
// ---------------------------------------------------------------------------

export interface MessageRouterOptions {
  registry: ComponentRegistryImpl;
  auditWriter?: AuditWriter;
  logger?: RouterLogger;
  /** Signing service for Ed25519 signature verification (v0.2). */
  signingService?: SigningService;
}

/**
 * Minimal logger interface so the router doesn't depend on the full Logger class.
 */
export interface RouterLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Built-in middleware factories
// ---------------------------------------------------------------------------

/**
 * Create audit logging middleware that records every dispatch.
 */
function createAuditMiddleware(auditWriter: AuditWriter): Middleware {
  return async (message, signal, next) => {
    const entry: AuditEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      actor: mapComponentToActor(message.from),
      action: `dispatch:${message.type}`,
      riskLevel: 'low' as RiskLevel,
      target: message.to,
      jobId: message.jobId,
      details: {
        messageId: message.id,
        correlationId: message.correlationId,
        from: message.from,
        to: message.to,
        type: message.type,
      },
    };

    auditWriter.write(entry);

    return next(message, signal);
  };
}

/**
 * Map a ComponentId to an AuditActor type.
 */
function mapComponentToActor(
  componentId: ComponentId,
): 'user' | 'scout' | 'sentinel' | 'axis' | 'gear' {
  if (componentId === 'scout') return 'scout';
  if (componentId === 'sentinel') return 'sentinel';
  if (componentId === 'bridge') return 'user';
  if (componentId === 'journal') return 'axis';
  if (componentId.startsWith('gear:')) return 'gear';
  return 'axis';
}

/**
 * Create error handling middleware that catches and wraps errors.
 */
function createErrorMiddleware(logger?: RouterLogger): Middleware {
  return async (message, signal, next) => {
    try {
      return await next(message, signal);
    } catch (error) {
      const meridianError = error instanceof MeridianError
        ? error
        : new MeridianError(
          'ERR_DISPATCH',
          error instanceof Error ? error.message : String(error),
          { cause: error instanceof Error ? error : undefined },
        );

      logger?.error('Dispatch failed', {
        messageId: message.id,
        correlationId: message.correlationId,
        from: message.from,
        to: message.to,
        type: message.type,
        errorCode: meridianError.code,
        errorMessage: meridianError.message,
      });

      const errorResponse: AxisMessage = {
        id: generateId(),
        correlationId: message.correlationId,
        timestamp: new Date().toISOString(),
        from: message.to,
        to: message.from,
        type: 'error',
        payload: {
          code: meridianError.code,
          message: meridianError.message,
          originalMessageId: message.id,
        },
        replyTo: message.id,
        jobId: message.jobId,
      };

      return errorResponse;
    }
  };
}

/**
 * Create latency tracking middleware that logs slow dispatches.
 */
function createLatencyMiddleware(logger?: RouterLogger): Middleware {
  return async (message, signal, next) => {
    const start = performance.now();
    const response = await next(message, signal);
    const durationMs = performance.now() - start;

    if (durationMs > 1000) {
      logger?.warn('Slow dispatch detected', {
        messageId: message.id,
        correlationId: message.correlationId,
        from: message.from,
        to: message.to,
        type: message.type,
        durationMs: Math.round(durationMs),
      });
    } else {
      logger?.debug('Dispatch completed', {
        messageId: message.id,
        correlationId: message.correlationId,
        type: message.type,
        durationMs: Math.round(durationMs),
      });
    }

    return response;
  };
}

/**
 * Create message size validation middleware.
 * Rejects messages > 1 MB, warns for messages > 100 KB.
 */
function createSizeValidationMiddleware(logger?: RouterLogger): Middleware {
  return async (message, signal, next) => {
    const serialized = JSON.stringify(message);
    const sizeBytes = Buffer.byteLength(serialized, 'utf-8');

    if (sizeBytes > MAX_MESSAGE_SIZE_BYTES) {
      throw new ValidationError(
        `Message size ${sizeBytes} bytes exceeds maximum ${MAX_MESSAGE_SIZE_BYTES} bytes`,
      );
    }

    if (sizeBytes > MESSAGE_WARNING_THRESHOLD_BYTES) {
      logger?.warn('Large message detected', {
        messageId: message.id,
        correlationId: message.correlationId,
        type: message.type,
        sizeBytes,
        threshold: MESSAGE_WARNING_THRESHOLD_BYTES,
      });
    }

    return next(message, signal);
  };
}

/**
 * Create signature verification middleware (v0.2, Section 6.3).
 * Verifies Ed25519 signatures on all messages using the SigningService.
 * Messages must carry a `_signedEnvelope` in their metadata.
 */
function createSignatureVerificationMiddleware(
  signingService: SigningService,
  logger?: RouterLogger,
): Middleware {
  return async (message, signal, next) => {
    const envelope = message.metadata?.['_signedEnvelope'] as SignedEnvelope | undefined;

    if (!envelope) {
      // Messages without an envelope are rejected when signing is enabled
      throw new AuthenticationError(
        `Message from '${message.from}' is missing signature envelope`,
      );
    }

    // Verify that the envelope signer matches the message sender
    if (envelope.signer !== message.from) {
      throw new AuthenticationError(
        `Signature signer '${envelope.signer}' does not match message sender '${message.from}'`,
      );
    }

    // Verify signature and replay protection
    const result = signingService.verify(envelope);
    if (!result.valid) {
      logger?.warn('Signature verification failed', {
        messageId: message.id,
        from: message.from,
        to: message.to,
        reason: result.reason,
      });
      throw new AuthenticationError(
        `Signature verification failed for message from '${message.from}': ${result.reason}`,
      );
    }

    logger?.debug('Signature verified', {
      messageId: message.id,
      from: message.from,
      signer: envelope.signer,
    });

    return next(message, signal);
  };
}

// ---------------------------------------------------------------------------
// MessageRouter
// ---------------------------------------------------------------------------

/**
 * MessageRouter — dispatches messages to registered component handlers
 * through a middleware chain.
 *
 * Middleware execution order (outermost to innermost):
 *   1. Error handling (catches and wraps exceptions)
 *   2. Audit logging (records every dispatch)
 *   3. Latency tracking (logs slow dispatches)
 *   4. Message size validation (rejects > 1 MB, warns > 100 KB)
 *   5. [any custom middleware]
 *   6. Handler invocation
 */
export class MessageRouter {
  private readonly registry: ComponentRegistryImpl;
  private readonly middlewares: Middleware[] = [];

  constructor(options: MessageRouterOptions) {
    this.registry = options.registry;

    const auditWriter = options.auditWriter ?? new NoOpAuditWriter();
    const logger = options.logger;

    // Build the default middleware chain in execution order.
    // Error middleware is outermost so it catches everything.
    this.middlewares.push(createErrorMiddleware(logger));
    this.middlewares.push(createAuditMiddleware(auditWriter));
    this.middlewares.push(createLatencyMiddleware(logger));
    this.middlewares.push(createSizeValidationMiddleware(logger));

    // Ed25519 signature verification (v0.2, Section 6.3).
    // When a signing service is provided, all messages must be signed.
    if (options.signingService) {
      this.middlewares.push(
        createSignatureVerificationMiddleware(options.signingService, logger),
      );
    }
  }

  /**
   * Add a custom middleware to the chain.
   * Custom middleware runs after the built-in middleware and before
   * handler invocation.
   */
  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  /**
   * Dispatch a message to the target component's handler.
   *
   * The message is routed through the middleware chain, then delivered
   * to the registered handler for `message.to`. The handler receives
   * an AbortSignal for timeout enforcement.
   *
   * @throws NotFoundError if no handler is registered for the target component
   *   (wrapped by error middleware into an error AxisMessage response)
   */
  async dispatch(message: AxisMessage): Promise<AxisMessage> {
    const controller = new AbortController();
    const { signal } = controller;

    // If the message has a timeout, enforce it via AbortSignal
    const timeoutMs = (message.metadata?.['timeoutMs'] as number | undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        controller.abort(
          new TimeoutError(
            `Dispatch to '${message.to}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    }

    try {
      // Build the chain: middlewares wrap each other, innermost calls handler
      const chain = this.buildChain();
      return await chain(message, signal);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Build the middleware chain, with handler invocation as the innermost
   * function.
   */
  private buildChain(): (
    message: AxisMessage,
    signal: AbortSignal,
  ) => Promise<AxisMessage> {
    // The innermost function: resolve the handler and call it
    const invoke = async (
      msg: AxisMessage,
      sig: AbortSignal,
    ): Promise<AxisMessage> => {
      const handler = this.registry.getHandler(msg.to);
      if (!handler) {
        throw new NotFoundError(
          `No handler registered for component '${msg.to}'`,
        );
      }
      return handler(msg, sig);
    };

    // Wrap middlewares from right to left so the first middleware in the
    // array is the outermost (executed first).
    let current = invoke;

    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounds checked by loop condition
      const mw = this.middlewares[i]!;
      const nextFn = current;
      current = (msg, sig) => mw(msg, sig, nextFn);
    }

    return current;
  }
}
