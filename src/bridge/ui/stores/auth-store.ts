import { create } from 'zustand';

interface AuthState {
  isAuthenticated: boolean;
  isSetupComplete: boolean;
  csrfToken: string | null;
  isLoading: boolean;
}

interface AuthActions {
  setAuthenticated: (authenticated: boolean) => void;
  setSetupComplete: (complete: boolean) => void;
  setCsrfToken: (token: string | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
}

type AuthStore = AuthState & AuthActions;

export const useAuthStore = create<AuthStore>((set) => ({
  isAuthenticated: false,
  isSetupComplete: false,
  csrfToken: null,
  isLoading: true,

  setAuthenticated: (authenticated) => {
    set({ isAuthenticated: authenticated });
  },

  setSetupComplete: (complete) => {
    set({ isSetupComplete: complete });
  },

  setCsrfToken: (token) => {
    set({ csrfToken: token });
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },

  logout: () => {
    set({
      isAuthenticated: false,
      csrfToken: null,
    });
  },
}));
