// Mission Control page (Phase 7.4, Section 5.5.2).
// Spatial, status-oriented view for monitoring and managing work.
// Loads jobs from the API and subscribes to WebSocket for real-time updates.

import { useCallback, useEffect, useState } from 'react';

import type { Job, WSMessage } from '@meridian/shared';

import { api } from '../../hooks/use-api.js';
import { useWebSocket } from '../../hooks/use-websocket.js';
import { useJobStore } from '../../stores/job-store.js';
import { useUIStore } from '../../stores/ui-store.js';

import { ActiveTasksSection } from './active-tasks-section.js';
import { CostSummarySection } from './cost-summary-section.js';
import { GearBriefsSection } from './gear-briefs-section.js';
import { JobInspector } from './job-inspector.js';
import { PendingApprovalsSection } from './pending-approvals-section.js';
import { RecentCompletionsSection } from './recent-completions-section.js';
import { ScheduledJobsSection } from './scheduled-jobs-section.js';
import { SystemHealthSection } from './system-health-section.js';

interface JobsResponse {
  jobs: Job[];
  total: number;
}

/**
 * Mission Control dashboard — the spatial, status-oriented companion to the Chat view.
 * Composes five sections: Pending Approvals (top), Active Tasks, Recent Completions,
 * Scheduled Jobs (placeholder), and System Health.
 */
export function MissionControl(): React.ReactElement {
  const activeJobs = useJobStore((s) => s.activeJobs);
  const pendingApprovals = useJobStore((s) => s.pendingApprovals);
  const recentCompletions = useJobStore((s) => s.recentCompletions);
  const isLoading = useJobStore((s) => s.isLoading);
  const setActiveJobs = useJobStore((s) => s.setActiveJobs);
  const setPendingApprovals = useJobStore((s) => s.setPendingApprovals);
  const setRecentCompletions = useJobStore((s) => s.setRecentCompletions);
  const updateJob = useJobStore((s) => s.updateJob);
  const setLoading = useJobStore((s) => s.setLoading);
  const setPendingApprovalCount = useUIStore((s) => s.setPendingApprovalCount);
  const [inspectedJobId, setInspectedJobId] = useState<string | null>(null);

  // --- Load jobs on mount ---
  useEffect(() => {
    const loadJobs = async (): Promise<void> => {
      setLoading(true);
      try {
        const data = await api.get<JobsResponse>('/jobs');
        const active: Job[] = [];
        const approvals: Job[] = [];
        const completed: Job[] = [];

        for (const job of data.jobs) {
          if (job.status === 'awaiting_approval') {
            approvals.push(job);
          } else if (
            job.status === 'completed' ||
            job.status === 'failed' ||
            job.status === 'cancelled'
          ) {
            completed.push(job);
          } else {
            active.push(job);
          }
        }

        setActiveJobs(active);
        setPendingApprovals(approvals);
        setRecentCompletions(completed);
        setPendingApprovalCount(approvals.length);
      } catch {
        // Failed to load — sections will show empty state
      } finally {
        setLoading(false);
      }
    };

    void loadJobs();
  }, [setActiveJobs, setPendingApprovals, setRecentCompletions, setLoading, setPendingApprovalCount]);

  // --- WebSocket handler for job status updates ---
  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      if (msg.type === 'status' && msg.jobId) {
        // Build a partial job update from the status message
        const updatedJob: Job = {
          id: msg.jobId,
          status: msg.status,
          createdAt: '',
          updatedAt: new Date().toISOString(),
          metadata: msg.step ? { currentStep: msg.step } : undefined,
        };

        // Try to find existing job data to merge with
        const existing =
          useJobStore.getState().activeJobs.find((j) => j.id === msg.jobId) ??
          useJobStore.getState().pendingApprovals.find((j) => j.id === msg.jobId) ??
          useJobStore.getState().recentCompletions.find((j) => j.id === msg.jobId);

        if (existing) {
          updateJob({
            ...existing,
            status: msg.status,
            updatedAt: new Date().toISOString(),
            metadata: { ...existing.metadata, currentStep: msg.step },
          });
        } else {
          updateJob(updatedJob);
        }

        // Update the pending approval badge count
        const approvalCount = useJobStore.getState().pendingApprovals.length;
        setPendingApprovalCount(approvalCount);
      }

      if (msg.type === 'progress' && msg.jobId) {
        const existing =
          useJobStore.getState().activeJobs.find((j) => j.id === msg.jobId);

        if (existing) {
          updateJob({
            ...existing,
            updatedAt: new Date().toISOString(),
            metadata: {
              ...existing.metadata,
              progress: msg.percent,
              currentStep: msg.step ?? existing.metadata?.currentStep,
            },
          });
        }
      }
    },
    [updateJob, setPendingApprovalCount],
  );

  const { connectionState } = useWebSocket({ onMessage: handleWSMessage, enabled: true });

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="mission-control">
      <div className="p-4 space-y-6">
        {/* Loading state */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-gray-500 dark:text-gray-400">Loading dashboard...</div>
          </div>
        ) : (
          <>
            {/* Pending Approvals — always first, prominent placement */}
            <PendingApprovalsSection jobs={pendingApprovals} onSelectJob={setInspectedJobId} />

            {/* Active Tasks */}
            <ActiveTasksSection jobs={activeJobs} onSelectJob={setInspectedJobId} />

            {/* Recent Completions */}
            <RecentCompletionsSection jobs={recentCompletions} onSelectJob={setInspectedJobId} />

            {/* Scheduled Jobs */}
            <ScheduledJobsSection />

            {/* Cost Tracking (Phase 9.5) */}
            <CostSummarySection />

            {/* Gear Suggestions (Phase 11.1) */}
            <GearBriefsSection />

            {/* System Health */}
            <SystemHealthSection connectionState={connectionState} />

            {/* Job Inspector dialog (Section 12.4) */}
            <JobInspector
              jobId={inspectedJobId}
              onClose={() => { setInspectedJobId(null); }}
            />
          </>
        )}
      </div>
    </div>
  );
}
