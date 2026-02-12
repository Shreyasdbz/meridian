import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AxisMessage, AuditEntry } from '@meridian/shared';
import { generateId, ValidationError } from '@meridian/shared';

import { ComponentRegistry } from './registry.js';
import type { AuditWriter, Middleware, RouterLogger } from './router.js';
import { MessageRouter, NoOpAuditWriter } from './router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessage(overrides?: Partial<AxisMessage>): AxisMessage {
  return {
    id: generateId(),
    correlationId: generateId(),
    timestamp: new Date().toISOString(),
    from: 'bridge',
    to: 'scout',
    type: 'plan.request',
    payload: { content: 'hello' },
    ...overrides,
  };
}

function createEchoHandler() {
  return vi.fn((message: AxisMessage, _signal: AbortSignal): Promise<AxisMessage> =>
    Promise.resolve({
      id: generateId(),
      correlationId: message.correlationId,
      timestamp: new Date().toISOString(),
      from: message.to,
      to: message.from,
      type: 'plan.response',
      payload: { echo: message.payload },
      replyTo: message.id,
      jobId: message.jobId,
    }),
  );
}

function createLogger(): RouterLogger & {
  warns: Array<{ message: string; data?: Record<string, unknown> }>;
  errors: Array<{ message: string; data?: Record<string, unknown> }>;
  debugs: Array<{ message: string; data?: Record<string, unknown> }>;
} {
  const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const errors: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const debugs: Array<{ message: string; data?: Record<string, unknown> }> = [];

  return {
    warns,
    errors,
    debugs,
    warn(message: string, data?: Record<string, unknown>) {
      warns.push({ message, data });
    },
    error(message: string, data?: Record<string, unknown>) {
      errors.push({ message, data });
    },
    debug(message: string, data?: Record<string, unknown>) {
      debugs.push({ message, data });
    },
  };
}

// ---------------------------------------------------------------------------
// ComponentRegistry tests
// ---------------------------------------------------------------------------

describe('ComponentRegistry', () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = new ComponentRegistry();
  });

  it('should register and retrieve a handler', () => {
    const handler = createEchoHandler();
    registry.register('scout', handler);
    expect(registry.getHandler('scout')).toBe(handler);
  });

  it('should return undefined for unregistered components', () => {
    expect(registry.getHandler('scout')).toBeUndefined();
  });

  it('should reject duplicate registrations', () => {
    const handler = createEchoHandler();
    registry.register('scout', handler);
    expect(() => {
      registry.register('scout', handler);
    }).toThrow("Component 'scout' is already registered");
  });

  it('should reject invalid ComponentId format', () => {
    const handler = createEchoHandler();
    expect(() => {
      registry.register('invalid' as never, handler);
    }).toThrow(ValidationError);
  });

  it('should accept gear: prefixed component IDs', () => {
    const handler = createEchoHandler();
    registry.register('gear:web-search', handler);
    expect(registry.getHandler('gear:web-search')).toBe(handler);
  });

  it('should reject gear: IDs with invalid characters', () => {
    const handler = createEchoHandler();
    expect(() => {
      registry.register('gear:Web Search' as never, handler);
    }).toThrow(ValidationError);
  });

  it('should unregister a handler', () => {
    const handler = createEchoHandler();
    registry.register('scout', handler);
    registry.unregister('scout');
    expect(registry.getHandler('scout')).toBeUndefined();
  });

  it('should throw when unregistering a non-existent component', () => {
    expect(() => {
      registry.unregister('scout');
    }).toThrow("Component 'scout' is not registered");
  });

  it('should check if a component is registered via has()', () => {
    registry.register('scout', createEchoHandler());
    expect(registry.has('scout')).toBe(true);
    expect(registry.has('sentinel')).toBe(false);
  });

  it('should list all registered components', () => {
    registry.register('scout', createEchoHandler());
    registry.register('sentinel', createEchoHandler());
    const components = registry.getRegisteredComponents();
    expect(components).toContain('scout');
    expect(components).toContain('sentinel');
    expect(components).toHaveLength(2);
  });

  it('should clear all registrations', () => {
    registry.register('scout', createEchoHandler());
    registry.register('sentinel', createEchoHandler());
    registry.clear();
    expect(registry.getRegisteredComponents()).toHaveLength(0);
  });

  it('should accept all core component IDs', () => {
    const handler = createEchoHandler();
    for (const id of ['bridge', 'scout', 'sentinel', 'journal'] as const) {
      registry.register(id, handler);
    }
    expect(registry.getRegisteredComponents()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// MessageRouter tests — dispatch
// ---------------------------------------------------------------------------

describe('MessageRouter', () => {
  let registry: ComponentRegistry;
  let router: MessageRouter;

  beforeEach(() => {
    registry = new ComponentRegistry();
    router = new MessageRouter({ registry });
  });

  describe('dispatch', () => {
    it('should dispatch message to registered component handler', async () => {
      const handler = createEchoHandler();
      registry.register('scout', handler);

      const message = createMessage({ to: 'scout' });
      const response = await router.dispatch(message);

      expect(handler).toHaveBeenCalledOnce();
      expect(response.correlationId).toBe(message.correlationId);
      expect(response.from).toBe('scout');
      expect(response.to).toBe('bridge');
      expect(response.type).toBe('plan.response');
    });

    it('should return error response for unknown component', async () => {
      const message = createMessage({ to: 'scout' });
      const response = await router.dispatch(message);

      expect(response.type).toBe('error');
      expect(response.correlationId).toBe(message.correlationId);
      const payload = response.payload as Record<string, unknown>;
      expect(payload['code']).toBe('ERR_NOT_FOUND');
    });

    it('should preserve correlationId in responses', async () => {
      const handler = createEchoHandler();
      registry.register('scout', handler);

      const correlationId = generateId();
      const message = createMessage({ to: 'scout', correlationId });
      const response = await router.dispatch(message);

      expect(response.correlationId).toBe(correlationId);
    });

    it('should handle handler errors gracefully via error middleware', async () => {
      registry.register('scout', () =>
        Promise.reject(new Error('Handler exploded')),
      );

      const message = createMessage({ to: 'scout' });
      const response = await router.dispatch(message);

      // Error middleware should catch and wrap
      expect(response.type).toBe('error');
      const payload = response.payload as Record<string, unknown>;
      expect(payload['message']).toBe('Handler exploded');
    });
  });

  // ---------------------------------------------------------------------------
  // Middleware chain
  // ---------------------------------------------------------------------------

  describe('middleware chain', () => {
    it('should execute middleware in order: error -> audit -> latency -> size -> handler', async () => {
      const order: string[] = [];

      const auditWriter: AuditWriter = {
        write(_entry: AuditEntry) {
          order.push('audit');
        },
      };

      const logger: RouterLogger = {
        warn() { /* noop */ },
        error() { /* noop */ },
        debug() { order.push('latency'); },
      };

      const customRouter = new MessageRouter({
        registry,
        auditWriter,
        logger,
      });

      registry.register('scout', (msg, _signal) => {
        order.push('handler');
        return Promise.resolve({
          id: generateId(),
          correlationId: msg.correlationId,
          timestamp: new Date().toISOString(),
          from: msg.to,
          to: msg.from,
          type: 'plan.response' as const,
        });
      });

      const message = createMessage({ to: 'scout' });
      await customRouter.dispatch(message);

      // Audit fires before handler, latency fires after handler returns
      expect(order.indexOf('audit')).toBeLessThan(order.indexOf('handler'));
      expect(order).toContain('handler');
      expect(order).toContain('latency');
    });

    it('should call audit writer for every dispatch', async () => {
      const entries: AuditEntry[] = [];
      const auditWriter: AuditWriter = {
        write(entry: AuditEntry) {
          entries.push(entry);
        },
      };

      const customRouter = new MessageRouter({
        registry,
        auditWriter,
      });

      registry.register('scout', createEchoHandler());

      const message = createMessage({ to: 'scout' });
      await customRouter.dispatch(message);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('dispatch:plan.request');
      expect(entries[0]?.details?.['from']).toBe('bridge');
      expect(entries[0]?.details?.['to']).toBe('scout');
    });

    it('should call audit writer even when dispatch fails', async () => {
      const entries: AuditEntry[] = [];
      const auditWriter: AuditWriter = {
        write(entry: AuditEntry) {
          entries.push(entry);
        },
      };

      const customRouter = new MessageRouter({
        registry,
        auditWriter,
      });

      // No handler registered for 'scout'
      const message = createMessage({ to: 'scout' });
      await customRouter.dispatch(message);

      expect(entries).toHaveLength(1);
    });

    it('should support custom middleware via use()', async () => {
      const customCalled = vi.fn();

      registry.register('scout', createEchoHandler());

      const customMiddleware: Middleware = async (msg, signal, next) => {
        customCalled();
        return next(msg, signal);
      };

      router.use(customMiddleware);

      const message = createMessage({ to: 'scout' });
      await router.dispatch(message);

      expect(customCalled).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // AbortSignal timeout enforcement
  // ---------------------------------------------------------------------------

  describe('AbortSignal timeout', () => {
    it('should pass AbortSignal to handler', async () => {
      let receivedSignal: AbortSignal | undefined;

      registry.register('scout', (msg, signal) => {
        receivedSignal = signal;
        return Promise.resolve({
          id: generateId(),
          correlationId: msg.correlationId,
          timestamp: new Date().toISOString(),
          from: msg.to,
          to: msg.from,
          type: 'plan.response' as const,
        });
      });

      const message = createMessage({ to: 'scout' });
      await router.dispatch(message);

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
    });

    it('should abort signal when timeout expires', async () => {
      vi.useFakeTimers();

      let receivedSignal: AbortSignal | undefined;
      let resolveHandler: (() => void) | undefined;

      registry.register('scout', async (msg, signal) => {
        receivedSignal = signal;
        // Block until manually resolved
        await new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
        return {
          id: generateId(),
          correlationId: msg.correlationId,
          timestamp: new Date().toISOString(),
          from: msg.to,
          to: msg.from,
          type: 'plan.response' as const,
        };
      });

      const message = createMessage({
        to: 'scout',
        metadata: { timeoutMs: 500 },
      });

      // Start dispatch but don't await
      const dispatchPromise = router.dispatch(message);

      // Advance timers past the timeout
      vi.advanceTimersByTime(600);

      // Resolve the handler so the promise completes
      resolveHandler?.();
      await dispatchPromise;

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(true);

      vi.useRealTimers();
    });

    it('should not abort signal when dispatch completes before timeout', async () => {
      let receivedSignal: AbortSignal | undefined;

      registry.register('scout', (msg, signal) => {
        receivedSignal = signal;
        return Promise.resolve({
          id: generateId(),
          correlationId: msg.correlationId,
          timestamp: new Date().toISOString(),
          from: msg.to,
          to: msg.from,
          type: 'plan.response' as const,
        });
      });

      const message = createMessage({
        to: 'scout',
        metadata: { timeoutMs: 5000 },
      });

      await router.dispatch(message);

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Message size validation
  // ---------------------------------------------------------------------------

  describe('message size validation', () => {
    it('should reject messages larger than 1 MB', async () => {
      registry.register('scout', createEchoHandler());
      const logger = createLogger();

      const sizeRouter = new MessageRouter({ registry, logger });

      // Create a message with payload just over 1 MB
      const largePayload = 'x'.repeat(1_100_000);
      const message = createMessage({
        to: 'scout',
        payload: { data: largePayload },
      });

      const response = await sizeRouter.dispatch(message);

      // Error middleware wraps the ValidationError
      expect(response.type).toBe('error');
      const payload = response.payload as Record<string, unknown>;
      expect(payload['code']).toBe('ERR_VALIDATION');
      expect(String(payload['message'])).toMatch(/exceeds maximum/);
    });

    it('should warn for messages between 100 KB and 1 MB', async () => {
      registry.register('scout', createEchoHandler());
      const logger = createLogger();

      const sizeRouter = new MessageRouter({ registry, logger });

      // Create a message around 200 KB
      const mediumPayload = 'x'.repeat(200_000);
      const message = createMessage({
        to: 'scout',
        payload: { data: mediumPayload },
      });

      await sizeRouter.dispatch(message);

      expect(logger.warns.some((w) => w.message === 'Large message detected')).toBe(
        true,
      );
    });

    it('should not warn for messages under 100 KB', async () => {
      registry.register('scout', createEchoHandler());
      const logger = createLogger();

      const sizeRouter = new MessageRouter({ registry, logger });

      const message = createMessage({ to: 'scout' });
      await sizeRouter.dispatch(message);

      expect(
        logger.warns.some((w) => w.message === 'Large message detected'),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Latency tracking
  // ---------------------------------------------------------------------------

  describe('latency tracking', () => {
    it('should log slow dispatches (> 1s) as warnings', async () => {
      const logger = createLogger();

      registry.register('scout', async (msg, _signal) => {
        // Simulate slow operation
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return {
          id: generateId(),
          correlationId: msg.correlationId,
          timestamp: new Date().toISOString(),
          from: msg.to,
          to: msg.from,
          type: 'plan.response' as const,
        };
      });

      const slowRouter = new MessageRouter({ registry, logger });
      const message = createMessage({ to: 'scout' });
      await slowRouter.dispatch(message);

      expect(
        logger.warns.some((w) => w.message === 'Slow dispatch detected'),
      ).toBe(true);
    }, 5000);

    it('should log normal dispatches at debug level', async () => {
      const logger = createLogger();

      registry.register('scout', createEchoHandler());

      const debugRouter = new MessageRouter({ registry, logger });
      const message = createMessage({ to: 'scout' });
      await debugRouter.dispatch(message);

      expect(
        logger.debugs.some((d) => d.message === 'Dispatch completed'),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // NoOpAuditWriter
  // ---------------------------------------------------------------------------

  describe('NoOpAuditWriter', () => {
    it('should not throw when write is called', () => {
      const writer = new NoOpAuditWriter();
      expect(() => {
        writer.write({
          id: generateId(),
          timestamp: new Date().toISOString(),
          actor: 'axis',
          action: 'test',
          riskLevel: 'low',
        });
      }).not.toThrow();
    });
  });
});
