import { useCallback } from 'react';

import { useNotificationStore } from '../../stores/notification-store.js';

import { ToastItem } from './toast-item.js';

/**
 * NotificationContainer renders active toast notifications from the store.
 * Mount this once in the application Layout. Section 5.5.12.
 */
export function NotificationContainer(): React.ReactElement {
  const notifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);

  const handleDismiss = useCallback(
    (id: string) => {
      removeNotification(id);
    },
    [removeNotification],
  );

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      aria-live="polite"
      aria-label="Notifications"
    >
      {notifications.map((notification) => (
        <ToastItem
          key={notification.id}
          notification={notification}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  );
}
