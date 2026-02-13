// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import {
  useNotificationStore,
  type Notification,
} from '../../stores/notification-store.js';

import { NotificationContainer } from './notification-container.js';
import { ToastItem } from './toast-item.js';
import { WebhookPlaceholder } from './webhook-placeholder.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useNotificationStore.setState({ notifications: [], pushEnabled: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Notification Store
// ---------------------------------------------------------------------------

describe('useNotificationStore', () => {
  it('should add a notification to the queue', () => {
    const id = useNotificationStore.getState().addNotification({
      message: 'Task completed',
      variant: 'success',
    });

    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.id).toBe(id);
    expect(state.notifications[0]?.message).toBe('Task completed');
    expect(state.notifications[0]?.variant).toBe('success');
  });

  it('should default to info variant and 5000ms duration', () => {
    useNotificationStore.getState().addNotification({
      message: 'Hello',
    });

    const state = useNotificationStore.getState();
    expect(state.notifications[0]?.variant).toBe('info');
    expect(state.notifications[0]?.duration).toBe(5000);
  });

  it('should respect custom duration', () => {
    useNotificationStore.getState().addNotification({
      message: 'Persistent',
      duration: 0,
    });

    expect(useNotificationStore.getState().notifications[0]?.duration).toBe(0);
  });

  it('should remove a notification by ID', () => {
    const id = useNotificationStore.getState().addNotification({
      message: 'Will be removed',
    });

    useNotificationStore.getState().removeNotification(id);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('should clear all notifications', () => {
    useNotificationStore.getState().addNotification({ message: 'One' });
    useNotificationStore.getState().addNotification({ message: 'Two' });
    useNotificationStore.getState().addNotification({ message: 'Three' });

    useNotificationStore.getState().clearAll();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('should evict oldest when exceeding max capacity (5)', () => {
    for (let i = 0; i < 6; i++) {
      useNotificationStore.getState().addNotification({ message: `Notification ${String(i)}` });
    }

    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(5);
    // Oldest (index 0) should have been evicted
    expect(state.notifications[0]?.message).toBe('Notification 1');
    expect(state.notifications[4]?.message).toBe('Notification 5');
  });

  it('should manage push notification state', () => {
    useNotificationStore.getState().setPushEnabled(true);
    expect(useNotificationStore.getState().pushEnabled).toBe(true);

    useNotificationStore.getState().setPushEnabled(false);
    expect(useNotificationStore.getState().pushEnabled).toBe(false);
  });

  it('should manage webhook URL', () => {
    useNotificationStore.getState().setWebhookUrl('https://hooks.example.com');
    expect(useNotificationStore.getState().webhookUrl).toBe('https://hooks.example.com');
  });
});

// ---------------------------------------------------------------------------
// ToastItem Component
// ---------------------------------------------------------------------------

describe('ToastItem', () => {
  const baseNotification: Notification = {
    id: 'test-1',
    message: 'Test notification',
    variant: 'info',
    duration: 5000,
    createdAt: Date.now(),
  };

  it('should render the notification message', () => {
    render(<ToastItem notification={baseNotification} onDismiss={vi.fn()} />);
    expect(screen.getByText('Test notification')).toBeInTheDocument();
  });

  it('should have role="alert" for screen readers', () => {
    render(<ToastItem notification={baseNotification} onDismiss={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should render a dismiss button with accessible label', () => {
    render(<ToastItem notification={baseNotification} onDismiss={vi.fn()} />);
    expect(screen.getByRole('button', { name: /dismiss notification/i })).toBeInTheDocument();
  });

  it('should call onDismiss when dismiss button is clicked', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastItem notification={baseNotification} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: /dismiss notification/i }));
    expect(onDismiss).toHaveBeenCalledWith('test-1');
  });

  it('should auto-dismiss after the specified duration', () => {
    const onDismiss = vi.fn();
    render(<ToastItem notification={baseNotification} onDismiss={onDismiss} />);

    // Advance past duration + exit animation
    act(() => { vi.advanceTimersByTime(5200); });

    expect(onDismiss).toHaveBeenCalledWith('test-1');
  });

  it('should not auto-dismiss when duration is 0 (persistent)', () => {
    const onDismiss = vi.fn();
    const persistent = { ...baseNotification, duration: 0 };
    render(<ToastItem notification={persistent} onDismiss={onDismiss} />);

    act(() => { vi.advanceTimersByTime(10000); });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('should render different variants', () => {
    const variants: Array<Notification['variant']> = ['info', 'success', 'warning', 'error'];

    for (const variant of variants) {
      cleanup();
      render(
        <ToastItem
          notification={{ ...baseNotification, variant }}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();
    }
  });

  it('should mark decorative icons as aria-hidden', () => {
    render(<ToastItem notification={baseNotification} onDismiss={vi.fn()} />);
    const svgs = document.querySelectorAll('svg[aria-hidden="true"]');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// NotificationContainer Component
// ---------------------------------------------------------------------------

describe('NotificationContainer', () => {
  it('should render notifications from the store', () => {
    useNotificationStore.setState({
      notifications: [
        { id: 'n1', message: 'First', variant: 'info', duration: 5000, createdAt: Date.now() },
        { id: 'n2', message: 'Second', variant: 'success', duration: 5000, createdAt: Date.now() },
      ],
    });

    render(<NotificationContainer />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('should render empty when no notifications', () => {
    render(<NotificationContainer />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should have an aria-live region', () => {
    render(<NotificationContainer />);
    const container = screen.getByLabelText('Notifications');
    expect(container).toHaveAttribute('aria-live', 'polite');
  });

  it('should dismiss notification when dismiss button is clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useNotificationStore.setState({
      notifications: [
        { id: 'n1', message: 'Dismissable', variant: 'info', duration: 0, createdAt: Date.now() },
      ],
    });

    render(<NotificationContainer />);
    expect(screen.getByText('Dismissable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss notification/i }));

    await waitFor(() => {
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// WebhookPlaceholder Component
// ---------------------------------------------------------------------------

describe('WebhookPlaceholder', () => {
  it('should render v0.2 badge', () => {
    render(<WebhookPlaceholder />);
    expect(screen.getByText('v0.2')).toBeInTheDocument();
  });

  it('should render webhook description', () => {
    render(<WebhookPlaceholder />);
    expect(screen.getByText(/Forward notifications to Slack/)).toBeInTheDocument();
  });
});
