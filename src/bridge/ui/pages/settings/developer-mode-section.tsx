// Developer mode toggle (Section 5.5.5).
// When enabled, shows internal component names, raw plan JSON,
// message routing details, and Sentinel reasoning.

import { Card, CardHeader } from '../../components/card.js';
import { useSettingsStore } from '../../stores/settings-store.js';

export function DeveloperModeSection(): React.ReactElement {
  const developerMode = useSettingsStore((s) => s.developerMode);
  const setDeveloperMode = useSettingsStore((s) => s.setDeveloperMode);
  const isSaving = useSettingsStore((s) => s.isSaving);

  return (
    <Card>
      <CardHeader
        title="Developer Mode"
        description="Show internal details for debugging and advanced users."
      />
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {developerMode
                ? 'Showing internal component names, raw plan JSON, message routing, and safety reasoning.'
                : 'Internal details are hidden. Enable to see raw technical information.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={developerMode}
            aria-label="Toggle developer mode"
            onClick={() => { void setDeveloperMode(!developerMode); }}
            disabled={isSaving}
            className={`relative ml-4 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-meridian-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950 disabled:opacity-50 ${
              developerMode
                ? 'bg-meridian-500 dark:bg-meridian-600'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                developerMode ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {developerMode && (
          <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
              When enabled, you will see:
            </p>
            <ul className="mt-1.5 space-y-1 text-xs text-gray-500 dark:text-gray-400">
              <li className="flex items-center gap-1.5">
                <span className="text-meridian-500">*</span>
                Internal component names (Scout, Sentinel, Axis, etc.)
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-meridian-500">*</span>
                Raw execution plan JSON in approval dialogs
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-meridian-500">*</span>
                Message routing between components
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-meridian-500">*</span>
                Sentinel safety reasoning details
              </li>
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
