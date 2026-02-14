// Gear Brief store for Mission Control (Phase 11.1).
// Manages proposed Gear briefs from the workspace.

import { create } from 'zustand';

import { api } from '../hooks/use-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GearBriefContent {
  problem: string;
  proposedSolution: string;
  exampleInput: string;
  exampleOutput: string;
  manifestSkeleton?: string;
  pseudocode?: string;
}

export interface GearBriefItem {
  id: string;
  fileName: string;
  origin: string;
  createdAt: string;
  status: string;
  brief: GearBriefContent;
}

interface GearBriefListResponse {
  items: GearBriefItem[];
  total: number;
}

interface GearBriefState {
  briefs: GearBriefItem[];
  loading: boolean;
  error: string | null;
}

interface GearBriefActions {
  fetchBriefs: () => Promise<void>;
  dismissBrief: (id: string) => Promise<void>;
  refineBrief: (id: string, updates: Partial<GearBriefContent>) => Promise<void>;
  deleteBrief: (id: string) => Promise<void>;
}

type GearBriefStore = GearBriefState & GearBriefActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useGearBriefStore = create<GearBriefStore>((set, get) => ({
  briefs: [],
  loading: false,
  error: null,

  fetchBriefs: async (): Promise<void> => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<GearBriefListResponse>('/gear/briefs');
      set({ briefs: data.items, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load briefs',
        loading: false,
      });
    }
  },

  dismissBrief: async (id: string): Promise<void> => {
    try {
      await api.post(`/gear/briefs/${id}/dismiss`);
      // Update local state — change status to dismissed
      set({
        briefs: get().briefs.map((b) =>
          b.id === id ? { ...b, status: 'dismissed' } : b,
        ),
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to dismiss brief',
      });
    }
  },

  refineBrief: async (id: string, updates: Partial<GearBriefContent>): Promise<void> => {
    try {
      const response = await api.post<{ brief: GearBriefContent; status: string }>(
        `/gear/briefs/${id}/refine`,
        updates,
      );
      // Update local state with refined brief
      set({
        briefs: get().briefs.map((b) =>
          b.id === id
            ? { ...b, status: response.status, brief: response.brief }
            : b,
        ),
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to refine brief',
      });
    }
  },

  deleteBrief: async (id: string): Promise<void> => {
    try {
      await api.delete(`/gear/briefs/${id}`);
      // Remove from local state
      set({
        briefs: get().briefs.filter((b) => b.id !== id),
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete brief',
      });
    }
  },
}));
