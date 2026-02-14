// @meridian/gear/builtin/notification — Notification sending (Phase 9.3)
//
// Built-in Gear for sending notifications to the user via Bridge UI.
// Uses context.executeCommand() to delegate to the notification system.

import type { GearContext } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationContext extends GearContext {
  executeCommand?(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type NotificationLevel = 'info' | 'warning' | 'error';

const VALID_LEVELS = new Set<string>(['info', 'warning', 'error']);

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function sendNotification(context: NotificationContext): Promise<Record<string, unknown>> {
  if (typeof context.executeCommand !== 'function') {
    throw new Error('executeCommand is not available — notification Gear requires command execution support');
  }

  const message = context.params['message'];
  if (typeof message !== 'string' || message === '') {
    throw new Error('Parameter "message" is required and must be a non-empty string');
  }

  // Enforce max message length to prevent abuse
  if (message.length > 1000) {
    throw new Error('Notification message exceeds maximum length of 1000 characters');
  }

  const levelRaw = context.params['level'];
  let level: NotificationLevel = 'info';
  if (typeof levelRaw === 'string') {
    if (!VALID_LEVELS.has(levelRaw)) {
      throw new Error(`Invalid notification level "${levelRaw}". Must be one of: info, warning, error`);
    }
    level = levelRaw as NotificationLevel;
  }

  context.log(`Sending ${level} notification: ${message.slice(0, 50)}...`);

  const result = await context.executeCommand('notification.send', {
    message,
    level,
  });

  return {
    sent: true,
    level,
    sentAt: new Date().toISOString(),
    ...result,
  };
}

// ---------------------------------------------------------------------------
// Gear entry point
// ---------------------------------------------------------------------------

export async function execute(
  context: GearContext,
  action: string,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'send_notification':
      return sendNotification(context as NotificationContext);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
