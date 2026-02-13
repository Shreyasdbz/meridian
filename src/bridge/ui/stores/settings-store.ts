import { create } from 'zustand';

import { api } from '../hooks/use-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustProfile = 'supervised' | 'balanced' | 'autonomous';

export interface ProviderConfig {
  id: string;
  name: string;
  hasKey: boolean;
}

export type FontSize = 'small' | 'default' | 'large' | 'x-large';

interface SettingsState {
  /** Developer mode toggle (Section 5.5.5). */
  developerMode: boolean;

  /** Shell Gear enabled state (Section 5.6.5). */
  shellGearEnabled: boolean;

  /** Current trust profile (Section 5.5.3). */
  trustProfile: TrustProfile;

  /** Scout AI provider ID. */
  scoutProvider: string;

  /** Sentinel AI provider ID. */
  sentinelProvider: string;

  /** Configured provider list (names + whether key exists). */
  providers: ProviderConfig[];

  /** High contrast mode (Section 5.5.14). */
  highContrast: boolean;

  /** Configurable font size (Section 5.5.14). */
  fontSize: FontSize;

  /** Reduced motion preference (Section 5.5.14). */
  reducedMotion: boolean;

  /** Whether settings have been loaded from server. */
  isLoaded: boolean;

  /** Whether a save operation is in flight. */
  isSaving: boolean;

  /** Last save error message, if any. */
  saveError: string | null;
}

interface SettingsActions {
  /** Load settings from the server. */
  load: () => Promise<void>;

  /** Toggle developer mode and persist. */
  setDeveloperMode: (enabled: boolean) => Promise<void>;

  /** Toggle Shell Gear and persist. */
  setShellGearEnabled: (enabled: boolean) => Promise<void>;

  /** Change trust profile and persist. */
  setTrustProfile: (profile: TrustProfile) => Promise<void>;

  /** Update Scout provider and persist. */
  setScoutProvider: (providerId: string) => Promise<void>;

  /** Update Sentinel provider and persist. */
  setSentinelProvider: (providerId: string) => Promise<void>;

  /** Refresh provider list from server. */
  refreshProviders: () => Promise<void>;

  /** Toggle high contrast mode (Section 5.5.14). */
  setHighContrast: (enabled: boolean) => void;

  /** Set font size (Section 5.5.14). */
  setFontSize: (size: FontSize) => void;

  /** Toggle reduced motion (Section 5.5.14). */
  setReducedMotion: (enabled: boolean) => void;

  /** Clear save error. */
  clearError: () => void;
}

type SettingsStore = SettingsState & SettingsActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConfigResponse {
  developer_mode?: boolean;
  shell_gear_enabled?: boolean;
  trust_profile?: TrustProfile;
  scout_provider?: string;
  sentinel_provider?: string;
  high_contrast?: boolean;
  font_size?: FontSize;
  reduced_motion?: boolean;
}

interface SecretsListResponse {
  secrets: Array<{ name: string }>;
}

const KNOWN_PROVIDERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
};

function buildProviderList(secretNames: string[]): ProviderConfig[] {
  return Object.entries(KNOWN_PROVIDERS).map(([id, name]) => ({
    id,
    name,
    hasKey: secretNames.includes(`${id}_api_key`),
  }));
}

async function persistConfig(key: string, value: unknown): Promise<void> {
  await api.put('/config', { [key]: value });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Accessibility persistence helpers (client-side, localStorage)
// ---------------------------------------------------------------------------

const A11Y_STORAGE_KEY = 'meridian-accessibility';

interface A11yPrefs {
  highContrast: boolean;
  fontSize: FontSize;
  reducedMotion: boolean;
}

function loadA11yPrefs(): A11yPrefs {
  if (typeof window === 'undefined') {
    return { highContrast: false, fontSize: 'default', reducedMotion: false };
  }
  try {
    const stored = localStorage.getItem(A11Y_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<A11yPrefs>;
      return {
        highContrast: parsed.highContrast ?? false,
        fontSize: parsed.fontSize ?? 'default',
        reducedMotion: parsed.reducedMotion ?? false,
      };
    }
  } catch {
    // Malformed stored data — use defaults
  }
  return { highContrast: false, fontSize: 'default', reducedMotion: false };
}

function saveA11yPrefs(prefs: A11yPrefs): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(prefs));
}

const FONT_SIZE_MAP: Record<FontSize, string> = {
  small: '14px',
  default: '16px',
  large: '18px',
  'x-large': '20px',
};

function applyA11yToDOM(prefs: A11yPrefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  // High contrast
  if (prefs.highContrast) {
    root.classList.add('high-contrast');
  } else {
    root.classList.remove('high-contrast');
  }

  // Font size
  root.style.fontSize = FONT_SIZE_MAP[prefs.fontSize];

  // Reduced motion
  if (prefs.reducedMotion) {
    root.classList.add('reduce-motion');
  } else {
    root.classList.remove('reduce-motion');
  }
}

// Apply on load
const initialA11y = loadA11yPrefs();
applyA11yToDOM(initialA11y);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  developerMode: false,
  shellGearEnabled: false,
  trustProfile: 'supervised',
  scoutProvider: '',
  sentinelProvider: '',
  providers: [],
  highContrast: initialA11y.highContrast,
  fontSize: initialA11y.fontSize,
  reducedMotion: initialA11y.reducedMotion,
  isLoaded: false,
  isSaving: false,
  saveError: null,

  load: async () => {
    try {
      const [config, secrets] = await Promise.all([
        api.get<ConfigResponse>('/config'),
        api.get<SecretsListResponse>('/secrets'),
      ]);

      const secretNames = secrets.secrets.map((s) => s.name);

      set({
        developerMode: config.developer_mode ?? false,
        shellGearEnabled: config.shell_gear_enabled ?? false,
        trustProfile: config.trust_profile ?? 'supervised',
        scoutProvider: config.scout_provider ?? '',
        sentinelProvider: config.sentinel_provider ?? '',
        providers: buildProviderList(secretNames),
        isLoaded: true,
        saveError: null,
      });
    } catch (err) {
      set({
        isLoaded: true,
        saveError: err instanceof Error ? err.message : 'Failed to load settings',
      });
    }
  },

  setDeveloperMode: async (enabled) => {
    set({ isSaving: true, saveError: null });
    try {
      await persistConfig('developer_mode', enabled);
      set({ developerMode: enabled, isSaving: false });
    } catch (err) {
      set({
        isSaving: false,
        saveError: err instanceof Error ? err.message : 'Failed to save setting',
      });
    }
  },

  setShellGearEnabled: async (enabled) => {
    set({ isSaving: true, saveError: null });
    try {
      await persistConfig('shell_gear_enabled', enabled);
      set({ shellGearEnabled: enabled, isSaving: false });
    } catch (err) {
      set({
        isSaving: false,
        saveError: err instanceof Error ? err.message : 'Failed to save setting',
      });
    }
  },

  setTrustProfile: async (profile) => {
    set({ isSaving: true, saveError: null });
    try {
      await persistConfig('trust_profile', profile);
      set({ trustProfile: profile, isSaving: false });
    } catch (err) {
      set({
        isSaving: false,
        saveError: err instanceof Error ? err.message : 'Failed to save setting',
      });
    }
  },

  setScoutProvider: async (providerId) => {
    set({ isSaving: true, saveError: null });
    try {
      await persistConfig('scout_provider', providerId);
      set({ scoutProvider: providerId, isSaving: false });
    } catch (err) {
      set({
        isSaving: false,
        saveError: err instanceof Error ? err.message : 'Failed to save setting',
      });
    }
  },

  setSentinelProvider: async (providerId) => {
    set({ isSaving: true, saveError: null });
    try {
      await persistConfig('sentinel_provider', providerId);
      set({ sentinelProvider: providerId, isSaving: false });
    } catch (err) {
      set({
        isSaving: false,
        saveError: err instanceof Error ? err.message : 'Failed to save setting',
      });
    }
  },

  refreshProviders: async () => {
    try {
      const secrets = await api.get<SecretsListResponse>('/secrets');
      const secretNames = secrets.secrets.map((s) => s.name);
      set({ providers: buildProviderList(secretNames) });
    } catch {
      // Silently fail — provider list stays as-is
    }
  },

  setHighContrast: (enabled) => {
    set({ highContrast: enabled });
    const state = get();
    const prefs: A11yPrefs = {
      highContrast: enabled,
      fontSize: state.fontSize,
      reducedMotion: state.reducedMotion,
    };
    saveA11yPrefs(prefs);
    applyA11yToDOM(prefs);
  },

  setFontSize: (size) => {
    set({ fontSize: size });
    const state = get();
    const prefs: A11yPrefs = {
      highContrast: state.highContrast,
      fontSize: size,
      reducedMotion: state.reducedMotion,
    };
    saveA11yPrefs(prefs);
    applyA11yToDOM(prefs);
  },

  setReducedMotion: (enabled) => {
    set({ reducedMotion: enabled });
    const state = get();
    const prefs: A11yPrefs = {
      highContrast: state.highContrast,
      fontSize: state.fontSize,
      reducedMotion: enabled,
    };
    saveA11yPrefs(prefs);
    applyA11yToDOM(prefs);
  },

  clearError: () => {
    set({ saveError: null });
  },
}));
