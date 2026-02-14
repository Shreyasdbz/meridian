// Trust settings section — Sentinel Memory decisions (Phase 10.3)
// Displays active trust decisions and allows deletion.

import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/button.js';
import type { TrustDecision } from '../../stores/trust-store.js';
import { useTrustStore } from '../../stores/trust-store.js';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TrustSettingsSection(): React.ReactElement {
  const decisions = useTrustStore((s) => s.decisions);
  const isLoading = useTrustStore((s) => s.isLoading);
  const error = useTrustStore((s) => s.error);
  const setDecisions = useTrustStore((s) => s.setDecisions);
  const removeDecision = useTrustStore((s) => s.removeDecision);
  const setLoading = useTrustStore((s) => s.setLoading);
  const setError = useTrustStore((s) => s.setError);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadDecisions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/trust/decisions');
      if (!response.ok) {
        throw new Error(`Failed to load decisions: ${response.status}`);
      }
      const data = (await response.json()) as { items: TrustDecision[] };
      setDecisions(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trust decisions');
    } finally {
      setLoading(false);
    }
  }, [setDecisions, setLoading, setError]);

  useEffect(() => {
    void loadDecisions();
  }, [loadDecisions]);

  const handleDelete = async (id: string): Promise<void> => {
    setDeletingId(id);
    try {
      const response = await fetch(`/api/trust/decisions/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Failed to delete decision: ${response.status}`);
      }
      removeDecision(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete decision');
    } finally {
      setDeletingId(null);
    }
  };

  const handlePrune = async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch('/api/trust/decisions/prune', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Failed to prune decisions: ${response.status}`);
      }
      await loadDecisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prune decisions');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Trust Decisions
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Sentinel Memory — remembered approval/denial decisions for auto-approval
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handlePrune()}
          disabled={isLoading}
        >
          Prune Expired
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading decisions...</p>
      ) : decisions.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No active trust decisions. Decisions are created when you approve or deny Gear actions.
        </p>
      ) : (
        <div className="space-y-2">
          {decisions.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              isDeleting={deletingId === decision.id}
              onDelete={() => void handleDelete(decision.id)}
            />
          ))}
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {decisions.length} active decision{decisions.length !== 1 ? 's' : ''}
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Decision card
// ---------------------------------------------------------------------------

interface DecisionCardProps {
  decision: TrustDecision;
  isDeleting: boolean;
  onDelete: () => void;
}

function DecisionCard({
  decision,
  isDeleting,
  onDelete,
}: DecisionCardProps): React.ReactElement {
  const verdictColor =
    decision.verdict === 'allow'
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';

  return (
    <div className="flex items-center justify-between rounded border border-gray-200 p-2 dark:border-gray-700">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${verdictColor}`}>
            {decision.verdict.toUpperCase()}
          </span>
          <span className="truncate text-sm text-gray-900 dark:text-gray-100">
            {decision.actionType}
          </span>
        </div>
        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
          {decision.scope}
        </p>
        {decision.expiresAt && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Expires: {new Date(decision.expiresAt).toLocaleDateString()}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        disabled={isDeleting}
        aria-label={`Delete decision for ${decision.actionType}`}
      >
        {isDeleting ? '...' : 'Delete'}
      </Button>
    </div>
  );
}
