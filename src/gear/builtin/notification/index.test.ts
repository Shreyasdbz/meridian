import { describe, it, expect, vi } from 'vitest';

import type { GearContext } from '@meridian/shared';

import { execute } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockContext extends GearContext {
  executeCommand: ReturnType<typeof vi.fn>;
}

function createMockContext(
  params: Record<string, unknown>,
  commandResult?: Record<string, unknown>,
): MockContext {
  return {
    params,
    getSecret: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    writeFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    deleteFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    listFiles: vi.fn().mockRejectedValue(new Error('not implemented')),
    fetch: vi.fn().mockRejectedValue(new Error('not implemented')),
    log: vi.fn(),
    progress: vi.fn(),
    createSubJob: vi.fn().mockResolvedValue({ jobId: 'test', status: 'pending' }),
    executeCommand: vi.fn().mockResolvedValue(commandResult ?? {}),
  };
}

function createContextWithoutCommand(params: Record<string, unknown>): GearContext {
  return {
    params,
    getSecret: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    writeFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    deleteFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    listFiles: vi.fn().mockRejectedValue(new Error('not implemented')),
    fetch: vi.fn().mockRejectedValue(new Error('not implemented')),
    log: vi.fn(),
    progress: vi.fn(),
    createSubJob: vi.fn().mockResolvedValue({ jobId: 'test', status: 'pending' }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notification Gear', () => {
  describe('send_notification', () => {
    it('should send a notification with default level', async () => {
      const context = createMockContext({ message: 'Hello world' });

      const result = await execute(context, 'send_notification');

      expect(context.executeCommand).toHaveBeenCalledWith('notification.send', {
        message: 'Hello world',
        level: 'info',
      });
      expect(result['sent']).toBe(true);
      expect(result['level']).toBe('info');
      expect(result['sentAt']).toBeDefined();
    });

    it('should send a notification with warning level', async () => {
      const context = createMockContext({ message: 'Watch out', level: 'warning' });

      const result = await execute(context, 'send_notification');

      expect(context.executeCommand).toHaveBeenCalledWith('notification.send', {
        message: 'Watch out',
        level: 'warning',
      });
      expect(result['level']).toBe('warning');
    });

    it('should send a notification with error level', async () => {
      const context = createMockContext({ message: 'Something broke', level: 'error' });

      const result = await execute(context, 'send_notification');

      expect(result['level']).toBe('error');
    });

    it('should throw for missing message', async () => {
      const context = createMockContext({});

      await expect(execute(context, 'send_notification')).rejects.toThrow(
        'Parameter "message" is required',
      );
    });

    it('should throw for empty message', async () => {
      const context = createMockContext({ message: '' });

      await expect(execute(context, 'send_notification')).rejects.toThrow(
        'Parameter "message" is required',
      );
    });

    it('should throw for invalid level', async () => {
      const context = createMockContext({ message: 'test', level: 'critical' });

      await expect(execute(context, 'send_notification')).rejects.toThrow(
        'Invalid notification level',
      );
    });

    it('should throw for message exceeding max length', async () => {
      const context = createMockContext({ message: 'x'.repeat(1001) });

      await expect(execute(context, 'send_notification')).rejects.toThrow(
        'exceeds maximum length',
      );
    });

    it('should throw when executeCommand is not available', async () => {
      const context = createContextWithoutCommand({ message: 'test' });

      await expect(execute(context, 'send_notification')).rejects.toThrow(
        'executeCommand is not available',
      );
    });

    it('should log notification info', async () => {
      const context = createMockContext({ message: 'Hello world' });

      await execute(context, 'send_notification');

      expect(context.log).toHaveBeenCalled();
    });
  });

  describe('unknown action', () => {
    it('should throw for unknown action', async () => {
      const context = createMockContext({ message: 'test' });

      await expect(execute(context, 'unknown')).rejects.toThrow(
        'Unknown action: unknown',
      );
    });
  });
});
