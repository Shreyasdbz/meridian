// @meridian/bridge/ui — Onboarding Step 1: Create Password (Phase 7.2)

import { useState } from 'react';

import { Button } from '../../components/button.js';
import { Input } from '../../components/input.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';
import { useAuthStore } from '../../stores/auth-store.js';
import { calculatePasswordStrength, type StrengthLevel } from '../../utils/password-strength.js';

interface PasswordStepProps {
  onComplete: () => void;
}

const STRENGTH_COLORS: Record<StrengthLevel, string> = {
  weak: 'bg-red-500',
  fair: 'bg-orange-500',
  good: 'bg-yellow-500',
  strong: 'bg-green-500',
};

const STRENGTH_SEGMENTS: Record<StrengthLevel, number> = {
  weak: 1,
  fair: 2,
  good: 3,
  strong: 4,
};

export function PasswordStep({ onComplete }: PasswordStepProps): React.ReactElement {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCsrfToken = useAuthStore((s) => s.setCsrfToken);
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);

  const strength = calculatePasswordStrength(password);
  const passwordsMatch = password === confirmPassword;
  const confirmError =
    confirmPassword.length > 0 && !passwordsMatch ? 'Passwords do not match' : undefined;

  const canSubmit =
    password.length >= 8 &&
    passwordsMatch &&
    confirmPassword.length > 0 &&
    strength.level !== 'weak' &&
    !isSubmitting;

  const handleSubmit = async (e: React.SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // Step 1: Create password
      await api.post('/auth/setup', { password });

      // Step 2: Auto-login
      const loginResult = await api.post<{
        sessionId: string;
        csrfToken: string;
        expiresAt: string;
      }>('/auth/login', { password });

      setCsrfToken(loginResult.csrfToken);
      setAuthenticated(true);
      onComplete();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to create password';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const filledSegments = STRENGTH_SEGMENTS[strength.level];

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Create a password
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Secure your Meridian instance. No username needed — it's just you.
        </p>
      </div>

      <div className="space-y-4">
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); }}
          placeholder="Enter a password"
          autoFocus
          autoComplete="new-password"
        />

        {/* Strength indicator */}
        {password.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {Array.from({ length: 4 }, (_, i) => (
                <div
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    i < filledSegments
                      ? STRENGTH_COLORS[strength.level]
                      : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                />
              ))}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium capitalize text-gray-600 dark:text-gray-400">
                {strength.level}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {strength.feedback}
              </span>
            </div>
          </div>
        )}

        <Input
          label="Confirm password"
          type="password"
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); }}
          placeholder="Re-enter your password"
          error={confirmError}
          autoComplete="new-password"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" disabled={!canSubmit} size="lg" className="w-full">
        {isSubmitting ? <Spinner size="sm" label="Creating password..." /> : 'Continue'}
      </Button>
    </form>
  );
}
