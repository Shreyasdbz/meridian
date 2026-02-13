import { useNotificationStore } from '../../stores/notification-store.js';
import { Button } from '../button.js';

/**
 * Opt-in banner for browser push notifications (Web Push API).
 * Section 5.5.12 — browser push notifications when Bridge is in background.
 *
 * In v0.1 this registers basic browser Notification permission.
 * Full Web Push API with service worker is deferred to v0.2.
 */
export function PushNotificationBanner(): React.ReactElement | null {
  const pushSupported = useNotificationStore((s) => s.pushSupported);
  const pushEnabled = useNotificationStore((s) => s.pushEnabled);
  const setPushEnabled = useNotificationStore((s) => s.setPushEnabled);
  const addNotification = useNotificationStore((s) => s.addNotification);

  if (!pushSupported || pushEnabled) {
    return null;
  }

  const handleEnable = async (): Promise<void> => {
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        setPushEnabled(true);
        addNotification({
          message: 'Browser notifications enabled.',
          variant: 'success',
        });
      } else {
        addNotification({
          message: 'Browser notification permission was denied.',
          variant: 'warning',
        });
      }
    } catch {
      addNotification({
        message: 'Could not request notification permission.',
        variant: 'error',
      });
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-meridian-200 bg-meridian-50 p-3 dark:border-meridian-800 dark:bg-meridian-950/30">
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          Browser notifications
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Get notified when tasks complete while Meridian is in the background.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => { void handleEnable(); }}
      >
        Enable
      </Button>
    </div>
  );
}
