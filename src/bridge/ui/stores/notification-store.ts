import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationVariant = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  message: string;
  variant: NotificationVariant;
  /** Auto-dismiss duration in ms. 0 means persistent (manual dismiss only). */
  duration: number;
  /** Timestamp when the notification was created. */
  createdAt: number;
}

export interface AddNotificationOptions {
  message: string;
  variant?: NotificationVariant;
  /** Auto-dismiss duration in ms. Defaults to 5000. Set to 0 for persistent. */
  duration?: number;
}

interface NotificationState {
  /** Active notification queue, newest last. */
  notifications: Notification[];

  /** Whether browser push notifications are enabled (opt-in). */
  pushEnabled: boolean;

  /** Whether the browser supports push notifications. */
  pushSupported: boolean;

  /** Webhook URL for external notifications (v0.2 placeholder). */
  webhookUrl: string;
}

interface NotificationActions {
  /** Add a notification to the queue. Returns the notification ID. */
  addNotification: (options: AddNotificationOptions) => string;

  /** Remove a notification by ID. */
  removeNotification: (id: string) => void;

  /** Clear all notifications. */
  clearAll: () => void;

  /** Toggle browser push notification opt-in. */
  setPushEnabled: (enabled: boolean) => void;

  /** Set webhook URL (v0.2 placeholder). */
  setWebhookUrl: (url: string) => void;
}

type NotificationStore = NotificationState & NotificationActions;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 5;
const DEFAULT_DURATION = 5000;

// ---------------------------------------------------------------------------
// ID generation (simple counter for notifications — not persisted)
// ---------------------------------------------------------------------------

let notificationCounter = 0;

function generateNotificationId(): string {
  notificationCounter += 1;
  return `notification-${Date.now()}-${notificationCounter}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  pushEnabled: false,
  pushSupported: typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator,
  webhookUrl: '',

  addNotification: (options) => {
    const id = generateNotificationId();
    const notification: Notification = {
      id,
      message: options.message,
      variant: options.variant ?? 'info',
      duration: options.duration ?? DEFAULT_DURATION,
      createdAt: Date.now(),
    };

    set((state) => {
      const updated = [...state.notifications, notification];
      // Evict oldest if over max capacity
      if (updated.length > MAX_NOTIFICATIONS) {
        return { notifications: updated.slice(updated.length - MAX_NOTIFICATIONS) };
      }
      return { notifications: updated };
    });

    return id;
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAll: () => {
    set({ notifications: [] });
  },

  setPushEnabled: (enabled) => {
    set({ pushEnabled: enabled });
  },

  setWebhookUrl: (url) => {
    set({ webhookUrl: url });
  },
}));
