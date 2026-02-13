// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AiKeyStep } from './ai-key-step.js';
import { ComfortLevelStep } from './comfort-level-step.js';
import { FirstMessageStep } from './first-message-step.js';
import { PasswordStep } from './password-step.js';

import { OnboardingWizard } from './index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();

vi.mock('../../hooks/use-api.js', () => ({
  api: {
    get: (...args: unknown[]): unknown => mockApiGet(...args) as unknown,
    post: (...args: unknown[]): unknown => mockApiPost(...args) as unknown,
    put: (...args: unknown[]): unknown => mockApiPut(...args) as unknown,
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

// Mock auth store with a simple in-memory implementation
const mockAuthState = {
  isAuthenticated: false,
  isSetupComplete: false,
  csrfToken: null as string | null,
  isLoading: false,
};

vi.mock('../../stores/auth-store.js', () => ({
  useAuthStore: (selector: (state: typeof mockAuthState & Record<string, unknown>) => unknown) =>
    selector({
      ...mockAuthState,
      setAuthenticated: (val: boolean) => { mockAuthState.isAuthenticated = val; },
      setSetupComplete: (val: boolean) => { mockAuthState.isSetupComplete = val; },
      setCsrfToken: (val: string | null) => { mockAuthState.csrfToken = val; },
      setLoading: vi.fn(),
      logout: vi.fn(),
    }),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.isAuthenticated = false;
  mockAuthState.isSetupComplete = false;
  mockAuthState.csrfToken = null;
});

// ---------------------------------------------------------------------------
// PasswordStep
// ---------------------------------------------------------------------------

describe('PasswordStep', () => {
  it('should render the password creation form', () => {
    render(<PasswordStep onComplete={vi.fn()} />);

    expect(screen.getByText('Create a password')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('should disable continue button when password is empty', () => {
    render(<PasswordStep onComplete={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('should show strength indicator when typing', async () => {
    const user = userEvent.setup();
    render(<PasswordStep onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'abcdefgh');

    expect(screen.getByText('good')).toBeInTheDocument();
  });

  it('should show mismatch error when passwords differ', async () => {
    const user = userEvent.setup();
    render(<PasswordStep onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'abcdefgh');
    await user.type(screen.getByLabelText('Confirm password'), 'different');

    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
  });

  it('should enable continue when passwords match and strength is fair or above', async () => {
    const user = userEvent.setup();
    render(<PasswordStep onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'abcdefgh');
    await user.type(screen.getByLabelText('Confirm password'), 'abcdefgh');

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('should call setup and login APIs on submit', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();

    mockApiPost
      .mockResolvedValueOnce({ message: 'Password configured' })
      .mockResolvedValueOnce({
        sessionId: 'sess-1',
        csrfToken: 'csrf-123',
        expiresAt: '2026-12-31',
      });

    render(<PasswordStep onComplete={onComplete} />);

    await user.type(screen.getByLabelText('Password'), 'MyStr0ng!');
    await user.type(screen.getByLabelText('Confirm password'), 'MyStr0ng!');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/auth/setup', { password: 'MyStr0ng!' });
      expect(mockApiPost).toHaveBeenCalledWith('/auth/login', { password: 'MyStr0ng!' });
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('should show error on API failure', async () => {
    const user = userEvent.setup();

    mockApiPost.mockRejectedValueOnce(new Error('Password already configured'));

    render(<PasswordStep onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'MyStr0ng!');
    await user.type(screen.getByLabelText('Confirm password'), 'MyStr0ng!');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Password already configured');
    });
  });
});

// ---------------------------------------------------------------------------
// AiKeyStep
// ---------------------------------------------------------------------------

describe('AiKeyStep', () => {
  it('should render provider grid with three options', () => {
    render(<AiKeyStep onComplete={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Ollama')).toBeInTheDocument();
  });

  it('should show API key input for Anthropic by default', () => {
    render(<AiKeyStep onComplete={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });

  it('should hide API key input when Ollama is selected', async () => {
    const user = userEvent.setup();
    render(<AiKeyStep onComplete={vi.fn()} onBack={vi.fn()} />);

    await user.click(screen.getByText('Ollama'));

    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  });

  it('should validate key and show success state', async () => {
    const user = userEvent.setup();

    mockApiPost.mockResolvedValueOnce({ valid: true, model: 'claude-sonnet-4-5-20250929' });

    render(<AiKeyStep onComplete={vi.fn()} onBack={vi.fn()} />);

    await user.type(screen.getByLabelText('API key'), 'sk-ant-test-key');
    await user.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() => {
      expect(screen.getByText('API key validated successfully')).toBeInTheDocument();
    });
  });

  it('should show error on validation failure', async () => {
    const user = userEvent.setup();

    mockApiPost.mockResolvedValueOnce({ valid: false, error: 'Invalid API key' });

    render(<AiKeyStep onComplete={vi.fn()} onBack={vi.fn()} />);

    await user.type(screen.getByLabelText('API key'), 'bad-key');
    await user.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid API key');
    });
  });

  it('should store key and config on continue after validation', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();

    mockApiPost
      .mockResolvedValueOnce({ valid: true, model: 'claude-sonnet-4-5-20250929' }) // validate
      .mockResolvedValueOnce({ name: 'anthropic_api_key', message: 'stored' }); // store secret
    mockApiPut.mockResolvedValueOnce({ key: 'ai_provider', value: 'anthropic' });

    render(<AiKeyStep onComplete={onComplete} onBack={vi.fn()} />);

    await user.type(screen.getByLabelText('API key'), 'sk-ant-valid');
    await user.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() => {
      expect(screen.getByText('API key validated successfully')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/secrets', {
        name: 'anthropic_api_key',
        value: 'sk-ant-valid',
        allowedGear: ['gear:scout'],
      });
      expect(mockApiPut).toHaveBeenCalledWith('/config', {
        key: 'ai_provider',
        value: 'anthropic',
      });
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('should allow skipping the step', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();

    render(<AiKeyStep onComplete={onComplete} onBack={vi.fn()} />);

    await user.click(screen.getByText('Skip for now'));

    expect(onComplete).toHaveBeenCalled();
  });

  it('should call onBack when back button is clicked', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();

    render(<AiKeyStep onComplete={vi.fn()} onBack={onBack} />);

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ComfortLevelStep
// ---------------------------------------------------------------------------

describe('ComfortLevelStep', () => {
  it('should render three comfort level options', () => {
    render(<ComfortLevelStep onComplete={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByText('Ask me before doing anything')).toBeInTheDocument();
    expect(screen.getByText('Ask me for important stuff')).toBeInTheDocument();
    expect(screen.getByText('Just get it done')).toBeInTheDocument();
  });

  it('should have supervised selected by default with Recommended label', () => {
    render(<ComfortLevelStep onComplete={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('should allow changing selection', async () => {
    const user = userEvent.setup();

    mockApiPut.mockResolvedValueOnce({ key: 'trust_profile', value: 'balanced' });

    render(<ComfortLevelStep onComplete={vi.fn()} onBack={vi.fn()} />);

    await user.click(screen.getByText('Ask me for important stuff'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/config', {
        key: 'trust_profile',
        value: 'balanced',
      });
    });
  });

  it('should persist choice via API on continue', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();

    mockApiPut.mockResolvedValueOnce({ key: 'trust_profile', value: 'supervised' });

    render(<ComfortLevelStep onComplete={onComplete} onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/config', {
        key: 'trust_profile',
        value: 'supervised',
      });
      expect(onComplete).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// FirstMessageStep
// ---------------------------------------------------------------------------

describe('FirstMessageStep', () => {
  it('should render welcome message and capabilities', () => {
    render(<FirstMessageStep onComplete={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByText("You're all set!")).toBeInTheDocument();
    expect(screen.getByText('Search the web')).toBeInTheDocument();
    expect(screen.getByText('Work with files')).toBeInTheDocument();
    expect(screen.getByText('Set reminders')).toBeInTheDocument();
    expect(screen.getByText('Answer questions')).toBeInTheDocument();
  });

  it('should render starter prompt cards', () => {
    render(<FirstMessageStep onComplete={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByText('Search the web for the latest news on AI')).toBeInTheDocument();
    expect(screen.getByText('Summarize a file on my computer')).toBeInTheDocument();
    expect(screen.getByText('Set up a daily reminder')).toBeInTheDocument();
    expect(screen.getByText('Help me brainstorm ideas')).toBeInTheDocument();
  });

  it('should call onComplete with prompt text when starter prompt is clicked', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();

    mockApiPut.mockResolvedValueOnce({ key: 'onboarding_completed', value: 'true' });

    render(<FirstMessageStep onComplete={onComplete} onBack={vi.fn()} />);

    await user.click(screen.getByText('Help me brainstorm ideas'));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith('Help me brainstorm ideas');
    });
  });

  it('should call onComplete without prompt when Get started is clicked', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();

    mockApiPut.mockResolvedValueOnce({ key: 'onboarding_completed', value: 'true' });

    render(<FirstMessageStep onComplete={onComplete} onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Get started' }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(undefined);
    });
  });

  it('should set onboarding_completed config', async () => {
    const user = userEvent.setup();

    mockApiPut.mockResolvedValueOnce({ key: 'onboarding_completed', value: 'true' });

    render(<FirstMessageStep onComplete={vi.fn()} onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Get started' }));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/config', {
        key: 'onboarding_completed',
        value: 'true',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// OnboardingWizard (integration)
// ---------------------------------------------------------------------------

describe('OnboardingWizard', () => {
  it('should render the first step (password) initially', () => {
    render(<OnboardingWizard onComplete={vi.fn()} />);

    expect(screen.getByText('Create a password')).toBeInTheDocument();
    expect(screen.getByText('Meridian')).toBeInTheDocument();
  });

  it('should show all four step labels in the stepper', () => {
    render(<OnboardingWizard onComplete={vi.fn()} />);

    // "Password" appears as both stepper label and form label, so use getAllByText
    expect(screen.getAllByText('Password').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('AI Provider')).toBeInTheDocument();
    expect(screen.getByText('Preferences')).toBeInTheDocument();
    // "Get Started" is both a stepper label and used in the last step
    expect(screen.getByText('Get Started')).toBeInTheDocument();
  });

  it('should navigate to AI key step after password completion', async () => {
    const user = userEvent.setup();

    mockApiPost
      .mockResolvedValueOnce({ message: 'Password configured' })
      .mockResolvedValueOnce({
        sessionId: 'sess-1',
        csrfToken: 'csrf-123',
        expiresAt: '2026-12-31',
      });

    render(<OnboardingWizard onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'MyStr0ng!');
    await user.type(screen.getByLabelText('Confirm password'), 'MyStr0ng!');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(screen.getByText('Connect an AI provider')).toBeInTheDocument();
    });
  });
});
