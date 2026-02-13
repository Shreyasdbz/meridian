// @meridian/bridge/ui — Onboarding Wizard Container (Phase 7.2)
// Four-step first-run setup: Password -> AI Key -> Comfort Level -> First Message

import { useState } from 'react';

import { AiKeyStep } from './ai-key-step.js';
import { ComfortLevelStep } from './comfort-level-step.js';
import { FirstMessageStep } from './first-message-step.js';
import { PasswordStep } from './password-step.js';

type WizardStep = 'password' | 'ai-key' | 'comfort-level' | 'first-message';

const STEPS: WizardStep[] = ['password', 'ai-key', 'comfort-level', 'first-message'];

const STEP_LABELS: Record<WizardStep, string> = {
  'password': 'Password',
  'ai-key': 'AI Provider',
  'comfort-level': 'Preferences',
  'first-message': 'Get Started',
};

interface OnboardingWizardProps {
  onComplete: (starterPrompt?: string) => void;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps): React.ReactElement {
  const [currentStep, setCurrentStep] = useState<WizardStep>('password');
  const [completedSteps, setCompletedSteps] = useState<Set<WizardStep>>(new Set());

  const currentIndex = STEPS.indexOf(currentStep);

  const goToNextStep = (): void => {
    setCompletedSteps((prev) => new Set([...prev, currentStep]));
    const nextIndex = currentIndex + 1;
    if (nextIndex < STEPS.length) {
      setCurrentStep(STEPS[nextIndex] ?? currentStep);
    }
  };

  const goToPreviousStep = (): void => {
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(STEPS[prevIndex] ?? currentStep);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-950">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-meridian-500">
            <svg
              className="h-7 w-7 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
              />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Meridian
          </h1>
        </div>

        {/* Stepper */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {STEPS.map((step, index) => {
              const isCompleted = completedSteps.has(step);
              const isCurrent = step === currentStep;
              const isPast = index < currentIndex;

              return (
                <div key={step} className="flex flex-1 items-center">
                  <div className="flex flex-col items-center">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                        isCompleted || isPast
                          ? 'bg-meridian-500 text-white'
                          : isCurrent
                            ? 'border-2 border-meridian-500 text-meridian-600 dark:text-meridian-400'
                            : 'border-2 border-gray-300 text-gray-400 dark:border-gray-600 dark:text-gray-500'
                      }`}
                    >
                      {isCompleted || isPast ? (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        String(index + 1)
                      )}
                    </div>
                    <span
                      className={`mt-1.5 text-xs ${
                        isCurrent
                          ? 'font-medium text-meridian-600 dark:text-meridian-400'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {STEP_LABELS[step]}
                    </span>
                  </div>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`mx-2 mt-[-1rem] h-0.5 flex-1 ${
                        completedSteps.has(step) || isPast
                          ? 'bg-meridian-500'
                          : 'bg-gray-200 dark:bg-gray-700'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step content card */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {currentStep === 'password' && (
            <PasswordStep onComplete={goToNextStep} />
          )}
          {currentStep === 'ai-key' && (
            <AiKeyStep onComplete={goToNextStep} onBack={goToPreviousStep} />
          )}
          {currentStep === 'comfort-level' && (
            <ComfortLevelStep onComplete={goToNextStep} onBack={goToPreviousStep} />
          )}
          {currentStep === 'first-message' && (
            <FirstMessageStep onComplete={onComplete} onBack={goToPreviousStep} />
          )}
        </div>
      </div>
    </div>
  );
}
