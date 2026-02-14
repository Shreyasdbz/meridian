// TOTP settings section — setup and management UI (Phase 11.3).

import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/button.js';
import { Card, CardHeader } from '../../components/card.js';
import { Input } from '../../components/input.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TOTPState = 'loading' | 'disabled' | 'setup' | 'verify' | 'show_backup' | 'enabled';

interface SetupResponse {
  otpauthUri: string;
  secret: string;
  backupCodes: string[];
}

interface StatusResponse {
  enabled: boolean;
}

interface VerifyResponse {
  enabled: boolean;
}

interface DisableResponse {
  disabled: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TOTPSection(): React.ReactElement {
  const [state, setState] = useState<TOTPState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<SetupResponse | null>(null);
  const [verifyToken, setVerifyToken] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch TOTP status on mount
  useEffect(() => {
    void checkStatus();
  }, []);

  const checkStatus = async (): Promise<void> => {
    try {
      const result = await api.get<StatusResponse>('/auth/totp/status');
      setState(result.enabled ? 'enabled' : 'disabled');
    } catch {
      setState('disabled');
    }
  };

  // Step 1: Start setup
  const handleSetup = useCallback(async (): Promise<void> => {
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await api.post<SetupResponse>('/auth/totp/setup');
      setSetupData(result);
      setState('setup');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start TOTP setup';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  // Step 2: Move to verification
  const handleProceedToVerify = useCallback(() => {
    setState('verify');
    setVerifyToken('');
    setError(null);
  }, []);

  // Step 3: Verify TOTP token
  const handleVerify = useCallback(async (): Promise<void> => {
    if (verifyToken.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const result = await api.post<VerifyResponse>('/auth/totp/verify', {
        token: verifyToken,
      });

      if (result.enabled) {
        setState('show_backup');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [verifyToken]);

  // Finish setup
  const handleFinish = useCallback(() => {
    setState('enabled');
    setSetupData(null);
  }, []);

  // Disable TOTP
  const handleDisable = useCallback(async (): Promise<void> => {
    if (!disablePassword) {
      setError('Password is required to disable TOTP');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await api.delete<DisableResponse>('/auth/totp');
      // Since api.delete doesn't support body, use fetch directly
    } catch {
      // Fall through to fetch-based approach
    }

    try {
      const csrfToken = document.cookie
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('csrf='))
        ?.split('=')[1];

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch('/api/auth/totp', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ password: disablePassword }),
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Failed to disable TOTP');
      }

      setState('disabled');
      setDisablePassword('');
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to disable TOTP';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [disablePassword]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (state === 'loading') {
    return (
      <Card>
        <CardHeader
          title="Two-Factor Authentication"
          description="Loading TOTP status..."
        />
        <div className="mt-4 flex justify-center">
          <Spinner size="sm" />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Two-Factor Authentication"
        description="Add an extra layer of security with a time-based one-time password (TOTP)."
      />

      <div className="mt-4 space-y-4">
        {/* Error banner */}
        {error && (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
            role="alert"
            data-testid="totp-error"
          >
            {error}
          </div>
        )}

        {/* State: TOTP disabled — show enable button */}
        {state === 'disabled' && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void handleSetup(); }}
            disabled={isSubmitting}
            data-testid="totp-enable-button"
          >
            {isSubmitting ? 'Setting up...' : 'Enable Two-Factor Authentication'}
          </Button>
        )}

        {/* State: Setup — show URI and secret */}
        {state === 'setup' && setupData && (
          <div className="space-y-4" data-testid="totp-setup">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Scan this QR code with your authenticator app, or manually enter the secret key below.
            </p>

            {/* Secret key display */}
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Secret Key (enter manually)
              </p>
              <p
                className="mt-1 select-all break-all font-mono text-sm text-gray-900 dark:text-gray-100"
                data-testid="totp-secret"
              >
                {setupData.secret}
              </p>
            </div>

            {/* otpauth URI for copy-paste */}
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                OTPAuth URI (for advanced setup)
              </p>
              <p
                className="mt-1 select-all break-all font-mono text-xs text-gray-700 dark:text-gray-300"
                data-testid="totp-uri"
              >
                {setupData.otpauthUri}
              </p>
            </div>

            <Button
              variant="primary"
              size="sm"
              onClick={handleProceedToVerify}
              data-testid="totp-proceed-verify"
            >
              I have added the key to my authenticator
            </Button>
          </div>
        )}

        {/* State: Verify — enter token to confirm */}
        {state === 'verify' && (
          <div className="space-y-3" data-testid="totp-verify">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Enter the 6-digit code from your authenticator app to verify setup.
            </p>

            <Input
              label="Verification Code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={verifyToken}
              onChange={(e) => {
                setVerifyToken(e.target.value.replace(/\D/g, '').slice(0, 6));
              }}
              placeholder="000000"
              autoFocus
              data-testid="totp-verify-input"
            />

            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => { void handleVerify(); }}
                disabled={isSubmitting || verifyToken.length !== 6}
                data-testid="totp-verify-button"
              >
                {isSubmitting ? 'Verifying...' : 'Verify'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setState('disabled'); setSetupData(null); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* State: Show backup codes */}
        {state === 'show_backup' && setupData && (
          <div className="space-y-4" data-testid="totp-backup-codes">
            <div
              className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-300"
              role="status"
            >
              Two-factor authentication has been enabled successfully.
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Backup Codes
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Save these backup codes in a secure location. Each code can only be used once.
              </p>
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-sm dark:border-gray-700 dark:bg-gray-800">
                {setupData.backupCodes.map((code, i) => (
                  <span
                    key={i}
                    className="text-gray-900 dark:text-gray-100"
                    data-testid={`backup-code-${String(i)}`}
                  >
                    {code}
                  </span>
                ))}
              </div>
            </div>

            <Button
              variant="primary"
              size="sm"
              onClick={handleFinish}
              data-testid="totp-finish-button"
            >
              I have saved my backup codes
            </Button>
          </div>
        )}

        {/* State: TOTP enabled — show disable option */}
        {state === 'enabled' && (
          <div className="space-y-3" data-testid="totp-enabled">
            <div
              className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-300"
              role="status"
            >
              Two-factor authentication is enabled.
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400">
              To disable TOTP, enter your password below.
            </p>

            <Input
              label="Password"
              type="password"
              value={disablePassword}
              onChange={(e) => { setDisablePassword(e.target.value); }}
              placeholder="Enter your password"
              data-testid="totp-disable-password"
            />

            <Button
              variant="danger"
              size="sm"
              onClick={() => { void handleDisable(); }}
              disabled={isSubmitting || !disablePassword}
              data-testid="totp-disable-button"
            >
              {isSubmitting ? 'Disabling...' : 'Disable Two-Factor Authentication'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
