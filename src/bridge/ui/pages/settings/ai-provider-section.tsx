// AI provider configuration section.
// Add/remove/edit API keys, select Scout and Sentinel providers.

import { useState } from 'react';

import { Button } from '../../components/button.js';
import { Card, CardHeader } from '../../components/card.js';
import { Input } from '../../components/input.js';
import { api } from '../../hooks/use-api.js';
import { useSettingsStore } from '../../stores/settings-store.js';

export function AiProviderSection(): React.ReactElement {
  const providers = useSettingsStore((s) => s.providers);
  const scoutProvider = useSettingsStore((s) => s.scoutProvider);
  const sentinelProvider = useSettingsStore((s) => s.sentinelProvider);
  const setScoutProvider = useSettingsStore((s) => s.setScoutProvider);
  const setSentinelProvider = useSettingsStore((s) => s.setSentinelProvider);
  const refreshProviders = useSettingsStore((s) => s.refreshProviders);
  const isSaving = useSettingsStore((s) => s.isSaving);

  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);

  const handleSaveKey = async (providerId: string): Promise<void> => {
    if (!keyInput.trim()) {
      setKeyError('API key is required');
      return;
    }

    setIsSavingKey(true);
    setKeyError(null);

    try {
      // Validate the key first
      await api.post('/config/validate-provider', {
        provider: providerId,
        apiKey: keyInput.trim(),
      });

      // Store the key
      await api.put(`/secrets/${providerId}_api_key`, {
        value: keyInput.trim(),
        allowedGear: [],
      });

      setEditingProvider(null);
      setKeyInput('');
      await refreshProviders();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleRemoveKey = async (providerId: string): Promise<void> => {
    try {
      await api.delete(`/secrets/${providerId}_api_key`);
      await refreshProviders();
    } catch (err) {
      useSettingsStore.setState({
        saveError: err instanceof Error ? err.message : 'Failed to remove API key',
      });
    }
  };

  return (
    <Card>
      <CardHeader
        title="AI Providers"
        description="Configure API keys for AI providers used by Meridian."
      />
      <div className="mt-4 space-y-3">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {provider.name}
                </span>
                {provider.hasKey ? (
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    Key configured
                  </span>
                ) : (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    No key
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {provider.hasKey && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { void handleRemoveKey(provider.id); }}
                    disabled={isSaving}
                  >
                    Remove
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setEditingProvider(
                      editingProvider === provider.id ? null : provider.id,
                    );
                    setKeyInput('');
                    setKeyError(null);
                  }}
                >
                  {provider.hasKey ? 'Update key' : 'Add key'}
                </Button>
              </div>
            </div>

            {/* Key input form */}
            {editingProvider === provider.id && (
              <div className="mt-3 flex gap-2">
                <div className="flex-1">
                  <Input
                    type="password"
                    placeholder={`Enter ${provider.name} API key`}
                    value={keyInput}
                    onChange={(e) => { setKeyInput(e.target.value); }}
                    error={keyError ?? undefined}
                    autoFocus
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => { void handleSaveKey(provider.id); }}
                  disabled={isSavingKey}
                  className="self-start"
                >
                  {isSavingKey ? 'Saving...' : 'Save'}
                </Button>
              </div>
            )}

            {/* Role assignment */}
            {provider.hasKey && (
              <div className="mt-2 flex gap-3">
                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                  <input
                    type="radio"
                    name="scout-provider"
                    checked={scoutProvider === provider.id}
                    onChange={() => { void setScoutProvider(provider.id); }}
                    disabled={isSaving}
                    className="text-meridian-500 focus:ring-meridian-500"
                  />
                  Use for planning
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                  <input
                    type="radio"
                    name="sentinel-provider"
                    checked={sentinelProvider === provider.id}
                    onChange={() => { void setSentinelProvider(provider.id); }}
                    disabled={isSaving}
                    className="text-meridian-500 focus:ring-meridian-500"
                  />
                  Use for safety
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
