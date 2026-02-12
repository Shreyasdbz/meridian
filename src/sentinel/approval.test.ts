import { describe, it, expect, vi } from 'vitest';

import type {
  ExecutionPlan,
  ExecutionStep,
  Job,
  Logger,
  ValidationResult,
} from '@meridian/shared';
import { MAX_REVISION_COUNT } from '@meridian/shared';

import type {
  ApprovalResponse,
  ApprovalStepSummary,
  NeedsRevisionOutcome,
  NeedsUserApprovalOutcome,
  RejectedOutcome,
} from './approval.js';
import { processUserApproval, routeVerdict } from './approval.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Safely get an approval step summary by index, failing the test if missing. */
function getApprovalStep(
  steps: ApprovalStepSummary[],
  index: number,
): ApprovalStepSummary {
  const step = steps[index];
  expect(step).toBeDefined();
  return step as ApprovalStepSummary;
}

function createStep(overrides?: Partial<ExecutionStep>): ExecutionStep {
  return {
    id: 'step-1',
    gear: 'test-gear',
    action: 'test-action',
    parameters: {},
    riskLevel: 'low',
    ...overrides,
  };
}

function createPlan(
  steps: ExecutionStep[],
  overrides?: Partial<ExecutionPlan>,
): ExecutionPlan {
  return {
    id: 'plan-001',
    jobId: 'job-001',
    steps,
    ...overrides,
  };
}

function createJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-001',
    status: 'validating',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createValidation(
  overrides?: Partial<ValidationResult>,
): ValidationResult {
  return {
    id: 'val-001',
    planId: 'plan-001',
    verdict: 'approved',
    stepResults: [],
    overallRisk: 'low',
    ...overrides,
  };
}

interface MockLogger extends Logger {
  _warnFn: ReturnType<typeof vi.fn>;
  _infoFn: ReturnType<typeof vi.fn>;
}

function createMockLogger(): MockLogger {
  const warnFn = vi.fn();
  const infoFn = vi.fn();
  return {
    error: vi.fn(),
    warn: warnFn,
    info: infoFn,
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    close: vi.fn(),
    _warnFn: warnFn,
    _infoFn: infoFn,
  } as unknown as MockLogger;
}

// ---------------------------------------------------------------------------
// routeVerdict — approved
// ---------------------------------------------------------------------------

describe('routeVerdict — approved', () => {
  it('should return execute action with executing status', () => {
    const validation = createValidation({ verdict: 'approved' });
    const plan = createPlan([createStep()]);
    const job = createJob();
    const logger = createMockLogger();

    const outcome = routeVerdict(validation, plan, job, logger);

    expect(outcome.action).toBe('execute');
    expect(outcome.jobStatus).toBe('executing');
  });

  it('should log approval with plan details', () => {
    const validation = createValidation({
      verdict: 'approved',
      overallRisk: 'low',
    });
    const plan = createPlan([createStep()]);
    const logger = createMockLogger();

    routeVerdict(validation, plan, createJob(), logger);

    expect(logger._infoFn).toHaveBeenCalledWith(
      'Plan approved, transitioning to execution',
      expect.objectContaining({
        planId: 'plan-001',
        overallRisk: 'low',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// routeVerdict — needs_revision
// ---------------------------------------------------------------------------

describe('routeVerdict — needs_revision', () => {
  it('should return revise action with planning status', () => {
    const validation = createValidation({
      verdict: 'needs_revision',
      suggestedRevisions: 'Remove shell step',
    });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: 0 });
    const logger = createMockLogger();

    const outcome = routeVerdict(validation, plan, job, logger);

    expect(outcome.action).toBe('revise');
    expect(outcome.jobStatus).toBe('planning');
  });

  it('should increment revision count', () => {
    const validation = createValidation({ verdict: 'needs_revision' });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: 1 });

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as NeedsRevisionOutcome;

    expect(outcome.revisionCount).toBe(2);
  });

  it('should start revision count from 1 when undefined', () => {
    const validation = createValidation({ verdict: 'needs_revision' });
    const plan = createPlan([createStep()]);
    const job = createJob(); // revisionCount undefined

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as NeedsRevisionOutcome;

    expect(outcome.revisionCount).toBe(1);
  });

  it('should include suggested revisions in outcome', () => {
    const validation = createValidation({
      verdict: 'needs_revision',
      suggestedRevisions: 'Use workspace path for file operations',
    });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: 0 });

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as NeedsRevisionOutcome;

    expect(outcome.suggestedRevisions).toBe(
      'Use workspace path for file operations',
    );
  });

  it('should reject when revision count reaches MAX_REVISION_COUNT', () => {
    const validation = createValidation({
      verdict: 'needs_revision',
      suggestedRevisions: 'Fix permissions',
    });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: MAX_REVISION_COUNT });

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.action).toBe('reject');
    expect(outcome.jobStatus).toBe('failed');
    expect(outcome.reason).toContain('revision limit');
    expect(outcome.reason).toContain(String(MAX_REVISION_COUNT));
  });

  it('should include last suggested revision in rejection reason', () => {
    const validation = createValidation({
      verdict: 'needs_revision',
      suggestedRevisions: 'Remove dangerous shell command',
    });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: MAX_REVISION_COUNT });

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toContain('Remove dangerous shell command');
  });

  it('should fall back to reasoning when no suggested revisions', () => {
    const validation = createValidation({
      verdict: 'needs_revision',
      reasoning: 'Plan too risky',
    });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: MAX_REVISION_COUNT });

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toContain('Plan too risky');
  });

  it('should log warning when revision limit reached', () => {
    const validation = createValidation({ verdict: 'needs_revision' });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: MAX_REVISION_COUNT });
    const logger = createMockLogger();

    routeVerdict(validation, plan, job, logger);

    expect(logger._warnFn).toHaveBeenCalledWith(
      'Revision limit reached, rejecting plan',
      expect.objectContaining({
        revisionCount: MAX_REVISION_COUNT,
        maxRevisions: MAX_REVISION_COUNT,
      }),
    );
  });

  it('should log revision info when under limit', () => {
    const validation = createValidation({
      verdict: 'needs_revision',
      suggestedRevisions: 'Fix paths',
    });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: 0 });
    const logger = createMockLogger();

    routeVerdict(validation, plan, job, logger);

    expect(logger._infoFn).toHaveBeenCalledWith(
      'Plan needs revision, returning to Scout',
      expect.objectContaining({
        revisionCount: 1,
        maxRevisions: MAX_REVISION_COUNT,
        suggestedRevisions: 'Fix paths',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// routeVerdict — needs_user_approval
// ---------------------------------------------------------------------------

describe('routeVerdict — needs_user_approval', () => {
  it('should return request_approval action with awaiting_approval status', () => {
    const step = createStep({
      id: 'step-1',
      gear: 'shell',
      action: 'execute',
      description: 'Run build script',
    });
    const validation = createValidation({
      verdict: 'needs_user_approval',
      overallRisk: 'critical',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'needs_user_approval',
          category: 'security',
          riskLevel: 'critical',
          reasoning: 'Shell execution requires approval',
        },
      ],
    });
    const plan = createPlan([step]);
    const job = createJob();

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.action).toBe('request_approval');
    expect(outcome.jobStatus).toBe('awaiting_approval');
    expect(outcome.approvalRequest).toBeDefined();
  });

  it('should build approval request with correct job and plan IDs', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
      ],
    });
    const plan = createPlan([createStep()], { id: 'plan-xyz' });
    const job = createJob({ id: 'job-xyz' });

    const outcome = routeVerdict(
      validation,
      plan,
      job,
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    const request = outcome.approvalRequest;
    expect(request.jobId).toBe('job-xyz');
    expect(request.planId).toBe('plan-xyz');
    expect(request.id).toBeDefined();
    expect(request.id.length).toBeGreaterThan(0);
  });

  it('should include per-step risk summaries', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'file-manager',
        action: 'delete',
        description: 'Delete temporary files',
      }),
      createStep({
        id: 'step-2',
        gear: 'shell',
        action: 'execute',
        description: 'Run cleanup script',
      }),
    ];
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'needs_user_approval',
          riskLevel: 'high',
          reasoning: 'File deletion requires approval',
        },
        {
          stepId: 'step-2',
          verdict: 'needs_user_approval',
          riskLevel: 'critical',
          reasoning: 'Shell execution requires approval',
        },
      ],
    });
    const plan = createPlan(steps);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    const request = outcome.approvalRequest;
    expect(request.steps).toHaveLength(2);

    const first = getApprovalStep(request.steps, 0);
    expect(first.stepId).toBe('step-1');
    expect(first.riskLevel).toBe('high');
    expect(first.gear).toBe('file-manager');
    expect(first.description).toBe('Delete temporary files');

    const second = getApprovalStep(request.steps, 1);
    expect(second.stepId).toBe('step-2');
    expect(second.riskLevel).toBe('critical');
  });

  it('should generate a plain-language summary', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'shell',
        action: 'execute',
        description: 'Run build',
      }),
    ];
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'needs_user_approval',
          riskLevel: 'critical',
        },
      ],
    });
    const plan = createPlan(steps);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.approvalRequest.summary).toContain('1 step');
    expect(outcome.approvalRequest.summary).toContain('approval');
  });

  it('should include overall risk in approval request', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      overallRisk: 'high',
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
      ],
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.approvalRequest.overallRisk).toBe('high');
  });

  it('should include validation reasoning in summary when present', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      reasoning: 'Composite risks detected: credential exfiltration',
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
      ],
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.approvalRequest.summary).toContain(
      'Composite risks detected',
    );
  });

  it('should fall back to gear:action when step has no description', () => {
    const steps = [
      createStep({
        id: 'step-1',
        gear: 'web-fetch',
        action: 'post-data',
        // no description
      }),
    ];
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
      ],
    });
    const plan = createPlan(steps);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    const step = getApprovalStep(outcome.approvalRequest.steps, 0);
    expect(step.description).toBe('web-fetch:post-data');
  });

  it('should log approval request details', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      overallRisk: 'high',
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
        { stepId: 'step-2', verdict: 'approved' },
      ],
    });
    const plan = createPlan([
      createStep({ id: 'step-1' }),
      createStep({ id: 'step-2' }),
    ]);
    const logger = createMockLogger();

    routeVerdict(validation, plan, createJob(), logger);

    expect(logger._infoFn).toHaveBeenCalledWith(
      'Plan requires user approval',
      expect.objectContaining({
        planId: 'plan-001',
        overallRisk: 'high',
        stepsNeedingApproval: ['step-1'],
      }),
    );
  });

  it('should pass through validation metadata', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
      ],
      metadata: { divergences: [{ stepId: 'step-1', difference: 2 }] },
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.approvalRequest.metadata).toEqual({
      divergences: [{ stepId: 'step-1', difference: 2 }],
    });
  });
});

// ---------------------------------------------------------------------------
// routeVerdict — rejected
// ---------------------------------------------------------------------------

describe('routeVerdict — rejected', () => {
  it('should return reject action with failed status', () => {
    const validation = createValidation({
      verdict: 'rejected',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'rejected',
          reasoning: 'Transaction exceeds limit',
        },
      ],
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.action).toBe('reject');
    expect(outcome.jobStatus).toBe('failed');
  });

  it('should include rejection reasons from step results', () => {
    const validation = createValidation({
      verdict: 'rejected',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'rejected',
          category: 'financial',
          reasoning: 'Amount exceeds hard limit',
        },
      ],
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toContain('financial');
    expect(outcome.reason).toContain('Amount exceeds hard limit');
    expect(outcome.reason).toContain('step-1');
  });

  it('should combine multiple rejection reasons', () => {
    const validation = createValidation({
      verdict: 'rejected',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'rejected',
          reasoning: 'Exceeds limit',
        },
        {
          stepId: 'step-2',
          verdict: 'rejected',
          reasoning: 'Blocked domain',
        },
      ],
    });
    const plan = createPlan([
      createStep({ id: 'step-1' }),
      createStep({ id: 'step-2' }),
    ]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toContain('Exceeds limit');
    expect(outcome.reason).toContain('Blocked domain');
  });

  it('should use validation reasoning when no steps are rejected', () => {
    const validation = createValidation({
      verdict: 'rejected',
      reasoning: 'Plan violates system policy',
      stepResults: [],
    });
    const plan = createPlan([]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toBe('Plan violates system policy');
  });

  it('should use fallback message when no reasoning available', () => {
    const validation = createValidation({
      verdict: 'rejected',
      stepResults: [],
    });
    const plan = createPlan([]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toBe('Plan rejected by safety validator');
  });

  it('should log rejection with details', () => {
    const validation = createValidation({
      verdict: 'rejected',
      overallRisk: 'critical',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'rejected',
          reasoning: 'Too dangerous',
        },
      ],
    });
    const plan = createPlan([createStep()]);
    const logger = createMockLogger();

    routeVerdict(validation, plan, createJob(), logger);

    expect(logger._warnFn).toHaveBeenCalledWith(
      'Plan rejected by Sentinel',
      expect.objectContaining({
        planId: 'plan-001',
        overallRisk: 'critical',
        rejectedSteps: [
          { stepId: 'step-1', reasoning: 'Too dangerous' },
        ],
      }),
    );
  });

  it('should append validation reasoning to step rejection reasons', () => {
    const validation = createValidation({
      verdict: 'rejected',
      reasoning: 'Composite risk: credential exfiltration',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'rejected',
          reasoning: 'Exceeds limit',
        },
      ],
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as RejectedOutcome;

    expect(outcome.reason).toContain('Exceeds limit');
    expect(outcome.reason).toContain('credential exfiltration');
  });
});

// ---------------------------------------------------------------------------
// processUserApproval
// ---------------------------------------------------------------------------

describe('processUserApproval', () => {
  it('should return execute action when user approves', () => {
    const response: ApprovalResponse = {
      jobId: 'job-001',
      approved: true,
    };
    const logger = createMockLogger();

    const outcome = processUserApproval(response, logger);

    expect(outcome.action).toBe('execute');
    expect(outcome.jobStatus).toBe('executing');
  });

  it('should return cancel action when user rejects', () => {
    const response: ApprovalResponse = {
      jobId: 'job-001',
      approved: false,
      reason: 'I do not want this action',
    };
    const logger = createMockLogger();

    const outcome = processUserApproval(response, logger);

    expect(outcome.action).toBe('cancel');
    expect(outcome.jobStatus).toBe('cancelled');
  });

  it('should include user-provided rejection reason', () => {
    const response: ApprovalResponse = {
      jobId: 'job-001',
      approved: false,
      reason: 'Too expensive',
    };

    const outcome = processUserApproval(response, createMockLogger());

    expect(outcome.action).toBe('cancel');
    if (outcome.action === 'cancel') {
      expect(outcome.reason).toBe('Too expensive');
    }
  });

  it('should use default reason when user rejects without reason', () => {
    const response: ApprovalResponse = {
      jobId: 'job-001',
      approved: false,
    };

    const outcome = processUserApproval(response, createMockLogger());

    expect(outcome.action).toBe('cancel');
    if (outcome.action === 'cancel') {
      expect(outcome.reason).toBe('User rejected the execution plan');
    }
  });

  it('should log user approval', () => {
    const response: ApprovalResponse = {
      jobId: 'job-001',
      approved: true,
    };
    const logger = createMockLogger();

    processUserApproval(response, logger);

    expect(logger._infoFn).toHaveBeenCalledWith(
      'User approved plan execution',
      expect.objectContaining({ jobId: 'job-001' }),
    );
  });

  it('should log user rejection with reason', () => {
    const response: ApprovalResponse = {
      jobId: 'job-001',
      approved: false,
      reason: 'Not now',
    };
    const logger = createMockLogger();

    processUserApproval(response, logger);

    expect(logger._infoFn).toHaveBeenCalledWith(
      'User rejected plan execution',
      expect.objectContaining({
        jobId: 'job-001',
        reason: 'Not now',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('routeVerdict — edge cases', () => {
  it('should handle plan with no steps in approval request', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [],
    });
    const plan = createPlan([]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.approvalRequest.steps).toHaveLength(0);
    expect(outcome.approvalRequest.summary).toContain('0 steps');
  });

  it('should handle validation result with missing optional fields', () => {
    const validation: ValidationResult = {
      id: 'val-001',
      planId: 'plan-001',
      verdict: 'approved',
      stepResults: [],
      // no overallRisk, no reasoning, no metadata
    };
    const plan = createPlan([]);
    const job = createJob();

    const outcome = routeVerdict(validation, plan, job, createMockLogger());

    expect(outcome.action).toBe('execute');
    expect(outcome.jobStatus).toBe('executing');
  });

  it('should handle step result referencing non-existent plan step', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      stepResults: [
        { stepId: 'nonexistent-step', verdict: 'needs_user_approval' },
      ],
    });
    const plan = createPlan([]); // no steps in plan

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    // Should handle gracefully with fallback values
    expect(outcome.approvalRequest.steps).toHaveLength(1);
    const step = getApprovalStep(outcome.approvalRequest.steps, 0);
    expect(step.gear).toBe('unknown');
    expect(step.action).toBe('unknown');
  });

  it('should handle revision count at exactly MAX_REVISION_COUNT - 1', () => {
    const validation = createValidation({ verdict: 'needs_revision' });
    const plan = createPlan([createStep()]);
    const job = createJob({ revisionCount: MAX_REVISION_COUNT - 1 });

    const outcome = routeVerdict(validation, plan, job, createMockLogger());

    // Should still allow one more revision
    expect(outcome.action).toBe('revise');
    expect(outcome.jobStatus).toBe('planning');
  });

  it('should handle overallRisk as undefined in approval request', () => {
    const validation = createValidation({
      verdict: 'needs_user_approval',
      overallRisk: undefined,
      stepResults: [
        { stepId: 'step-1', verdict: 'needs_user_approval' },
      ],
    });
    const plan = createPlan([createStep()]);

    const outcome = routeVerdict(
      validation,
      plan,
      createJob(),
      createMockLogger(),
    ) as NeedsUserApprovalOutcome;

    expect(outcome.approvalRequest.overallRisk).toBe('unknown');
  });
});
