import { create } from 'zustand';

import type { ExecutionPlan, StepValidation, StepValidationVerdict } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An approval request received via WebSocket. */
export interface ApprovalRequest {
  jobId: string;
  plan: ExecutionPlan;
  risks: StepValidation[];
  nonce: string;
}

/** Per-step verdict when reviewing individually. */
export interface StepDecision {
  stepId: string;
  verdict: StepValidationVerdict | 'pending';
}

// ---------------------------------------------------------------------------
// Standing rule suggestion logic (Section 5.5.3)
// ---------------------------------------------------------------------------

const STANDING_RULE_THRESHOLD = 5;
const CATEGORY_APPROVAL_STORAGE_KEY = 'meridian-approval-counts';

/** Tracks how many times a user has approved each action category. */
function loadCategoryCounts(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CATEGORY_APPROVAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveCategoryCounts(counts: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CATEGORY_APPROVAL_STORAGE_KEY, JSON.stringify(counts));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ApprovalState {
  /** Queue of pending approval requests. */
  queue: ApprovalRequest[];

  /** The currently displayed approval request (first in queue). */
  current: ApprovalRequest | null;

  /** Whether the details panel is expanded. */
  detailsExpanded: boolean;

  /** Whether individual step review mode is active. */
  reviewIndividually: boolean;

  /** Per-step decisions when reviewing individually. */
  stepDecisions: StepDecision[];

  /** Reject reason text (optional). */
  rejectReason: string;

  /** Whether an API call is in flight. */
  isSubmitting: boolean;

  /** Category that just crossed the standing rule threshold (shown once). */
  standingRuleSuggestion: string | null;

  /** Per-category approval counts. */
  categoryCounts: Record<string, number>;
}

interface ApprovalActions {
  /** Add a new approval request to the queue. */
  enqueue: (request: ApprovalRequest) => void;

  /** Remove the current request and advance to the next. */
  dequeue: () => void;

  /** Remove a specific job from the queue (e.g. when job status changes). */
  removeJob: (jobId: string) => void;

  /** Toggle details panel. */
  toggleDetails: () => void;

  /** Enter individual step review mode. */
  setReviewIndividually: (value: boolean) => void;

  /** Set a step's verdict. */
  setStepVerdict: (stepId: string, verdict: StepValidationVerdict) => void;

  /** Set the reject reason. */
  setRejectReason: (reason: string) => void;

  /** Set submitting state. */
  setSubmitting: (value: boolean) => void;

  /** Record an approval for standing-rule tracking. Returns the category if threshold crossed. */
  recordApproval: (categories: string[]) => string | null;

  /** Dismiss the standing rule suggestion. */
  dismissStandingRuleSuggestion: () => void;

  /** Reset dialog state (keep queue). */
  resetDialogState: () => void;
}

type ApprovalStore = ApprovalState & ApprovalActions;

export const useApprovalStore = create<ApprovalStore>((set, get) => ({
  queue: [],
  current: null,
  detailsExpanded: false,
  reviewIndividually: false,
  stepDecisions: [],
  rejectReason: '',
  isSubmitting: false,
  standingRuleSuggestion: null,
  categoryCounts: loadCategoryCounts(),

  enqueue: (request) => {
    set((state) => {
      // Avoid duplicates
      if (state.queue.some((r) => r.jobId === request.jobId)) {
        return {};
      }
      const newQueue = [...state.queue, request];
      const current = state.current ?? request;
      const stepDecisions = current === request
        ? request.plan.steps.map((s) => ({ stepId: s.id, verdict: 'pending' as const }))
        : state.stepDecisions;
      return { queue: newQueue, current, stepDecisions };
    });
  },

  dequeue: () => {
    set((state) => {
      const remaining = state.queue.filter((r) => r.jobId !== state.current?.jobId);
      const next = remaining[0] ?? null;
      return {
        queue: remaining,
        current: next,
        detailsExpanded: false,
        reviewIndividually: false,
        stepDecisions: next
          ? next.plan.steps.map((s) => ({ stepId: s.id, verdict: 'pending' as const }))
          : [],
        rejectReason: '',
        isSubmitting: false,
      };
    });
  },

  removeJob: (jobId) => {
    set((state) => {
      const remaining = state.queue.filter((r) => r.jobId !== jobId);
      if (state.current?.jobId === jobId) {
        const next = remaining[0] ?? null;
        return {
          queue: remaining,
          current: next,
          detailsExpanded: false,
          reviewIndividually: false,
          stepDecisions: next
            ? next.plan.steps.map((s) => ({ stepId: s.id, verdict: 'pending' as const }))
            : [],
          rejectReason: '',
          isSubmitting: false,
        };
      }
      return { queue: remaining };
    });
  },

  toggleDetails: () => {
    set((state) => ({ detailsExpanded: !state.detailsExpanded }));
  },

  setReviewIndividually: (value) => {
    const current = get().current;
    if (!current) return;
    set({
      reviewIndividually: value,
      stepDecisions: current.plan.steps.map((s) => ({
        stepId: s.id,
        verdict: 'pending' as const,
      })),
    });
  },

  setStepVerdict: (stepId, verdict) => {
    set((state) => ({
      stepDecisions: state.stepDecisions.map((d) =>
        d.stepId === stepId ? { ...d, verdict } : d,
      ),
    }));
  },

  setRejectReason: (reason) => {
    set({ rejectReason: reason });
  },

  setSubmitting: (value) => {
    set({ isSubmitting: value });
  },

  recordApproval: (categories) => {
    const counts = { ...get().categoryCounts };
    let crossedCategory: string | null = null;

    for (const category of categories) {
      const prev = counts[category] ?? 0;
      counts[category] = prev + 1;

      if (prev + 1 === STANDING_RULE_THRESHOLD && !crossedCategory) {
        crossedCategory = category;
      }
    }

    saveCategoryCounts(counts);
    set({
      categoryCounts: counts,
      standingRuleSuggestion: crossedCategory,
    });
    return crossedCategory;
  },

  dismissStandingRuleSuggestion: () => {
    set({ standingRuleSuggestion: null });
  },

  resetDialogState: () => {
    const current = get().current;
    set({
      detailsExpanded: false,
      reviewIndividually: false,
      stepDecisions: current
        ? current.plan.steps.map((s) => ({ stepId: s.id, verdict: 'pending' as const }))
        : [],
      rejectReason: '',
      isSubmitting: false,
    });
  },
}));
