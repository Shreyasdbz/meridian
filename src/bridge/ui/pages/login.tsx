// @meridian/bridge/ui — Login page for returning users (Phase 7.2)

import { useState } from 'react';

import { Button } from '../components/button.js';
import { Input } from '../components/input.js';
import { Spinner } from '../components/spinner.js';
import { api, ApiRequestError } from '../hooks/use-api.js';
import { useAuthStore } from '../stores/auth-store.js';

export function LoginPage(): React.ReactElement {
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfterMs, setRetryAfterMs] = useState<number | null>(null);

  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const setCsrfToken = useAuthStore((s) => s.setCsrfToken);

  const canSubmit = password.length > 0 && !isSubmitting && retryAfterMs === null;

  const handleSubmit = async (e: React.SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);
    setRetryAfterMs(null);

    try {
      const result = await api.post<{
        sessionId: string;
        csrfToken: string;
        expiresAt: string;
      }>('/auth/login', { password });

      setCsrfToken(result.csrfToken);
      setAuthenticated(true);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 429) {
        // Rate limited — parse retryAfterMs from error
        setError('Too many attempts. Please wait before trying again.');
        // Start a countdown (default 5s if we can't parse)
        const waitMs = 5000;
        setRetryAfterMs(waitMs);
        setTimeout(() => { setRetryAfterMs(null); }, waitMs);
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-950">
      <div className="w-full max-w-sm">
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

        {/* Login form */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              Sign in
            </h2>

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); }}
              placeholder="Enter your password"
              autoFocus
              autoComplete="current-password"
            />

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}

            {retryAfterMs !== null && (
              <p className="text-sm text-yellow-600 dark:text-yellow-400">
                Please wait before trying again.
              </p>
            )}

            <Button type="submit" disabled={!canSubmit} size="lg" className="w-full">
              {isSubmitting ? <Spinner size="sm" label="Signing in..." /> : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
