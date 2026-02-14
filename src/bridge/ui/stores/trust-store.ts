import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustDecision {
  id: string;
  actionType: string;
  scope: string;
  verdict: 'allow' | 'deny';
  createdAt?: string;
  expiresAt?: string;
  conditions?: string;
  jobId?: string;
}

interface TrustState {
  decisions: TrustDecision[];
  isLoading: boolean;
  error: string | null;
}

interface TrustActions {
  setDecisions: (decisions: TrustDecision[]) => void;
  removeDecision: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

type TrustStore = TrustState & TrustActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTrustStore = create<TrustStore>((set) => ({
  decisions: [],
  isLoading: false,
  error: null,

  setDecisions: (decisions) => {
    set({ decisions, error: null });
  },

  removeDecision: (id) => {
    set((state) => ({
      decisions: state.decisions.filter((d) => d.id !== id),
    }));
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },

  setError: (error) => {
    set({ error });
  },
}));
