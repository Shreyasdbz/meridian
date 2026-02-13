import { useEffect, useState } from 'react';

type ToastVariant = 'info' | 'success' | 'warning' | 'error';

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: 'border-meridian-500/30 bg-meridian-500/10 text-meridian-600 dark:text-meridian-400',
  success: 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400',
  warning: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
};

const ICON_PATHS: Record<ToastVariant, string> = {
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  success: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  warning:
    'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  error: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
};

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => {
        onDismiss(toast.id);
      }, 200);
    }, 5000);

    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, onDismiss]);

  return (
    <div
      role="alert"
      className={`pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg transition-all duration-200 ${VARIANT_CLASSES[toast.variant]} ${
        isVisible ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'
      }`}
    >
      <svg
        className="h-5 w-5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[toast.variant]} />
      </svg>
      <p className="text-sm font-medium">{toast.message}</p>
      <button
        onClick={() => {
          onDismiss(toast.id);
        }}
        className="ml-auto shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
