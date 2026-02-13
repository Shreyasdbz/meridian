// @meridian/bridge/ui — Onboarding Step 2: Add AI Key (Phase 7.2)

import { useState } from 'react';

import { Button } from '../../components/button.js';
import { Input } from '../../components/input.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';

interface AiKeyStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type Provider = 'anthropic' | 'openai' | 'ollama';

type ValidationState = 'idle' | 'validating' | 'success' | 'error';

interface ProviderOption {
  id: Provider;
  name: string;
  description: string;
  requiresKey: boolean;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models',
    requiresKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models',
    requiresKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local models',
    requiresKey: false,
  },
];

export function AiKeyStep({ onComplete, onBack }: AiKeyStepProps): React.ReactElement {
  const [selectedProvider, setSelectedProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [validationState, setValidationState] = useState<ValidationState>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isStoring, setIsStoring] = useState(false);

  const currentProvider: ProviderOption = PROVIDERS.find((p) => p.id === selectedProvider) ?? { id: 'anthropic', name: 'Anthropic', description: 'Claude models', requiresKey: true };
  const needsKey = currentProvider.requiresKey;
  const canValidate = needsKey ? apiKey.trim().length > 0 : true;
  const isValidated = validationState === 'success';

  const handleValidate = async (): Promise<void> => {
    setValidationState('validating');
    setValidationError(null);

    try {
      const result = await api.post<{ valid: boolean; error?: string; model?: string }>(
        '/config/validate-provider',
        {
          provider: selectedProvider,
          ...(needsKey ? { apiKey: apiKey.trim() } : {}),
        },
      );

      if (result.valid) {
        setValidationState('success');
      } else {
        setValidationState('error');
        setValidationError(result.error ?? 'Validation failed');
      }
    } catch (err: unknown) {
      setValidationState('error');
      setValidationError(
        err instanceof Error ? err.message : 'Connection failed',
      );
    }
  };

  const handleContinue = async (): Promise<void> => {
    if (!isValidated) return;

    setIsStoring(true);
    try {
      // Store API key in secrets vault (if provider requires one)
      if (needsKey && apiKey.trim()) {
        await api.post('/secrets', {
          name: `${selectedProvider}_api_key`,
          value: apiKey.trim(),
          allowedGear: ['gear:scout'],
        });
      }

      // Store provider selection in config
      await api.put('/config', {
        key: 'ai_provider',
        value: selectedProvider,
      });

      onComplete();
    } catch (err: unknown) {
      setValidationError(
        err instanceof Error ? err.message : 'Failed to save configuration',
      );
    } finally {
      setIsStoring(false);
    }
  };

  const handleProviderChange = (provider: Provider): void => {
    setSelectedProvider(provider);
    setApiKey('');
    setValidationState('idle');
    setValidationError(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Connect an AI provider
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          One API key is all you need to get started.
        </p>
      </div>

      {/* Provider grid */}
      <div className="grid grid-cols-3 gap-3">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => { handleProviderChange(provider.id); }}
            className={`rounded-lg border-2 p-4 text-left transition-colors ${
              selectedProvider === provider.id
                ? 'border-meridian-500 bg-meridian-500/5 dark:border-meridian-400'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
            }`}
          >
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {provider.name}
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {provider.description}
            </div>
          </button>
        ))}
      </div>

      {/* API key input */}
      {needsKey && (
        <Input
          label="API key"
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (validationState !== 'idle') {
              setValidationState('idle');
              setValidationError(null);
            }
          }}
          placeholder={`Enter your ${currentProvider.name} API key`}
          autoComplete="off"
        />
      )}

      {/* Validation status */}
      {validationState === 'success' && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          API key validated successfully
        </div>
      )}

      {validationState === 'error' && validationError && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {validationError}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {!isValidated && (
          <Button
            type="button"
            onClick={() => void handleValidate()}
            disabled={!canValidate || validationState === 'validating'}
            size="lg"
            className="flex-1"
          >
            {validationState === 'validating' ? (
              <Spinner size="sm" label="Validating..." />
            ) : (
              'Validate'
            )}
          </Button>
        )}

        {isValidated && (
          <Button
            type="button"
            onClick={() => void handleContinue()}
            disabled={isStoring}
            size="lg"
            className="flex-1"
          >
            {isStoring ? <Spinner size="sm" label="Saving..." /> : 'Continue'}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <button
          type="button"
          onClick={onComplete}
          className="text-sm text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
