import { create } from 'zustand';

type Theme = 'dark' | 'light' | 'system';
type ActiveView = 'chat' | 'mission-control';

interface UIState {
  theme: Theme;
  resolvedTheme: 'dark' | 'light';
  activeView: ActiveView;
  sidebarOpen: boolean;
  pendingApprovalCount: number;
  trustMode: boolean;
}

interface UIActions {
  setTheme: (theme: Theme) => void;
  setResolvedTheme: (resolved: 'dark' | 'light') => void;
  setActiveView: (view: ActiveView) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setPendingApprovalCount: (count: number) => void;
  setTrustMode: (enabled: boolean) => void;
  toggleTrustMode: () => void;
}

type UIStore = UIState & UIActions;

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function loadTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem('meridian-theme');
  if (stored === 'dark' || stored === 'light' || stored === 'system') {
    return stored;
  }
  return 'system';
}

function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') return getSystemTheme();
  return theme;
}

function loadTrustMode(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('meridian-trust-mode') === 'true';
}

export const useUIStore = create<UIStore>((set) => {
  const initialTheme = loadTheme();
  const initialResolved = resolveTheme(initialTheme);

  return {
    theme: initialTheme,
    resolvedTheme: initialResolved,
    activeView: 'chat',
    sidebarOpen: false,
    pendingApprovalCount: 0,
    trustMode: loadTrustMode(),

    setTheme: (theme) => {
      const resolved = resolveTheme(theme);
      localStorage.setItem('meridian-theme', theme);
      set({ theme, resolvedTheme: resolved });
    },

    setResolvedTheme: (resolved) => {
      set({ resolvedTheme: resolved });
    },

    setActiveView: (view) => {
      set({ activeView: view });
    },

    toggleSidebar: () => {
      set((state) => ({ sidebarOpen: !state.sidebarOpen }));
    },

    setSidebarOpen: (open) => {
      set({ sidebarOpen: open });
    },

    setPendingApprovalCount: (count) => {
      set({ pendingApprovalCount: count });
    },

    setTrustMode: (enabled) => {
      localStorage.setItem('meridian-trust-mode', String(enabled));
      set({ trustMode: enabled });
    },

    toggleTrustMode: () => {
      set((state) => {
        const next = !state.trustMode;
        localStorage.setItem('meridian-trust-mode', String(next));
        return { trustMode: next };
      });
    },
  };
});
