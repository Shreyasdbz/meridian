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

function createMockContextWithoutCommand(params: Record<string, unknown>): GearContext {
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

describe('scheduler Gear', () => {
  describe('create_schedule', () => {
    it('should call executeCommand with schedule.create', async () => {
      const context = createMockContext(
        {
          name: 'Daily backup',
          cronExpression: '0 2 * * *',
          jobTemplate: { description: 'Run backup' },
        },
        { id: 'sched-1', name: 'Daily backup', cronExpression: '0 2 * * *', enabled: true, createdAt: '2024-01-01T00:00:00Z' },
      );

      const result = await execute(context, 'create_schedule');

      expect(context.executeCommand).toHaveBeenCalledWith('schedule.create', {
        name: 'Daily backup',
        cronExpression: '0 2 * * *',
        jobTemplate: { description: 'Run backup' },
      });
      expect(result['id']).toBe('sched-1');
    });

    it('should throw for missing name', async () => {
      const context = createMockContext({
        cronExpression: '0 2 * * *',
        jobTemplate: { description: 'test' },
      });

      await expect(execute(context, 'create_schedule')).rejects.toThrow(
        'Parameter "name" is required',
      );
    });

    it('should throw for missing cronExpression', async () => {
      const context = createMockContext({
        name: 'test',
        jobTemplate: { description: 'test' },
      });

      await expect(execute(context, 'create_schedule')).rejects.toThrow(
        'Parameter "cronExpression" is required',
      );
    });

    it('should throw for missing jobTemplate', async () => {
      const context = createMockContext({
        name: 'test',
        cronExpression: '0 * * * *',
      });

      await expect(execute(context, 'create_schedule')).rejects.toThrow(
        'Parameter "jobTemplate" is required',
      );
    });

    it('should throw when executeCommand is not available', async () => {
      const context = createMockContextWithoutCommand({
        name: 'test',
        cronExpression: '0 * * * *',
        jobTemplate: { description: 'test' },
      });

      await expect(execute(context, 'create_schedule')).rejects.toThrow(
        'executeCommand is not available',
      );
    });
  });

  describe('update_schedule', () => {
    it('should call executeCommand with schedule.update', async () => {
      const context = createMockContext(
        { id: 'sched-1', name: 'New name', enabled: false },
        { id: 'sched-1', updated: true },
      );

      const result = await execute(context, 'update_schedule');

      expect(context.executeCommand).toHaveBeenCalledWith('schedule.update', {
        id: 'sched-1',
        name: 'New name',
        enabled: false,
      });
      expect(result['updated']).toBe(true);
    });

    it('should throw for missing id', async () => {
      const context = createMockContext({ name: 'test' });

      await expect(execute(context, 'update_schedule')).rejects.toThrow(
        'Parameter "id" is required',
      );
    });

    it('should only include provided update fields', async () => {
      const context = createMockContext(
        { id: 'sched-1', cronExpression: '*/5 * * * *' },
        { id: 'sched-1', updated: true },
      );

      await execute(context, 'update_schedule');

      expect(context.executeCommand).toHaveBeenCalledWith('schedule.update', {
        id: 'sched-1',
        cronExpression: '*/5 * * * *',
      });
    });
  });

  describe('delete_schedule', () => {
    it('should call executeCommand with schedule.delete', async () => {
      const context = createMockContext(
        { id: 'sched-1' },
        { id: 'sched-1', deleted: true },
      );

      const result = await execute(context, 'delete_schedule');

      expect(context.executeCommand).toHaveBeenCalledWith('schedule.delete', { id: 'sched-1' });
      expect(result['deleted']).toBe(true);
    });

    it('should throw for missing id', async () => {
      const context = createMockContext({});

      await expect(execute(context, 'delete_schedule')).rejects.toThrow(
        'Parameter "id" is required',
      );
    });
  });

  describe('list_schedules', () => {
    it('should call executeCommand with schedule.list', async () => {
      const context = createMockContext(
        {},
        { schedules: [], count: 0 },
      );

      const result = await execute(context, 'list_schedules');

      expect(context.executeCommand).toHaveBeenCalledWith('schedule.list', { enabledOnly: false });
      expect(result['count']).toBe(0);
    });

    it('should pass enabledOnly filter', async () => {
      const context = createMockContext(
        { enabledOnly: true },
        { schedules: [], count: 0 },
      );

      await execute(context, 'list_schedules');

      expect(context.executeCommand).toHaveBeenCalledWith('schedule.list', { enabledOnly: true });
    });
  });

  describe('unknown action', () => {
    it('should throw for unknown action', async () => {
      const context = createMockContext({});

      await expect(execute(context, 'invalid')).rejects.toThrow(
        'Unknown action: invalid',
      );
    });
  });
});
