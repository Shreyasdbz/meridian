import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostAlertLevel = 'none' | 'warning' | 'critical' | 'limit_reached';

export interface CostBreakdown {
  component: string;
  provider: string;
  model: string;
  costUsd: number;
  callCount: number;
}

export interface DailyCost {
  date: string;
  totalCostUsd: number;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  dailyLimitUsd: number;
  alertLevel: CostAlertLevel;
  breakdown: CostBreakdown[];
}

interface CostState {
  dailyCost: DailyCost | null;
  isLoading: boolean;
  error: string | null;
}

interface CostActions {
  setDailyCost: (cost: DailyCost) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

type CostStore = CostState & CostActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCostStore = create<CostStore>((set) => ({
  dailyCost: null,
  isLoading: false,
  error: null,

  setDailyCost: (cost) => {
    set({ dailyCost: cost, error: null });
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },

  setError: (error) => {
    set({ error });
  },
}));
