// Shell Gear enable/disable toggle (Section 5.6.5).
// Shell Gear is disabled by default, exempt from auto-approval,
// and displays a persistent indicator when enabled.

import { Card, CardHeader } from '../../components/card.js';
import { useSettingsStore } from '../../stores/settings-store.js';

export function ShellGearSection(): React.ReactElement {
  const shellGearEnabled = useSettingsStore((s) => s.shellGearEnabled);
  const setShellGearEnabled = useSettingsStore((s) => s.setShellGearEnabled);
  const isSaving = useSettingsStore((s) => s.isSaving);

  return (
    <Card>
      <CardHeader
        title="Shell Access"
        description="Allow Meridian to execute shell commands on your system."
      />
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {shellGearEnabled
                ? 'Shell access is enabled. Every command still requires your approval.'
                : 'Shell access is disabled. Meridian cannot run shell commands.'}
            </p>
            {shellGearEnabled && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Shell commands always require fresh approval — they are never auto-approved regardless of trust level.
              </p>
            )}
          </div>
          <button
            role="switch"
            aria-checked={shellGearEnabled}
            aria-label="Toggle shell access"
            onClick={() => { void setShellGearEnabled(!shellGearEnabled); }}
            disabled={isSaving}
            className={`relative ml-4 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-meridian-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950 disabled:opacity-50 ${
              shellGearEnabled
                ? 'bg-amber-500 dark:bg-amber-600'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                shellGearEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </Card>
  );
}
