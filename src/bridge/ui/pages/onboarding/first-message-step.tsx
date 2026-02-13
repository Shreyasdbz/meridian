// @meridian/bridge/ui — Onboarding Step 4: First Message (Phase 7.2)

import { useState } from 'react';

import { Button } from '../../components/button.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';
import { useAuthStore } from '../../stores/auth-store.js';

interface FirstMessageStepProps {
  onComplete: (starterPrompt?: string) => void;
  onBack: () => void;
}

interface Capability {
  icon: React.ReactNode;
  label: string;
}

interface StarterPrompt {
  text: string;
}

const CAPABILITIES: Capability[] = [
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
    ),
    label: 'Search the web',
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
    label: 'Work with files',
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    label: 'Set reminders',
  },
  {
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
    label: 'Answer questions',
  },
];

const STARTER_PROMPTS: StarterPrompt[] = [
  { text: 'Search the web for the latest news on AI' },
  { text: 'Summarize a file on my computer' },
  { text: 'Set up a daily reminder' },
  { text: 'Help me brainstorm ideas' },
];

export function FirstMessageStep({
  onComplete,
  onBack,
}: FirstMessageStepProps): React.ReactElement {
  const [isCompleting, setIsCompleting] = useState(false);
  const setSetupComplete = useAuthStore((s) => s.setSetupComplete);

  const handleComplete = async (starterPrompt?: string): Promise<void> => {
    setIsCompleting(true);

    try {
      await api.put('/config', {
        key: 'onboarding_completed',
        value: 'true',
      });
      setSetupComplete(true);
      onComplete(starterPrompt);
    } catch {
      // Best effort — continue even if config save fails
      setSetupComplete(true);
      onComplete(starterPrompt);
    } finally {
      setIsCompleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          You're all set!
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Here's what Meridian can help you with.
        </p>
      </div>

      {/* Capabilities */}
      <div className="grid grid-cols-2 gap-3">
        {CAPABILITIES.map((cap) => (
          <div
            key={cap.label}
            className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div className="text-meridian-500">{cap.icon}</div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {cap.label}
            </span>
          </div>
        ))}
      </div>

      {/* Starter prompts */}
      <div>
        <p className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
          Try a starter prompt:
        </p>
        <div className="space-y-2">
          {STARTER_PROMPTS.map((prompt) => (
            <button
              key={prompt.text}
              type="button"
              onClick={() => void handleComplete(prompt.text)}
              disabled={isCompleting}
              className="w-full rounded-lg border border-gray-200 p-3 text-left text-sm text-gray-700 transition-colors hover:border-meridian-300 hover:bg-meridian-500/5 dark:border-gray-700 dark:text-gray-300 dark:hover:border-meridian-600 dark:hover:bg-meridian-500/5"
            >
              {prompt.text}
            </button>
          ))}
        </div>
      </div>

      <Button
        type="button"
        onClick={() => void handleComplete()}
        disabled={isCompleting}
        size="lg"
        className="w-full"
      >
        {isCompleting ? <Spinner size="sm" label="Finishing..." /> : 'Get started'}
      </Button>

      <Button type="button" variant="ghost" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
