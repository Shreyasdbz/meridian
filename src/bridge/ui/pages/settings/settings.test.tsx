// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { useSettingsStore } from '../../stores/settings-store.js';

import { AiProviderSection } from './ai-provider-section.js';
import { DeveloperModeSection } from './developer-mode-section.js';
import { SameProviderWarning } from './same-provider-warning.js';
import { SessionSection } from './session-section.js';
import { ShellGearSection } from './shell-gear-section.js';
import { TrustProfileSection } from './trust-profile-section.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
const mockApiDelete = vi.fn();

vi.mock('../../hooks/use-api.js', () => ({
  api: {
    get: (...args: unknown[]): unknown => mockApiGet(...args) as unknown,
    post: (...args: unknown[]): unknown => mockApiPost(...args) as unknown,
    put: (...args: unknown[]): unknown => mockApiPut(...args) as unknown,
    delete: (...args: unknown[]): unknown => mockApiDelete(...args) as unknown,
  },
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Mock auth store for SessionSection
const mockLogout = vi.fn();

vi.mock('../../stores/auth-store.js', () => ({
  useAuthStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        isAuthenticated: true,
        isSetupComplete: true,
        csrfToken: 'test-csrf',
        isLoading: false,
        setAuthenticated: vi.fn(),
        setSetupComplete: vi.fn(),
        setCsrfToken: vi.fn(),
        setLoading: vi.fn(),
        logout: mockLogout,
      }),
    {
      getState: () => ({
        csrfToken: 'test-csrf',
      }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockApiPut.mockResolvedValue(undefined);
  mockApiPost.mockResolvedValue(undefined);

  // Reset settings store to defaults
  useSettingsStore.setState({
    developerMode: false,
    shellGearEnabled: false,
    trustProfile: 'supervised',
    scoutProvider: 'anthropic',
    sentinelProvider: 'openai',
    providers: [
      { id: 'anthropic', name: 'Anthropic', hasKey: true },
      { id: 'openai', name: 'OpenAI', hasKey: true },
      { id: 'ollama', name: 'Ollama', hasKey: false },
    ],
    isLoaded: true,
    isSaving: false,
    saveError: null,
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// TrustProfileSection
// ---------------------------------------------------------------------------

describe('TrustProfileSection', () => {
  it('should render all three trust profiles', () => {
    render(<TrustProfileSection />);

    expect(screen.getByText('Ask me before doing anything')).toBeInTheDocument();
    expect(screen.getByText('Ask me for important stuff')).toBeInTheDocument();
    expect(screen.getByText('Just get it done')).toBeInTheDocument();
  });

  it('should highlight the currently selected profile', () => {
    render(<TrustProfileSection />);

    const supervisedBtn = screen.getByText('Ask me before doing anything').closest('button');
    expect(supervisedBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('should call setTrustProfile when a different profile is selected', async () => {
    const user = userEvent.setup();
    render(<TrustProfileSection />);

    await user.click(screen.getByText('Ask me for important stuff'));
    expect(mockApiPut).toHaveBeenCalledWith('/config', { trust_profile: 'balanced' });
  });

  it('should display description for each profile', () => {
    render(<TrustProfileSection />);

    expect(screen.getByText(/Prompt for every approval-required action/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-approve low and medium risk/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-approve everything except critical/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ShellGearSection
// ---------------------------------------------------------------------------

describe('ShellGearSection', () => {
  it('should render shell toggle switch', () => {
    render(<ShellGearSection />);

    expect(screen.getByRole('switch', { name: /Toggle shell access/i })).toBeInTheDocument();
  });

  it('should show disabled state text when shell is off', () => {
    render(<ShellGearSection />);

    expect(
      screen.getByText(/Shell access is disabled/i),
    ).toBeInTheDocument();
  });

  it('should show enabled state text when shell is on', () => {
    useSettingsStore.setState({ shellGearEnabled: true });
    render(<ShellGearSection />);

    expect(
      screen.getByText(/Shell access is enabled/i),
    ).toBeInTheDocument();
  });

  it('should show always-requires-approval notice when enabled', () => {
    useSettingsStore.setState({ shellGearEnabled: true });
    render(<ShellGearSection />);

    expect(
      screen.getByText(/Shell commands always require fresh approval/i),
    ).toBeInTheDocument();
  });

  it('should toggle shell gear on click', async () => {
    const user = userEvent.setup();
    render(<ShellGearSection />);

    await user.click(screen.getByRole('switch', { name: /Toggle shell access/i }));
    expect(mockApiPut).toHaveBeenCalledWith('/config', { shell_gear_enabled: true });
  });

  it('should set aria-checked correctly', () => {
    render(<ShellGearSection />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    cleanup();
    useSettingsStore.setState({ shellGearEnabled: true });
    render(<ShellGearSection />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

// ---------------------------------------------------------------------------
// DeveloperModeSection
// ---------------------------------------------------------------------------

describe('DeveloperModeSection', () => {
  it('should render developer mode toggle switch', () => {
    render(<DeveloperModeSection />);

    expect(
      screen.getByRole('switch', { name: /Toggle developer mode/i }),
    ).toBeInTheDocument();
  });

  it('should show disabled state text when off', () => {
    render(<DeveloperModeSection />);

    expect(
      screen.getByText(/Internal details are hidden/i),
    ).toBeInTheDocument();
  });

  it('should show enabled state text when on', () => {
    useSettingsStore.setState({ developerMode: true });
    render(<DeveloperModeSection />);

    expect(
      screen.getByText(/Showing internal component names, raw plan JSON/),
    ).toBeInTheDocument();
  });

  it('should show feature list when enabled', () => {
    useSettingsStore.setState({ developerMode: true });
    render(<DeveloperModeSection />);

    expect(screen.getByText(/Raw execution plan JSON in approval/i)).toBeInTheDocument();
    expect(screen.getByText(/Message routing between components/i)).toBeInTheDocument();
    expect(screen.getByText(/Sentinel safety reasoning details/i)).toBeInTheDocument();
  });

  it('should persist developer mode toggle via API', async () => {
    const user = userEvent.setup();
    render(<DeveloperModeSection />);

    await user.click(screen.getByRole('switch', { name: /Toggle developer mode/i }));
    expect(mockApiPut).toHaveBeenCalledWith('/config', { developer_mode: true });
  });
});

// ---------------------------------------------------------------------------
// SameProviderWarning
// ---------------------------------------------------------------------------

describe('SameProviderWarning', () => {
  it('should show warning when scout and sentinel use same provider', () => {
    useSettingsStore.setState({
      scoutProvider: 'anthropic',
      sentinelProvider: 'anthropic',
    });
    render(<SameProviderWarning />);

    expect(
      screen.getByText(/Same AI provider for planning and safety/i),
    ).toBeInTheDocument();
  });

  it('should not show warning when providers differ', () => {
    useSettingsStore.setState({
      scoutProvider: 'anthropic',
      sentinelProvider: 'openai',
    });
    render(<SameProviderWarning />);

    expect(
      screen.queryByText(/Same AI provider for planning and safety/i),
    ).not.toBeInTheDocument();
  });

  it('should not show warning when providers are empty', () => {
    useSettingsStore.setState({
      scoutProvider: '',
      sentinelProvider: '',
    });
    render(<SameProviderWarning />);

    expect(
      screen.queryByText(/Same AI provider/i),
    ).not.toBeInTheDocument();
  });

  it('should be dismissible', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      scoutProvider: 'anthropic',
      sentinelProvider: 'anthropic',
    });
    render(<SameProviderWarning />);

    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Dismiss warning/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should explain the security implication', () => {
    useSettingsStore.setState({
      scoutProvider: 'anthropic',
      sentinelProvider: 'anthropic',
    });
    render(<SameProviderWarning />);

    expect(
      screen.getByText(/reduces the independence/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SessionSection
// ---------------------------------------------------------------------------

describe('SessionSection', () => {
  it('should render logout button', () => {
    render(<SessionSection />);

    expect(screen.getByRole('button', { name: /Log out/i })).toBeInTheDocument();
  });

  it('should call logout on button click', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue(undefined);
    render(<SessionSection />);

    await user.click(screen.getByRole('button', { name: /Log out/i }));

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledOnce();
    });
  });
});

// ---------------------------------------------------------------------------
// AiProviderSection
// ---------------------------------------------------------------------------

describe('AiProviderSection', () => {
  it('should surface error when key removal fails', async () => {
    // Only one provider has a key to keep the test deterministic
    useSettingsStore.setState({
      providers: [
        { id: 'anthropic', name: 'Anthropic', hasKey: true },
        { id: 'openai', name: 'OpenAI', hasKey: false },
      ],
    });
    const user = userEvent.setup();
    mockApiDelete.mockRejectedValue(new Error('Delete failed'));
    render(<AiProviderSection />);

    await user.click(screen.getByRole('button', { name: /Remove/i }));

    await waitFor(() => {
      expect(useSettingsStore.getState().saveError).toBe('Delete failed');
    });
  });
});

// ---------------------------------------------------------------------------
// Settings persistence via store
// ---------------------------------------------------------------------------

describe('Settings store persistence', () => {
  it('should load settings from API', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/config') {
        return Promise.resolve({
          developer_mode: true,
          shell_gear_enabled: true,
          trust_profile: 'balanced',
          scout_provider: 'openai',
          sentinel_provider: 'anthropic',
        });
      }
      if (path === '/secrets') {
        return Promise.resolve({
          secrets: [{ name: 'openai_api_key' }, { name: 'anthropic_api_key' }],
        });
      }
      return Promise.resolve({});
    });

    // Reset to unloaded state
    useSettingsStore.setState({ isLoaded: false });

    await act(async () => {
      await useSettingsStore.getState().load();
    });

    const state = useSettingsStore.getState();
    expect(state.developerMode).toBe(true);
    expect(state.shellGearEnabled).toBe(true);
    expect(state.trustProfile).toBe('balanced');
    expect(state.scoutProvider).toBe('openai');
    expect(state.sentinelProvider).toBe('anthropic');
    expect(state.isLoaded).toBe(true);
  });

  it('should handle load errors gracefully', async () => {
    mockApiGet.mockRejectedValue(new Error('Network error'));

    useSettingsStore.setState({ isLoaded: false });

    await act(async () => {
      await useSettingsStore.getState().load();
    });

    const state = useSettingsStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.saveError).toBe('Network error');
  });

  it('should handle save errors and expose them', async () => {
    mockApiPut.mockRejectedValue(new Error('Server error'));

    await act(async () => {
      await useSettingsStore.getState().setDeveloperMode(true);
    });

    const state = useSettingsStore.getState();
    expect(state.saveError).toBe('Server error');
    expect(state.isSaving).toBe(false);
  });

  it('should clear errors when clearError is called', () => {
    useSettingsStore.setState({ saveError: 'some error' });
    useSettingsStore.getState().clearError();
    expect(useSettingsStore.getState().saveError).toBeNull();
  });
});
