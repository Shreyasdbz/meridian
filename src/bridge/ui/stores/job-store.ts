import { create } from 'zustand';

import type { Job, JobStatus } from '@meridian/shared';

const TERMINAL_STATUSES: JobStatus[] = ['completed', 'failed', 'cancelled'];
const APPROVAL_STATUSES: JobStatus[] = ['awaiting_approval'];
const ACTIVE_STATUSES: JobStatus[] = ['pending', 'planning', 'validating', 'executing'];

interface JobState {
  activeJobs: Job[];
  pendingApprovals: Job[];
  recentCompletions: Job[];
  isLoading: boolean;
}

interface JobActions {
  setActiveJobs: (jobs: Job[]) => void;
  setPendingApprovals: (jobs: Job[]) => void;
  setRecentCompletions: (jobs: Job[]) => void;
  updateJob: (job: Job) => void;
  addJob: (job: Job) => void;
  removeJob: (jobId: string) => void;
  setLoading: (loading: boolean) => void;
}

type JobStore = JobState & JobActions;

/**
 * Categorizes a job into the correct list based on its status.
 * Returns which list the job belongs to: 'active', 'approval', 'completed', or null.
 */
function categorizeJob(status: JobStatus): 'active' | 'approval' | 'completed' | null {
  if (APPROVAL_STATUSES.includes(status)) return 'approval';
  if (TERMINAL_STATUSES.includes(status)) return 'completed';
  if (ACTIVE_STATUSES.includes(status)) return 'active';
  return null;
}

const MAX_RECENT_COMPLETIONS = 20;

export const useJobStore = create<JobStore>((set) => ({
  activeJobs: [],
  pendingApprovals: [],
  recentCompletions: [],
  isLoading: false,

  setActiveJobs: (jobs) => {
    set({ activeJobs: jobs });
  },

  setPendingApprovals: (jobs) => {
    set({ pendingApprovals: jobs });
  },

  setRecentCompletions: (jobs) => {
    set({ recentCompletions: jobs });
  },

  updateJob: (job) => {
    set((state) => {
      const category = categorizeJob(job.status);

      // Remove job from all lists first
      const activeJobs = state.activeJobs.filter((j) => j.id !== job.id);
      const pendingApprovals = state.pendingApprovals.filter((j) => j.id !== job.id);
      let recentCompletions = state.recentCompletions.filter((j) => j.id !== job.id);

      // Add to the correct list
      if (category === 'active') {
        activeJobs.push(job);
      } else if (category === 'approval') {
        pendingApprovals.push(job);
      } else if (category === 'completed') {
        recentCompletions = [job, ...recentCompletions].slice(0, MAX_RECENT_COMPLETIONS);
      }

      return { activeJobs, pendingApprovals, recentCompletions };
    });
  },

  addJob: (job) => {
    set((state) => {
      const category = categorizeJob(job.status);

      if (category === 'active') {
        return { activeJobs: [...state.activeJobs, job] };
      } else if (category === 'approval') {
        return { pendingApprovals: [...state.pendingApprovals, job] };
      } else if (category === 'completed') {
        return {
          recentCompletions: [job, ...state.recentCompletions].slice(0, MAX_RECENT_COMPLETIONS),
        };
      }
      return {};
    });
  },

  removeJob: (jobId) => {
    set((state) => ({
      activeJobs: state.activeJobs.filter((j) => j.id !== jobId),
      pendingApprovals: state.pendingApprovals.filter((j) => j.id !== jobId),
      recentCompletions: state.recentCompletions.filter((j) => j.id !== jobId),
    }));
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },
}));
