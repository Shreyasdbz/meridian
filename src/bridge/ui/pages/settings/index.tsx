// Settings page (Phase 7.6).
// Contains: Trust profile, Shell Gear, AI provider, session management,
// developer mode, and same-provider warning banner.

import { useEffect } from 'react';

import { Button } from '../../components/button.js';
import { useSettingsStore } from '../../stores/settings-store.js';

import { AccessibilitySection } from './accessibility-section.js';
import { AiProviderSection } from './ai-provider-section.js';
import { DeveloperModeSection } from './developer-mode-section.js';
import { NotificationSection } from './notification-section.js';
import { SameProviderWarning } from './same-provider-warning.js';
import { SessionSection } from './session-section.js';
import { ShellGearSection } from './shell-gear-section.js';
import { TOTPSection } from './totp-section.js';
import { TrustProfileSection } from './trust-profile-section.js';
import { TrustSettingsSection } from './trust-settings-section.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SettingsPageProps {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsPage({ onClose }: SettingsPageProps): React.ReactElement {
  const isLoaded = useSettingsStore((s) => s.isLoaded);
  const saveError = useSettingsStore((s) => s.saveError);
  const clearError = useSettingsStore((s) => s.clearError);
  const load = useSettingsStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close settings">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {!isLoaded ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading settings...</p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-6">
            {/* Save error banner */}
            {saveError && (
              <div
                className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30"
                role="alert"
              >
                <p className="text-sm text-red-700 dark:text-red-300">{saveError}</p>
                <button
                  onClick={clearError}
                  className="text-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Same-provider warning (Section 6.1.2) */}
            <SameProviderWarning />

            {/* Trust profile (Section 5.5.3) */}
            <TrustProfileSection />

            {/* Trust decisions — Sentinel Memory (Section 5.3.8) */}
            <TrustSettingsSection />

            {/* Shell Gear (Section 5.6.5) */}
            <ShellGearSection />

            {/* AI provider configuration */}
            <AiProviderSection />

            {/* Notifications (Section 5.5.12) */}
            <NotificationSection />

            {/* Accessibility (Section 5.5.14) */}
            <AccessibilitySection />

            {/* Developer mode (Section 5.5.5) */}
            <DeveloperModeSection />

            {/* Two-Factor Authentication (Phase 11.3) */}
            <TOTPSection />

            {/* Session management */}
            <SessionSection />
          </div>
        )}
      </div>
    </div>
  );
}
