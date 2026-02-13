// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import type { ExecutionPlan, ExecutionStep, StepValidation } from '@meridian/shared';

import type { ApprovalRequest } from '../../stores/approval-store.js';
import { useApprovalStore } from '../../stores/approval-store.js';

import { ApprovalDialog } from './approval-dialog.js';
import { RiskIndicator, getRiskLabel } from './risk-indicator.js';
import { StandingRuleBanner } from './standing-rule-banner.js';
import { StepChecklist } from './step-checklist.js';

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

// Mock auth store
const mockAuthState = {
  isAuthenticated: true,
  isSetupComplete: true,
  csrfToken: 'test-csrf',
  isLoading: false,
};

vi.mock('../../stores/auth-store.js', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mockAuthState & Record<string, unknown>) => unknown) =>
      selector({
        ...mockAuthState,
        setAuthenticated: vi.fn(),
        setSetupComplete: vi.fn(),
        setCsrfToken: vi.fn(),
        setLoading: vi.fn(),
        logout: vi.fn(),
      }),
    {
      getState: () => ({
        ...mockAuthState,
        csrfToken: 'test-csrf',
      }),
    },
  ),
}));

// Mock HTMLDialogElement methods since jsdom doesn't support them
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();

  // Reset the approval store between tests (merge, not replace, to preserve actions)
  useApprovalStore.setState({
    queue: [],
    current: null,
    detailsExpanded: false,
    reviewIndividually: false,
    stepDecisions: [],
    rejectReason: '',
    isSubmitting: false,
    standingRuleSuggestion: null,
    categoryCounts: {},
  });

  localStorage.removeItem('meridian-approval-counts');
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function createTestStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: crypto.randomUUID(),
    gear: 'web-search',
    action: 'search',
    parameters: {},
    riskLevel: 'low',
    description: 'Search the web',
    ...overrides,
  };
}

function createTestPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: crypto.randomUUID(),
    jobId: 'job-1',
    steps: [createTestStep()],
    ...overrides,
  };
}

function createTestRisk(overrides: Partial<StepValidation> = {}): StepValidation {
  return {
    stepId: 'step-1',
    verdict: 'needs_user_approval',
    riskLevel: 'medium',
    category: 'security',
    reasoning: 'This action requires your approval',
    ...overrides,
  };
}

function createTestApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const step = createTestStep({ id: 'step-1' });
  return {
    jobId: 'job-1',
    plan: createTestPlan({ steps: [step] }),
    risks: [createTestRisk({ stepId: step.id })],
    nonce: 'test-nonce-123',
    ...overrides,
  };
}

function enqueueApproval(approval: ApprovalRequest): void {
  act(() => {
    useApprovalStore.getState().enqueue(approval);
  });
}

// ===========================================================================
// RiskIndicator
// ===========================================================================

describe('RiskIndicator', () => {
  it('should render green indicator for low risk', () => {
    render(<RiskIndicator level="low" />);

    const indicator = screen.getByTestId('risk-low');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Low risk');
    expect(indicator.className).toContain('text-green');
  });

  it('should render yellow indicator for medium risk', () => {
    render(<RiskIndicator level="medium" />);

    const indicator = screen.getByTestId('risk-medium');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Medium risk');
    expect(indicator.className).toContain('text-yellow');
  });

  it('should render orange indicator for high risk', () => {
    render(<RiskIndicator level="high" />);

    const indicator = screen.getByTestId('risk-high');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('High risk');
    expect(indicator.className).toContain('text-orange');
  });

  it('should render red indicator for critical risk', () => {
    render(<RiskIndicator level="critical" />);

    const indicator = screen.getByTestId('risk-critical');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Critical risk');
    expect(indicator.className).toContain('text-red');
  });

  it('should return correct labels from getRiskLabel', () => {
    expect(getRiskLabel('low')).toBe('Low risk');
    expect(getRiskLabel('medium')).toBe('Medium risk');
    expect(getRiskLabel('high')).toBe('High risk');
    expect(getRiskLabel('critical')).toBe('Critical risk');
  });
});

// ===========================================================================
// StepChecklist
// ===========================================================================

describe('StepChecklist', () => {
  it('should render steps with descriptions and risk levels', () => {
    const steps = [
      createTestStep({ id: 's1', description: 'Read config file', riskLevel: 'low' }),
      createTestStep({ id: 's2', description: 'Delete old backups', riskLevel: 'high' }),
    ];
    const risks = [
      createTestRisk({ stepId: 's1', riskLevel: 'low' }),
      createTestRisk({ stepId: 's2', riskLevel: 'high', reasoning: 'Destructive operation' }),
    ];

    render(
      <StepChecklist
        steps={steps}
        risks={risks}
        reviewIndividually={false}
        stepDecisions={[]}
      />,
    );

    expect(screen.getByText('Read config file')).toBeInTheDocument();
    expect(screen.getByText('Delete old backups')).toBeInTheDocument();
    expect(screen.getByTestId('risk-low')).toBeInTheDocument();
    expect(screen.getByTestId('risk-high')).toBeInTheDocument();
    expect(screen.getByText('Destructive operation')).toBeInTheDocument();
  });

  it('should show step numbers', () => {
    const steps = [
      createTestStep({ id: 's1', description: 'Step one' }),
      createTestStep({ id: 's2', description: 'Step two' }),
    ];

    render(
      <StepChecklist
        steps={steps}
        risks={[]}
        reviewIndividually={false}
        stepDecisions={[]}
      />,
    );

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('should fallback to gear+action when description is missing', () => {
    const steps = [
      createTestStep({ id: 's1', gear: 'file-manager', action: 'delete', description: undefined }),
    ];

    render(
      <StepChecklist
        steps={steps}
        risks={[]}
        reviewIndividually={false}
        stepDecisions={[]}
      />,
    );

    expect(screen.getByText('Use file-manager to delete')).toBeInTheDocument();
  });

  it('should show approve/reject buttons in individual review mode', () => {
    const steps = [createTestStep({ id: 's1' })];
    const decisions = [{ stepId: 's1', verdict: 'pending' as const }];

    render(
      <StepChecklist
        steps={steps}
        risks={[]}
        reviewIndividually={true}
        stepDecisions={decisions}
        onStepVerdict={vi.fn()}
      />,
    );

    expect(screen.getByTestId('step-approve-s1')).toBeInTheDocument();
    expect(screen.getByTestId('step-reject-s1')).toBeInTheDocument();
  });

  it('should call onStepVerdict when step approve/reject is clicked', async () => {
    const user = userEvent.setup();
    const onStepVerdict = vi.fn();
    const steps = [createTestStep({ id: 's1' })];
    const decisions = [{ stepId: 's1', verdict: 'pending' as const }];

    render(
      <StepChecklist
        steps={steps}
        risks={[]}
        reviewIndividually={true}
        stepDecisions={decisions}
        onStepVerdict={onStepVerdict}
      />,
    );

    await user.click(screen.getByTestId('step-approve-s1'));
    expect(onStepVerdict).toHaveBeenCalledWith('s1', 'approved');
  });

  it('should show verdict label after step is decided', () => {
    const steps = [createTestStep({ id: 's1' })];
    const decisions = [{ stepId: 's1', verdict: 'approved' as const }];

    render(
      <StepChecklist
        steps={steps}
        risks={[]}
        reviewIndividually={true}
        stepDecisions={decisions}
      />,
    );

    expect(screen.getByTestId('step-verdict-s1')).toHaveTextContent('Approved');
    expect(screen.queryByTestId('step-approve-s1')).not.toBeInTheDocument();
  });

  it('should show tool and action info', () => {
    const steps = [createTestStep({ id: 's1', gear: 'email-sender', action: 'send' })];

    render(
      <StepChecklist
        steps={steps}
        risks={[]}
        reviewIndividually={false}
        stepDecisions={[]}
      />,
    );

    expect(screen.getByText(/email-sender/)).toBeInTheDocument();
    expect(screen.getByText(/send/)).toBeInTheDocument();
  });
});

// ===========================================================================
// StandingRuleBanner
// ===========================================================================

describe('StandingRuleBanner', () => {
  it('should render category name and suggestion text', () => {
    render(<StandingRuleBanner category="file deletion" onDismiss={vi.fn()} />);

    expect(screen.getByTestId('standing-rule-banner')).toBeInTheDocument();
    expect(screen.getByText(/file deletion/)).toBeInTheDocument();
    expect(screen.getByText(/Trust settings/)).toBeInTheDocument();
  });

  it('should call onDismiss when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<StandingRuleBanner category="network access" onDismiss={onDismiss} />);

    await user.click(screen.getByLabelText('Dismiss suggestion'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// ApprovalDialog — rendering
// ===========================================================================

describe('ApprovalDialog', () => {
  it('should not render when no approval is queued', () => {
    render(<ApprovalDialog />);

    expect(screen.queryByTestId('approval-dialog')).not.toBeInTheDocument();
  });

  it('should render when an approval is enqueued', () => {
    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    expect(screen.getByTestId('approval-dialog')).toBeInTheDocument();
    expect(screen.getByText('I need your OK before proceeding')).toBeInTheDocument();
  });

  it('should display plain-language summary from plan reasoning', () => {
    const step = createTestStep({ id: 'step-1' });
    enqueueApproval(createTestApproval({
      plan: createTestPlan({
        reasoning: 'Delete all temporary files from your home directory',
        steps: [step],
      }),
      risks: [createTestRisk({ stepId: step.id })],
    }));
    render(<ApprovalDialog />);

    expect(screen.getByTestId('approval-summary')).toHaveTextContent(
      'Delete all temporary files from your home directory',
    );
  });

  it('should display step description when no reasoning', () => {
    const step = createTestStep({ id: 'step-1', description: 'Search for weather data' });
    enqueueApproval(createTestApproval({
      plan: createTestPlan({ reasoning: undefined, steps: [step] }),
      risks: [createTestRisk({ stepId: 'step-1' })],
    }));
    render(<ApprovalDialog />);

    expect(screen.getByTestId('approval-summary')).toHaveTextContent('Search for weather data');
  });

  it('should display overall risk indicator', () => {
    const step = createTestStep({ id: 'step-1', riskLevel: 'high' });
    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps: [step] }),
      risks: [createTestRisk({ stepId: 'step-1', riskLevel: 'high' })],
    }));
    render(<ApprovalDialog />);

    // Both overall and per-step risk indicators should show 'high'
    const indicators = screen.getAllByTestId('risk-high');
    expect(indicators.length).toBeGreaterThanOrEqual(1);
  });

  it('should show highest risk level as overall risk', () => {
    const steps = [
      createTestStep({ id: 's1', riskLevel: 'low' }),
      createTestStep({ id: 's2', riskLevel: 'critical' }),
    ];
    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [
        createTestRisk({ stepId: 's1', riskLevel: 'low' }),
        createTestRisk({ stepId: 's2', riskLevel: 'critical' }),
      ],
    }));
    render(<ApprovalDialog />);

    // The overall risk should be critical (highest)
    const indicators = screen.getAllByTestId('risk-critical');
    expect(indicators.length).toBeGreaterThan(0);
  });

  it('should display step count', () => {
    const steps = [
      createTestStep({ id: 's1' }),
      createTestStep({ id: 's2' }),
      createTestStep({ id: 's3' }),
    ];
    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [],
    }));
    render(<ApprovalDialog />);

    expect(screen.getByText('3 steps')).toBeInTheDocument();
  });

  it('should display safety check attribution using vocabulary', () => {
    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    // "Safety check" is the vocabulary translation of "Sentinel"
    expect(screen.getByText(/safety check/i)).toBeInTheDocument();
  });

  it('should show task name from plan metadata', () => {
    const step = createTestStep({ id: 'step-1' });
    enqueueApproval(createTestApproval({
      plan: createTestPlan({
        metadata: { taskName: 'Delete temporary files' },
        steps: [step],
      }),
      risks: [createTestRisk({ stepId: step.id })],
    }));
    render(<ApprovalDialog />);

    expect(screen.getByText('Delete temporary files')).toBeInTheDocument();
  });
});

// ===========================================================================
// ApprovalDialog — approve/reject API calls
// ===========================================================================

describe('ApprovalDialog — API calls', () => {
  it('should call approve API with nonce when Approve is clicked', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce({});

    enqueueApproval(createTestApproval({ nonce: 'my-secure-nonce' }));
    render(<ApprovalDialog />);

    await user.click(screen.getByTestId('approve-button'));

    expect(mockApiPost).toHaveBeenCalledWith('/jobs/job-1/approve', {
      nonce: 'my-secure-nonce',
    });
  });

  it('should call reject API when Reject is clicked', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce({});

    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    await user.click(screen.getByTestId('reject-button'));

    expect(mockApiPost).toHaveBeenCalledWith('/jobs/job-1/reject', {
      reason: undefined,
    });
  });

  it('should include reject reason when provided', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce({});

    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    const reasonInput = screen.getByTestId('reject-reason-input');
    await user.type(reasonInput, 'Too risky for now');
    await user.click(screen.getByTestId('reject-button'));

    expect(mockApiPost).toHaveBeenCalledWith('/jobs/job-1/reject', {
      reason: 'Too risky for now',
    });
  });

  it('should dequeue the approval after successful approve', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce({});

    enqueueApproval(createTestApproval());
    expect(useApprovalStore.getState().current).not.toBeNull();

    render(<ApprovalDialog />);
    await user.click(screen.getByTestId('approve-button'));

    await waitFor(() => {
      expect(useApprovalStore.getState().current).toBeNull();
    });
  });

  it('should dequeue the approval after successful reject', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce({});

    enqueueApproval(createTestApproval());

    render(<ApprovalDialog />);
    await user.click(screen.getByTestId('reject-button'));

    await waitFor(() => {
      expect(useApprovalStore.getState().current).toBeNull();
    });
  });

  it('should advance to the next approval in queue', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({});

    const step2 = createTestStep({ id: 'step-2', description: 'Send email' });
    const approval1 = createTestApproval({ jobId: 'job-1' });
    const approval2 = createTestApproval({
      jobId: 'job-2',
      plan: createTestPlan({ jobId: 'job-2', steps: [step2] }),
      risks: [createTestRisk({ stepId: 'step-2' })],
      nonce: 'nonce-2',
    });

    enqueueApproval(approval1);
    enqueueApproval(approval2);

    expect(useApprovalStore.getState().queue).toHaveLength(2);

    render(<ApprovalDialog />);
    await user.click(screen.getByTestId('approve-button'));

    await waitFor(() => {
      expect(useApprovalStore.getState().current?.jobId).toBe('job-2');
    });
  });
});

// ===========================================================================
// ApprovalDialog — Details expansion
// ===========================================================================

describe('ApprovalDialog — Details', () => {
  it('should toggle details panel when Details button is clicked', async () => {
    const user = userEvent.setup();

    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    expect(screen.queryByTestId('plan-details')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('details-button'));
    expect(screen.getByTestId('plan-details')).toBeInTheDocument();

    await user.click(screen.getByTestId('details-button'));
    expect(screen.queryByTestId('plan-details')).not.toBeInTheDocument();
  });

  it('should show raw plan JSON in details', async () => {
    const user = userEvent.setup();
    const step = createTestStep({ id: 'step-1', gear: 'file-manager' });
    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps: [step] }),
      risks: [createTestRisk({ stepId: step.id })],
    }));
    render(<ApprovalDialog />);
    await user.click(screen.getByTestId('details-button'));

    const details = screen.getByTestId('plan-details');
    expect(details).toHaveTextContent('file-manager');
  });
});

// ===========================================================================
// ApprovalDialog — multi-step individual review
// ===========================================================================

describe('ApprovalDialog — individual step review', () => {
  it('should show "Review individually" button for multi-step plans', () => {
    const steps = [
      createTestStep({ id: 's1', description: 'Step 1' }),
      createTestStep({ id: 's2', description: 'Step 2' }),
    ];
    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [],
    }));
    render(<ApprovalDialog />);

    expect(screen.getByTestId('review-individually-button')).toBeInTheDocument();
  });

  it('should not show "Review individually" for single-step plans', () => {
    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    expect(screen.queryByTestId('review-individually-button')).not.toBeInTheDocument();
  });

  it('should switch to individual review mode when button is clicked', async () => {
    const user = userEvent.setup();
    const steps = [
      createTestStep({ id: 's1' }),
      createTestStep({ id: 's2' }),
    ];

    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [],
    }));
    render(<ApprovalDialog />);

    await user.click(screen.getByTestId('review-individually-button'));

    // Should show per-step approve/reject buttons
    expect(screen.getByTestId('step-approve-s1')).toBeInTheDocument();
    expect(screen.getByTestId('step-approve-s2')).toBeInTheDocument();
  });

  it('should show "Review all at once" to exit individual mode', async () => {
    const user = userEvent.setup();
    const steps = [
      createTestStep({ id: 's1' }),
      createTestStep({ id: 's2' }),
    ];

    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [],
    }));
    render(<ApprovalDialog />);

    await user.click(screen.getByTestId('review-individually-button'));
    expect(screen.getByTestId('review-all-button')).toBeInTheDocument();
  });

  it('should disable submit until all steps are decided', async () => {
    const user = userEvent.setup();
    const steps = [
      createTestStep({ id: 's1' }),
      createTestStep({ id: 's2' }),
    ];

    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [],
    }));
    render(<ApprovalDialog />);

    await user.click(screen.getByTestId('review-individually-button'));

    const submitBtn = screen.getByTestId('submit-individual-button');
    expect(submitBtn).toBeDisabled();

    // Approve first step
    await user.click(screen.getByTestId('step-approve-s1'));

    // Re-render to pick up state
    cleanup();
    render(<ApprovalDialog />);
    expect(screen.getByTestId('submit-individual-button')).toBeDisabled(); // Still one pending

    // Approve second step
    await user.click(screen.getByTestId('step-approve-s2'));

    cleanup();
    render(<ApprovalDialog />);
    expect(screen.getByTestId('submit-individual-button')).not.toBeDisabled();
  });

  it('should show "Reject" label when any step is rejected', async () => {
    const user = userEvent.setup();
    const steps = [
      createTestStep({ id: 's1' }),
      createTestStep({ id: 's2' }),
    ];

    enqueueApproval(createTestApproval({
      plan: createTestPlan({ steps }),
      risks: [],
    }));
    render(<ApprovalDialog />);

    await user.click(screen.getByTestId('review-individually-button'));
    await user.click(screen.getByTestId('step-approve-s1'));

    cleanup();
    render(<ApprovalDialog />);
    await user.click(screen.getByTestId('step-reject-s2'));

    cleanup();
    render(<ApprovalDialog />);
    expect(screen.getByTestId('submit-individual-button')).toHaveTextContent('Reject');
  });
});

// ===========================================================================
// Standing rule suggestion
// ===========================================================================

describe('Standing rule suggestion', () => {
  it('should show suggestion after N approvals of same category', () => {
    // Simulate 4 prior approvals
    act(() => {
      for (let i = 0; i < 4; i++) {
        useApprovalStore.getState().recordApproval(['security']);
      }
    });

    // 5th approval triggers the suggestion
    let result: string | null = null;
    act(() => {
      result = useApprovalStore.getState().recordApproval(['security']);
    });

    expect(result).toBe('security');
    expect(useApprovalStore.getState().standingRuleSuggestion).toBe('security');
  });

  it('should not trigger before threshold', () => {
    act(() => {
      for (let i = 0; i < 3; i++) {
        useApprovalStore.getState().recordApproval(['privacy']);
      }
    });

    expect(useApprovalStore.getState().standingRuleSuggestion).toBeNull();
  });

  it('should display the standing rule banner in the dialog', () => {
    // Trigger standing rule suggestion
    act(() => {
      for (let i = 0; i < 5; i++) {
        useApprovalStore.getState().recordApproval(['file_access']);
      }
    });

    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    expect(screen.getByTestId('standing-rule-banner')).toBeInTheDocument();
    expect(screen.getByText(/file_access/)).toBeInTheDocument();
  });

  it('should dismiss standing rule suggestion', async () => {
    const user = userEvent.setup();

    act(() => {
      for (let i = 0; i < 5; i++) {
        useApprovalStore.getState().recordApproval(['shell_exec']);
      }
    });

    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    await user.click(screen.getByLabelText('Dismiss suggestion'));
    expect(useApprovalStore.getState().standingRuleSuggestion).toBeNull();
  });
});

// ===========================================================================
// Approval store
// ===========================================================================

describe('Approval store', () => {
  it('should enqueue and dequeue approval requests', () => {
    act(() => {
      useApprovalStore.getState().enqueue(createTestApproval({ jobId: 'j1' }));
    });

    expect(useApprovalStore.getState().current?.jobId).toBe('j1');
    expect(useApprovalStore.getState().queue).toHaveLength(1);

    act(() => {
      useApprovalStore.getState().dequeue();
    });

    expect(useApprovalStore.getState().current).toBeNull();
    expect(useApprovalStore.getState().queue).toHaveLength(0);
  });

  it('should not enqueue duplicate job IDs', () => {
    act(() => {
      useApprovalStore.getState().enqueue(createTestApproval({ jobId: 'j1' }));
      useApprovalStore.getState().enqueue(createTestApproval({ jobId: 'j1' }));
    });

    expect(useApprovalStore.getState().queue).toHaveLength(1);
  });

  it('should remove a specific job from the queue', () => {
    const step2 = createTestStep({ id: 'step-2' });
    act(() => {
      useApprovalStore.getState().enqueue(createTestApproval({ jobId: 'j1' }));
      useApprovalStore.getState().enqueue(createTestApproval({
        jobId: 'j2',
        plan: createTestPlan({ steps: [step2] }),
        risks: [createTestRisk({ stepId: step2.id })],
      }));
    });

    expect(useApprovalStore.getState().queue).toHaveLength(2);

    act(() => {
      useApprovalStore.getState().removeJob('j1');
    });

    expect(useApprovalStore.getState().queue).toHaveLength(1);
    expect(useApprovalStore.getState().current?.jobId).toBe('j2');
  });

  it('should initialize step decisions when enqueuing', () => {
    const steps = [createTestStep({ id: 's1' }), createTestStep({ id: 's2' })];

    act(() => {
      useApprovalStore.getState().enqueue(
        createTestApproval({ plan: createTestPlan({ steps }) }),
      );
    });

    const decisions = useApprovalStore.getState().stepDecisions;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.verdict).toBe('pending');
    expect(decisions[1]?.verdict).toBe('pending');
  });

  it('should persist category counts in localStorage', () => {
    act(() => {
      useApprovalStore.getState().recordApproval(['test_category']);
    });

    const stored = localStorage.getItem('meridian-approval-counts');
    expect(stored).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = JSON.parse(stored!) as Record<string, number>;
    expect(parsed['test_category']).toBe(1);
  });
});

// ===========================================================================
// Vocabulary translation in dialog
// ===========================================================================

describe('Vocabulary translation', () => {
  it('should use "safety check" instead of "Sentinel"', () => {
    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    // The dialog should say "safety check" (vocabulary for sentinel)
    expect(screen.getByText(/safety check/i)).toBeInTheDocument();
    // Should NOT mention "Sentinel" directly
    const allText = document.body.textContent || '';
    expect(allText).not.toContain('Sentinel');
  });

  it('should use "I need your OK" as the dialog title', () => {
    enqueueApproval(createTestApproval());
    render(<ApprovalDialog />);

    expect(screen.getByText('I need your OK before proceeding')).toBeInTheDocument();
  });
});
