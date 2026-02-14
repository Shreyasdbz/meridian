// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import type { Job, ExecutionStep } from '@meridian/shared';

import { ActiveTasksSection } from './active-tasks-section.js';
import { JobInspector } from './job-inspector.js';
import { PendingApprovalsSection } from './pending-approvals-section.js';
import { RecentCompletionsSection } from './recent-completions-section.js';
import { ScheduledJobsSection } from './scheduled-jobs-section.js';
import { SystemHealthSection } from './system-health-section.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('../../hooks/use-api.js', () => ({
  api: {
    get: (...args: unknown[]): unknown => mockApiGet(...args) as unknown,
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

vi.mock('../../hooks/use-websocket.js', () => ({
  useWebSocket: vi.fn(() => ({
    connectionState: 'connected',
    send: vi.fn(),
  })),
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: crypto.randomUUID(),
    status: 'executing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

// ===========================================================================
// ActiveTasksSection
// ===========================================================================

describe('ActiveTasksSection', () => {
  it('should render empty state when no active jobs', () => {
    render(<ActiveTasksSection jobs={[]} />);

    expect(screen.getByText('No active tasks')).toBeInTheDocument();
    expect(screen.getByText('Send a message to start something')).toBeInTheDocument();
  });

  it('should render active task cards', () => {
    const jobs = [
      createTestJob({
        metadata: { taskName: 'Search for weather' },
      }),
      createTestJob({
        metadata: { taskName: 'Send email' },
      }),
    ];

    render(<ActiveTasksSection jobs={jobs} />);

    expect(screen.getByText('Search for weather')).toBeInTheDocument();
    expect(screen.getByText('Send email')).toBeInTheDocument();
  });

  it('should display the job count badge', () => {
    const jobs = [
      createTestJob({ metadata: { taskName: 'Task 1' } }),
      createTestJob({ metadata: { taskName: 'Task 2' } }),
      createTestJob({ metadata: { taskName: 'Task 3' } }),
    ];

    render(<ActiveTasksSection jobs={jobs} />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('should show status label from vocabulary', () => {
    const job = createTestJob({
      status: 'planning',
      metadata: { taskName: 'Plan task' },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    // 'planning' maps to 'Thinking...' in vocabulary
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('should display progress bar when progress metadata is present', () => {
    const job = createTestJob({
      metadata: { taskName: 'Running task', progress: 65, currentStep: 'Step 2 of 3' },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    expect(screen.getByText('65%')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });

  it('should not display progress bar when no progress metadata', () => {
    const job = createTestJob({
      metadata: { taskName: 'Waiting task' },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    expect(screen.queryByText('%')).not.toBeInTheDocument();
  });

  it('should render cancel button for each task', () => {
    const job = createTestJob({
      metadata: { taskName: 'Cancellable task' },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    expect(screen.getByRole('button', { name: /cancel task/i })).toBeInTheDocument();
  });

  it('should call cancel API when cancel button is clicked', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce(undefined);
    const job = createTestJob({
      metadata: { taskName: 'Task to cancel' },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    await user.click(screen.getByRole('button', { name: /cancel task/i }));

    expect(mockApiPost).toHaveBeenCalledWith(`/jobs/${job.id}/cancel`);
  });

  it('should show collapsible step tracker when plan has steps', async () => {
    const user = userEvent.setup();
    const steps = [
      createTestStep({ description: 'Fetch data' }),
      createTestStep({ description: 'Process results' }),
    ];

    const job = createTestJob({
      metadata: { taskName: 'Multi-step task' },
      plan: {
        id: 'plan-1',
        jobId: 'job-1',
        steps,
      },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    // Steps should be collapsed by default
    expect(screen.getByText('Show steps (2)')).toBeInTheDocument();
    expect(screen.queryByText('Fetch data')).not.toBeInTheDocument();

    // Expand steps
    await user.click(screen.getByText('Show steps (2)'));

    expect(screen.getByText('Fetch data')).toBeInTheDocument();
    expect(screen.getByText('Process results')).toBeInTheDocument();
    expect(screen.getByText('Hide steps')).toBeInTheDocument();
  });

  it('should display fallback task name when metadata.taskName is absent', () => {
    const job = createTestJob({ id: 'abcd1234-0000-0000-0000-000000000000' });

    render(<ActiveTasksSection jobs={[job]} />);

    expect(screen.getByText('Task abcd1234')).toBeInTheDocument();
  });

  it('should display elapsed time for active tasks', () => {
    // Create a job started 2 minutes ago
    const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
    const job = createTestJob({
      createdAt: twoMinutesAgo,
      metadata: { taskName: 'Timed task' },
    });

    render(<ActiveTasksSection jobs={[job]} />);

    // Should show elapsed time (approximately 2m 0s)
    expect(screen.getByText(/2m/)).toBeInTheDocument();
  });
});

// ===========================================================================
// PendingApprovalsSection
// ===========================================================================

describe('PendingApprovalsSection', () => {
  it('should render empty state when no pending approvals', () => {
    render(<PendingApprovalsSection jobs={[]} />);

    expect(screen.getByText('No pending approvals')).toBeInTheDocument();
  });

  it('should render approval cards with task names', () => {
    const jobs = [
      createTestJob({
        status: 'awaiting_approval',
        metadata: { taskName: 'Delete files' },
        validation: {
          id: 'v-1',
          planId: 'p-1',
          verdict: 'needs_user_approval',
          stepResults: [],
          overallRisk: 'high',
          reasoning: 'This operation deletes files permanently',
        },
      }),
    ];

    render(<PendingApprovalsSection jobs={jobs} />);

    expect(screen.getByText('Delete files')).toBeInTheDocument();
    expect(screen.getByText('This operation deletes files permanently')).toBeInTheDocument();
    expect(screen.getByText('high risk')).toBeInTheDocument();
  });

  it('should show pending approval count badge', () => {
    const jobs = [
      createTestJob({
        status: 'awaiting_approval',
        metadata: { taskName: 'Approval 1' },
      }),
      createTestJob({
        status: 'awaiting_approval',
        metadata: { taskName: 'Approval 2' },
      }),
    ];

    render(<PendingApprovalsSection jobs={jobs} />);

    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('should have Approve and Reject buttons', () => {
    const jobs = [
      createTestJob({
        status: 'awaiting_approval',
        metadata: { taskName: 'Approve me' },
      }),
    ];

    render(<PendingApprovalsSection jobs={jobs} />);

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('should call approve API when Approve button is clicked', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce(undefined);
    const job = createTestJob({
      status: 'awaiting_approval',
      metadata: { taskName: 'Approve task' },
    });

    render(<PendingApprovalsSection jobs={[job]} />);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(mockApiPost).toHaveBeenCalledWith(`/jobs/${job.id}/approve`);
  });

  it('should call reject API when Reject button is clicked', async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValueOnce(undefined);
    const job = createTestJob({
      status: 'awaiting_approval',
      metadata: { taskName: 'Reject task' },
    });

    render(<PendingApprovalsSection jobs={[job]} />);

    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(mockApiPost).toHaveBeenCalledWith(`/jobs/${job.id}/reject`);
  });

  it('should display plan steps with risk levels', () => {
    const job = createTestJob({
      status: 'awaiting_approval',
      metadata: { taskName: 'Risky operation' },
      plan: {
        id: 'plan-1',
        jobId: 'job-1',
        steps: [
          createTestStep({ description: 'Read config', riskLevel: 'low' }),
          createTestStep({ description: 'Delete backup', riskLevel: 'high' }),
        ],
      },
    });

    render(<PendingApprovalsSection jobs={[job]} />);

    expect(screen.getByText('Read config')).toBeInTheDocument();
    expect(screen.getByText('Delete backup')).toBeInTheDocument();
    expect(screen.getByText('low')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
  });

  it('should render highlighted border for approval cards', () => {
    const job = createTestJob({
      status: 'awaiting_approval',
      metadata: { taskName: 'Highlighted task' },
    });

    const { container } = render(<PendingApprovalsSection jobs={[job]} />);

    // The Card component should have yellow border
    const card = container.querySelector('.border-yellow-300');
    expect(card).toBeInTheDocument();
  });
});

// ===========================================================================
// RecentCompletionsSection
// ===========================================================================

describe('RecentCompletionsSection', () => {
  it('should render empty state when no completions', () => {
    render(<RecentCompletionsSection jobs={[]} />);

    expect(screen.getByText('No completed tasks yet')).toBeInTheDocument();
  });

  it('should render completed task with success badge', () => {
    const job = createTestJob({
      status: 'completed',
      metadata: { taskName: 'Finished task' },
      completedAt: new Date().toISOString(),
    });

    render(<RecentCompletionsSection jobs={[job]} />);

    expect(screen.getByText('Finished task')).toBeInTheDocument();
    // 'completed' maps to 'Done' in vocabulary
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('should render failed task with error badge and error message', () => {
    const job = createTestJob({
      status: 'failed',
      metadata: { taskName: 'Failed task' },
      error: { code: 'TIMEOUT', message: 'Operation timed out', retriable: true },
    });

    render(<RecentCompletionsSection jobs={[job]} />);

    expect(screen.getByText('Failed task')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Operation timed out')).toBeInTheDocument();
  });

  it('should render cancelled task with default badge', () => {
    const job = createTestJob({
      status: 'cancelled',
      metadata: { taskName: 'Cancelled task' },
    });

    render(<RecentCompletionsSection jobs={[job]} />);

    expect(screen.getByText('Cancelled task')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('should show relative completion time', () => {
    const job = createTestJob({
      status: 'completed',
      metadata: { taskName: 'Recent task' },
      completedAt: new Date().toISOString(),
    });

    render(<RecentCompletionsSection jobs={[job]} />);

    expect(screen.getByText('Just now')).toBeInTheDocument();
  });

  it('should display outcome summary from metadata', () => {
    const job = createTestJob({
      status: 'completed',
      metadata: { taskName: 'Summarized task', summary: 'Found 42 results' },
    });

    render(<RecentCompletionsSection jobs={[job]} />);

    expect(screen.getByText('Found 42 results')).toBeInTheDocument();
  });

  it('should render multiple completed jobs', () => {
    const jobs = [
      createTestJob({ status: 'completed', metadata: { taskName: 'Task A' } }),
      createTestJob({ status: 'failed', metadata: { taskName: 'Task B' } }),
      createTestJob({ status: 'cancelled', metadata: { taskName: 'Task C' } }),
    ];

    render(<RecentCompletionsSection jobs={jobs} />);

    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
    expect(screen.getByText('Task C')).toBeInTheDocument();
  });
});

// ===========================================================================
// ScheduledJobsSection
// ===========================================================================

describe('ScheduledJobsSection', () => {
  it('should render empty state when no schedules exist', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [], total: 0 });

    render(<ScheduledJobsSection />);

    expect(screen.getByText('Scheduled Jobs')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText('No scheduled jobs configured'),
      ).toBeInTheDocument();
    });
  });

  it('should render schedule rows after loading', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [
        {
          id: 'sched-1',
          name: 'Daily backup',
          cronExpression: '0 2 * * *',
          jobTemplate: {},
          enabled: true,
          lastRunAt: null,
          nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
          createdAt: '2026-02-14T00:00:00.000Z',
        },
      ],
      total: 1,
    });

    render(<ScheduledJobsSection />);

    await waitFor(() => {
      expect(screen.getByText('Daily backup')).toBeInTheDocument();
    });
    expect(screen.getByText('0 2 * * *')).toBeInTheDocument();
  });
});

// ===========================================================================
// SystemHealthSection
// ===========================================================================

describe('SystemHealthSection', () => {
  it('should show loading state while fetching health', () => {
    mockApiGet.mockReturnValue(new Promise(() => {})); // Never resolves

    render(<SystemHealthSection connectionState="connected" />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('should display health information after successful fetch', async () => {
    mockApiGet.mockResolvedValueOnce({
      status: 'healthy',
      version: '0.1.0',
      uptime_seconds: 3600,
      components: {
        axis: { status: 'healthy', queue_depth: 2 },
        scout: { status: 'healthy', provider: 'anthropic' },
      },
    });

    render(<SystemHealthSection connectionState="connected" />);

    await waitFor(() => {
      expect(screen.getByText('Meridian')).toBeInTheDocument();
    });

    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
    expect(screen.getByText('1h 0m')).toBeInTheDocument();
    expect(screen.getByText('axis')).toBeInTheDocument();
    expect(screen.getByText('Queue: 2')).toBeInTheDocument();
    expect(screen.getByText('scout')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
  });

  it('should show error state when health fetch fails', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('Network error'));

    render(<SystemHealthSection connectionState="disconnected" />);

    await waitFor(() => {
      expect(screen.getByText('Unable to reach server')).toBeInTheDocument();
    });
  });

  it('should display WebSocket connection state', async () => {
    mockApiGet.mockResolvedValueOnce({
      status: 'healthy',
      version: '0.1.0',
      uptime_seconds: 60,
      components: {},
    });

    render(<SystemHealthSection connectionState="connected" />);

    await waitFor(() => {
      expect(screen.getByText('connected')).toBeInTheDocument();
    });
  });

  it('should display WebSocket disconnected state', async () => {
    mockApiGet.mockResolvedValueOnce({
      status: 'healthy',
      version: '0.1.0',
      uptime_seconds: 60,
      components: {},
    });

    render(<SystemHealthSection connectionState="disconnected" />);

    await waitFor(() => {
      expect(screen.getByText('disconnected')).toBeInTheDocument();
    });
  });

  it('should display component memory count', async () => {
    mockApiGet.mockResolvedValueOnce({
      status: 'healthy',
      version: '0.1.0',
      uptime_seconds: 86400,
      components: {
        journal: { status: 'healthy', memory_count: 1234 },
      },
    });

    render(<SystemHealthSection connectionState="connected" />);

    await waitFor(() => {
      expect(screen.getByText('1234 memories')).toBeInTheDocument();
    });
  });

  it('should display active sessions count', async () => {
    mockApiGet.mockResolvedValueOnce({
      status: 'healthy',
      version: '0.1.0',
      uptime_seconds: 300,
      components: {
        bridge: { status: 'healthy', active_sessions: 1 },
      },
    });

    render(<SystemHealthSection connectionState="connected" />);

    await waitFor(() => {
      expect(screen.getByText('1 session')).toBeInTheDocument();
    });
  });

  it('should format uptime in days when applicable', async () => {
    mockApiGet.mockResolvedValueOnce({
      status: 'healthy',
      version: '0.1.0',
      uptime_seconds: 172800, // 2 days
      components: {},
    });

    render(<SystemHealthSection connectionState="connected" />);

    await waitFor(() => {
      expect(screen.getByText('2d 0h')).toBeInTheDocument();
    });
  });
});

// ===========================================================================
// Job Store (updateJob categorization)
// ===========================================================================

describe('Job Store', () => {
  // Import the real store for unit testing
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let useJobStore: typeof import('../../stores/job-store.js').useJobStore;

  beforeEach(async () => {
    // Dynamically import to get a fresh store
    vi.resetModules();
    const mod = await import('../../stores/job-store.js');
    useJobStore = mod.useJobStore;
  });

  it('should categorize updated job into active list', () => {
    const job = createTestJob({ status: 'executing' });

    act(() => {
      useJobStore.getState().updateJob(job);
    });

    const { activeJobs } = useJobStore.getState();
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]?.id).toBe(job.id);
  });

  it('should categorize updated job into approvals list', () => {
    const job = createTestJob({ status: 'awaiting_approval' });

    act(() => {
      useJobStore.getState().updateJob(job);
    });

    const { pendingApprovals } = useJobStore.getState();
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]?.id).toBe(job.id);
  });

  it('should categorize updated job into completions list', () => {
    const job = createTestJob({ status: 'completed' });

    act(() => {
      useJobStore.getState().updateJob(job);
    });

    const { recentCompletions } = useJobStore.getState();
    expect(recentCompletions).toHaveLength(1);
    expect(recentCompletions[0]?.id).toBe(job.id);
  });

  it('should move job between lists on status change', () => {
    const job = createTestJob({ status: 'executing' });

    act(() => {
      useJobStore.getState().updateJob(job);
    });

    expect(useJobStore.getState().activeJobs).toHaveLength(1);

    act(() => {
      useJobStore.getState().updateJob({ ...job, status: 'completed' });
    });

    expect(useJobStore.getState().activeJobs).toHaveLength(0);
    expect(useJobStore.getState().recentCompletions).toHaveLength(1);
  });

  it('should add a new job via addJob', () => {
    const job = createTestJob({ status: 'pending' });

    act(() => {
      useJobStore.getState().addJob(job);
    });

    expect(useJobStore.getState().activeJobs).toHaveLength(1);
  });

  it('should remove a job via removeJob', () => {
    const job = createTestJob({ status: 'executing' });

    act(() => {
      useJobStore.getState().addJob(job);
    });

    expect(useJobStore.getState().activeJobs).toHaveLength(1);

    act(() => {
      useJobStore.getState().removeJob(job.id);
    });

    expect(useJobStore.getState().activeJobs).toHaveLength(0);
  });

  it('should limit recent completions to 20', () => {
    act(() => {
      for (let i = 0; i < 25; i++) {
        useJobStore.getState().updateJob(
          createTestJob({ status: 'completed' }),
        );
      }
    });

    expect(useJobStore.getState().recentCompletions).toHaveLength(20);
  });
});

// ===========================================================================
// JobInspector
// ===========================================================================

describe('JobInspector', () => {
  // jsdom doesn't implement HTMLDialogElement.showModal/close, so we polyfill
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
  });

  it('should not fetch when jobId is null', () => {
    render(<JobInspector jobId={null} onClose={vi.fn()} />);

    // No API calls should be made when jobId is null
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('should show loading state when fetching job', async () => {
    mockApiGet.mockReturnValue(new Promise(() => {})); // never resolves

    render(<JobInspector jobId="job-123" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Loading job details...')).toBeInTheDocument();
    });
  });

  it('should render job details when loaded', async () => {
    const job = createTestJob({
      id: 'job-detail-1',
      status: 'completed',
      source: 'user',
      completedAt: new Date().toISOString(),
      plan: {
        id: 'plan-1',
        jobId: 'job-detail-1',
        steps: [
          createTestStep({ description: 'Search the web' }),
        ],
      },
      result: { answer: 'Found it' },
    });

    mockApiGet.mockImplementation((path: string) => {
      if (path === '/jobs/job-detail-1') return Promise.resolve(job);
      if (path === '/jobs/job-detail-1/explain') return Promise.reject(new Error('Not found'));
      return Promise.reject(new Error('Unknown path'));
    });

    render(<JobInspector jobId="job-detail-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });

    // Plan step should be visible
    expect(screen.getByText('Search the web')).toBeInTheDocument();
  });

  it('should render Sentinel explain data when available', async () => {
    const job = createTestJob({
      id: 'job-explain-1',
      status: 'completed',
      validation: {
        id: 'val-1',
        planId: 'plan-1',
        verdict: 'approved',
        stepResults: [],
      },
    });

    const explainData = {
      jobId: 'job-explain-1',
      verdict: 'approved',
      overallRisk: 'low',
      reasoning: 'Safe read-only operations',
      suggestedRevisions: null,
      steps: [
        {
          stepId: 'step-1',
          verdict: 'approved',
          category: 'filesystem',
          riskLevel: 'low',
          reasoning: 'Read-only file access',
        },
      ],
    };

    mockApiGet.mockImplementation((path: string) => {
      if (path === '/jobs/job-explain-1') return Promise.resolve(job);
      if (path === '/jobs/job-explain-1/explain') return Promise.resolve(explainData);
      return Promise.reject(new Error('Unknown path'));
    });

    render(<JobInspector jobId="job-explain-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Safe read-only operations')).toBeInTheDocument();
    });

    expect(screen.getByText('Read-only file access')).toBeInTheDocument();
    expect(screen.getByText('low risk')).toBeInTheDocument();
  });

  it('should show error state on fetch failure', async () => {
    mockApiGet.mockRejectedValue(new Error('Network error'));

    render(<JobInspector jobId="bad-id" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load job details')).toBeInTheDocument();
    });
  });

  it('should show replay button for terminal jobs', async () => {
    const job = createTestJob({
      id: 'job-replay-1',
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'Operation timed out', retriable: true },
    });

    mockApiGet.mockImplementation((path: string) => {
      if (path === '/jobs/job-replay-1') return Promise.resolve(job);
      if (path === '/jobs/job-replay-1/explain') return Promise.reject(new Error('Not found'));
      return Promise.reject(new Error('Unknown path'));
    });

    render(<JobInspector jobId="job-replay-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Replay')).toBeInTheDocument();
    });
  });
});
