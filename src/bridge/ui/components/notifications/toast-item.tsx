import { useEffect, useState } from 'react';

import type { Notification, NotificationVariant } from '../../stores/notification-store.js';

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

const VARIANT_CLASSES: Record<NotificationVariant, string> = {
  info: 'border-meridian-500/30 bg-meridian-500/10 text-meridian-600 dark:text-meridian-400',
  success: 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400',
  warning: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
};

const ICON_PATHS: Record<NotificationVariant, string> = {
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  success: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  warning:
    'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  error: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ToastItemProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ToastItem({ notification, onDismiss }: ToastItemProps): React.ReactElement {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    const raf = requestAnimationFrame(() => {
      setIsVisible(true);
    });

    // Auto-dismiss if duration > 0
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (notification.duration > 0) {
      timer = setTimeout(() => {
        setIsVisible(false);
        setTimeout(() => {
          onDismiss(notification.id);
        }, 200);
      }, notification.duration);
    }

    return () => {
      cancelAnimationFrame(raf);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [notification.id, notification.duration, onDismiss]);

  return (
    <div
      role="alert"
      className={`pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg transition-all duration-200 motion-reduce:transition-none ${VARIANT_CLASSES[notification.variant]} ${
        isVisible ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'
      }`}
    >
      <svg
        className="h-5 w-5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d={ICON_PATHS[notification.variant]}
        />
      </svg>
      <p className="text-sm font-medium">{notification.message}</p>
      <button
        onClick={() => {
          onDismiss(notification.id);
        }}
        className="ml-auto shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
        aria-label="Dismiss notification"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
