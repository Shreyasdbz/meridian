// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { useConversationStore } from '../../stores/conversation-store.js';
import { useJobStore } from '../../stores/job-store.js';
import { useSettingsStore } from '../../stores/settings-store.js';

import { CommandPalette } from './command-palette.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiPost = vi.fn();

vi.mock('../../hooks/use-api.js', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]): unknown => mockApiPost(...args) as unknown,
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../../stores/auth-store.js', () => ({
  useAuthStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        csrfToken: 'test-csrf',
      }),
    {
      getState: () => ({ csrfToken: 'test-csrf' }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  onOpenSettings: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();

  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();

  // Reset stores
  useConversationStore.setState({
    conversations: [
      {
        id: 'conv-1',
        title: 'Test Conversation',
        status: 'active' as const,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'conv-2',
        title: 'Another Chat',
        status: 'active' as const,
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ],
    activeConversationId: 'conv-1',
    messages: [],
    isStreaming: false,
    streamingContent: '',
    inputValue: '',
    isLoading: false,
  });

  useJobStore.setState({
    activeJobs: [],
    pendingApprovals: [],
    recentCompletions: [],
    isLoading: false,
  });

  useSettingsStore.setState({
    developerMode: false,
    shellGearEnabled: false,
    trustProfile: 'supervised',
    scoutProvider: '',
    sentinelProvider: '',
    providers: [],
    isLoaded: true,
    isSaving: false,
    saveError: null,
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandPalette', () => {
  describe('rendering', () => {
    it('should render when open is true', () => {
      render(<CommandPalette {...defaultProps} />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should not render when open is false', () => {
      render(<CommandPalette {...defaultProps} open={false} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('should render search input', () => {
      render(<CommandPalette {...defaultProps} />);
      expect(screen.getByPlaceholderText('Type a command...')).toBeInTheDocument();
    });

    it('should render default commands', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByText('New conversation')).toBeInTheDocument();
      expect(screen.getByText('Open settings')).toBeInTheDocument();
      expect(screen.getByText('Enable developer mode')).toBeInTheDocument();
      expect(screen.getByText('Focus chat input')).toBeInTheDocument();
    });

    it('should render conversation entries', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
      expect(screen.getByText('Another Chat')).toBeInTheDocument();
    });

    it('should show keyboard navigation hints', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByText('Navigate')).toBeInTheDocument();
      expect(screen.getByText('Select')).toBeInTheDocument();
      expect(screen.getByText('Close')).toBeInTheDocument();
    });
  });

  describe('search filtering', () => {
    it('should filter commands by search query', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'settings');

      expect(screen.getByText('Open settings')).toBeInTheDocument();
      expect(screen.queryByText('New conversation')).not.toBeInTheDocument();
    });

    it('should show "No commands found" for empty results', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'xyznonexistent');

      expect(screen.getByText('No commands found')).toBeInTheDocument();
    });

    it('should filter conversations by title', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'Another');

      expect(screen.getByText('Another Chat')).toBeInTheDocument();
      expect(screen.queryByText('Test Conversation')).not.toBeInTheDocument();
    });
  });

  describe('keyboard navigation', () => {
    it('should close on Escape key', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.click(input);
      await user.keyboard('{Escape}');

      expect(defaultProps.onClose).toHaveBeenCalledOnce();
    });

    it('should navigate with arrow keys', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.click(input);

      // First item should be selected by default
      const firstItem = screen.getByText('New conversation').closest('[role="option"]');
      expect(firstItem).toHaveAttribute('aria-selected', 'true');

      // Arrow down to second item
      await user.keyboard('{ArrowDown}');
      const secondItem = screen.getByText('Open settings').closest('[role="option"]');
      expect(secondItem).toHaveAttribute('aria-selected', 'true');
    });

    it('should execute command on Enter key', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByPlaceholderText('Type a command...');
      await user.type(input, 'settings');
      await user.keyboard('{Enter}');

      expect(defaultProps.onOpenSettings).toHaveBeenCalledOnce();
      expect(defaultProps.onClose).toHaveBeenCalledOnce();
    });
  });

  describe('command execution', () => {
    it('should open settings when "Open settings" is clicked', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      await user.click(screen.getByText('Open settings'));

      expect(defaultProps.onOpenSettings).toHaveBeenCalledOnce();
      expect(defaultProps.onClose).toHaveBeenCalledOnce();
    });

    it('should create new conversation when clicked', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      await user.click(screen.getByText('New conversation'));
      expect(defaultProps.onClose).toHaveBeenCalledOnce();
    });

    it('should switch conversation when conversation item is clicked', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      await user.click(screen.getByText('Another Chat'));
      expect(defaultProps.onClose).toHaveBeenCalledOnce();

      // Verify conversation was changed
      const state = useConversationStore.getState();
      expect(state.activeConversationId).toBe('conv-2');
    });

    it('should dispatch focus event for chat input command', async () => {
      const user = userEvent.setup();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      render(<CommandPalette {...defaultProps} />);

      await user.click(screen.getByText('Focus chat input'));

      const focusEvent = dispatchSpy.mock.calls.find(
        (call) => (call[0] as CustomEvent).type === 'meridian:focus-chat-input',
      );
      expect(focusEvent).toBeDefined();
      dispatchSpy.mockRestore();
    });

    it('should close on backdrop click', async () => {
      const user = userEvent.setup();
      render(<CommandPalette {...defaultProps} />);

      // Click the backdrop (the div behind the palette)
      const backdrop = document.querySelector('.fixed.inset-0');
      if (backdrop) {
        await user.click(backdrop);
      }

      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  describe('dynamic commands', () => {
    it('should show cancel task command when active jobs exist', () => {
      useJobStore.setState({
        activeJobs: [
          {
            id: 'job-abc12345-6789',
            status: 'executing',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByText('Cancel task')).toBeInTheDocument();
    });

    it('should not show cancel task command when no active jobs', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.queryByText('Cancel task')).not.toBeInTheDocument();
    });

    it('should show "Disable developer mode" when dev mode is on', () => {
      useSettingsStore.setState({ developerMode: true });
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByText('Disable developer mode')).toBeInTheDocument();
    });

    it('should show "Enable developer mode" when dev mode is off', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByText('Enable developer mode')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should have aria-modal on the dialog', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('should have proper combobox role on search input', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('should have listbox role on results', () => {
      render(<CommandPalette {...defaultProps} />);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('should set aria-activedescendant on the input', () => {
      render(<CommandPalette {...defaultProps} />);

      const input = screen.getByRole('combobox');
      expect(input).toHaveAttribute('aria-activedescendant');
    });
  });
});
