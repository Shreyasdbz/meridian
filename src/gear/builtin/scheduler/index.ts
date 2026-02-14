// @meridian/gear/builtin/scheduler — Schedule management (Phase 9.3)
//
// Built-in Gear for CRUD operations on cron schedules.
// Uses context.executeCommand() to delegate to Axis schedule management.

import type { GearContext } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchedulerContext extends GearContext {
  executeCommand?(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Parameter "${name}" is required and must be a non-empty string`);
  }
  return value;
}

function requireCommand(context: SchedulerContext): (command: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> {
  if (typeof context.executeCommand !== 'function') {
    throw new Error('executeCommand is not available — scheduler Gear requires command execution support');
  }
  return context.executeCommand.bind(context);
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function createSchedule(context: SchedulerContext): Promise<Record<string, unknown>> {
  const executeCommand = requireCommand(context);
  const name = requireString(context.params, 'name');
  const cronExpression = requireString(context.params, 'cronExpression');
  const jobTemplate = context.params['jobTemplate'];

  if (typeof jobTemplate !== 'object' || jobTemplate === null) {
    throw new Error('Parameter "jobTemplate" is required and must be an object');
  }

  context.log(`Creating schedule: ${name} (${cronExpression})`);

  return executeCommand('schedule.create', {
    name,
    cronExpression,
    jobTemplate,
  });
}

async function updateSchedule(context: SchedulerContext): Promise<Record<string, unknown>> {
  const executeCommand = requireCommand(context);
  const id = requireString(context.params, 'id');

  const updates: Record<string, unknown> = { id };
  if (typeof context.params['name'] === 'string') {
    updates['name'] = context.params['name'];
  }
  if (typeof context.params['cronExpression'] === 'string') {
    updates['cronExpression'] = context.params['cronExpression'];
  }
  if (typeof context.params['enabled'] === 'boolean') {
    updates['enabled'] = context.params['enabled'];
  }

  context.log(`Updating schedule: ${id}`);

  return executeCommand('schedule.update', updates);
}

async function deleteSchedule(context: SchedulerContext): Promise<Record<string, unknown>> {
  const executeCommand = requireCommand(context);
  const id = requireString(context.params, 'id');

  context.log(`Deleting schedule: ${id}`);

  return executeCommand('schedule.delete', { id });
}

async function listSchedules(context: SchedulerContext): Promise<Record<string, unknown>> {
  const executeCommand = requireCommand(context);
  const enabledOnly = context.params['enabledOnly'] === true;

  context.log('Listing schedules');

  return executeCommand('schedule.list', { enabledOnly });
}

// ---------------------------------------------------------------------------
// Gear entry point
// ---------------------------------------------------------------------------

export async function execute(
  context: GearContext,
  action: string,
): Promise<Record<string, unknown>> {
  const schedulerContext = context as SchedulerContext;

  switch (action) {
    case 'create_schedule':
      return createSchedule(schedulerContext);
    case 'update_schedule':
      return updateSchedule(schedulerContext);
    case 'delete_schedule':
      return deleteSchedule(schedulerContext);
    case 'list_schedules':
      return listSchedules(schedulerContext);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
