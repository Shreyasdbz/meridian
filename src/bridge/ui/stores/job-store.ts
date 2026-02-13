import { create } from 'zustand';

import type { Job } from '@meridian/shared';

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
  setLoading: (loading: boolean) => void;
}

type JobStore = JobState & JobActions;

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
    set((state) => ({
      activeJobs: state.activeJobs.map((j) => (j.id === job.id ? job : j)),
      pendingApprovals: state.pendingApprovals.map((j) => (j.id === job.id ? job : j)),
      recentCompletions: state.recentCompletions.map((j) => (j.id === job.id ? job : j)),
    }));
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },
}));
