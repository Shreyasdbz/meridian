// @meridian/bridge/ui — Onboarding Step 3: Choose Comfort Level (Phase 7.2)

import { useState } from 'react';

import { Button } from '../../components/button.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';

interface ComfortLevelStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type TrustProfile = 'supervised' | 'balanced' | 'autonomous';

interface ProfileOption {
  id: TrustProfile;
  title: string;
  description: string;
  recommended?: boolean;
}

const PROFILES: ProfileOption[] = [
  {
    id: 'supervised',
    title: 'Ask me before doing anything',
    description: 'You approve every action. Best for getting to know Meridian.',
    recommended: true,
  },
  {
    id: 'balanced',
    title: 'Ask me for important stuff',
    description: 'Routine tasks run automatically. You approve anything risky.',
  },
  {
    id: 'autonomous',
    title: 'Just get it done',
    description: "Meridian handles everything. You'll see a summary after.",
  },
];

export function ComfortLevelStep({
  onComplete,
  onBack,
}: ComfortLevelStepProps): React.ReactElement {
  const [selected, setSelected] = useState<TrustProfile>('supervised');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async (): Promise<void> => {
    setIsSubmitting(true);
    setError(null);

    try {
      await api.put('/config', {
        key: 'trust_profile',
        value: selected,
      });
      onComplete();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save preference');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          How hands-on do you want to be?
        </h2>
      </div>

      <div className="space-y-3">
        {PROFILES.map((profile) => (
          <button
            key={profile.id}
            type="button"
            onClick={() => { setSelected(profile.id); }}
            className={`w-full rounded-lg border-2 p-4 text-left transition-colors ${
              selected === profile.id
                ? 'border-meridian-500 bg-meridian-500/5 dark:border-meridian-400'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  selected === profile.id
                    ? 'border-meridian-500 dark:border-meridian-400'
                    : 'border-gray-300 dark:border-gray-600'
                }`}
              >
                {selected === profile.id && (
                  <div className="h-2.5 w-2.5 rounded-full bg-meridian-500 dark:bg-meridian-400" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {profile.title}
                  </span>
                  {profile.recommended && (
                    <span className="rounded-full bg-meridian-100 px-2 py-0.5 text-xs font-medium text-meridian-700 dark:bg-meridian-900/30 dark:text-meridian-400">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {profile.description}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <Button
        type="button"
        onClick={() => void handleContinue()}
        disabled={isSubmitting}
        size="lg"
        className="w-full"
      >
        {isSubmitting ? <Spinner size="sm" label="Saving..." /> : 'Continue'}
      </Button>

      <Button type="button" variant="ghost" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
