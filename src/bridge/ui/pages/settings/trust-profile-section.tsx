// Trust profile selector (Section 5.5.3).

import { Card, CardHeader } from '../../components/card.js';
import { type TrustProfile, useSettingsStore } from '../../stores/settings-store.js';

const PROFILES: Array<{
  id: TrustProfile;
  label: string;
  description: string;
}> = [
  {
    id: 'supervised',
    label: 'Ask me before doing anything',
    description: 'Prompt for every approval-required action. Recommended for new users or high-security environments.',
  },
  {
    id: 'balanced',
    label: 'Ask me for important stuff',
    description: 'Auto-approve low and medium risk actions. Prompt for high and critical risk.',
  },
  {
    id: 'autonomous',
    label: 'Just get it done',
    description: 'Auto-approve everything except critical risk. For power users in trusted environments.',
  },
];

export function TrustProfileSection(): React.ReactElement {
  const trustProfile = useSettingsStore((s) => s.trustProfile);
  const setTrustProfile = useSettingsStore((s) => s.setTrustProfile);
  const isSaving = useSettingsStore((s) => s.isSaving);

  return (
    <Card>
      <CardHeader
        title="Trust Level"
        description="Controls how much Meridian can do without asking you first."
      />
      <div className="mt-4 space-y-2">
        {PROFILES.map((profile) => (
          <button
            key={profile.id}
            onClick={() => { void setTrustProfile(profile.id); }}
            disabled={isSaving}
            className={`w-full rounded-lg border p-3 text-left transition-colors ${
              trustProfile === profile.id
                ? 'border-meridian-500 bg-meridian-50 dark:border-meridian-400 dark:bg-meridian-950/30'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
            }`}
            aria-pressed={trustProfile === profile.id}
          >
            <div className="flex items-center gap-2">
              <div
                className={`h-3 w-3 rounded-full border-2 ${
                  trustProfile === profile.id
                    ? 'border-meridian-500 bg-meridian-500 dark:border-meridian-400 dark:bg-meridian-400'
                    : 'border-gray-400 dark:border-gray-500'
                }`}
              />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {profile.label}
              </span>
            </div>
            <p className="mt-1 pl-5 text-xs text-gray-500 dark:text-gray-400">
              {profile.description}
            </p>
          </button>
        ))}
      </div>
    </Card>
  );
}
