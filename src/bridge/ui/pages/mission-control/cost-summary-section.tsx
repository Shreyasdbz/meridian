// Cost Summary section of Mission Control (Phase 9.5).
// Displays today's LLM cost, alert level, and breakdown by component/model.

import { useCallback, useEffect } from 'react';

import { Badge } from '../../components/badge.js';
import { Card } from '../../components/card.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';
import { useCostStore } from '../../stores/cost-store.js';
import type { CostAlertLevel, DailyCost } from '../../stores/cost-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COST_POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alertBadgeVariant(
  level: CostAlertLevel,
): 'default' | 'success' | 'warning' | 'danger' {
  switch (level) {
    case 'warning':
      return 'warning';
    case 'critical':
    case 'limit_reached':
      return 'danger';
    default:
      return 'success';
  }
}

function alertLabel(level: CostAlertLevel): string {
  switch (level) {
    case 'warning':
      return 'Warning';
    case 'critical':
      return 'Critical';
    case 'limit_reached':
      return 'Limit Reached';
    default:
      return 'OK';
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function percentOfLimit(cost: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min((cost / limit) * 100, 100);
}

function progressBarColor(level: CostAlertLevel): string {
  switch (level) {
    case 'warning':
      return 'bg-yellow-500';
    case 'critical':
    case 'limit_reached':
      return 'bg-red-500';
    default:
      return 'bg-blue-500';
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Displays today's LLM cost summary with alert level and model breakdown.
 */
export function CostSummarySection(): React.ReactElement {
  const dailyCost = useCostStore((s) => s.dailyCost);
  const isLoading = useCostStore((s) => s.isLoading);
  const setDailyCost = useCostStore((s) => s.setDailyCost);
  const setLoading = useCostStore((s) => s.setLoading);

  const fetchCost = useCallback(async (): Promise<void> => {
    try {
      const data = await api.get<DailyCost>('/costs/daily');
      setDailyCost(data);
    } catch {
      // Failed to load — section will show empty state
    } finally {
      setLoading(false);
    }
  }, [setDailyCost, setLoading]);

  useEffect(() => {
    setLoading(true);
    void fetchCost();

    const interval = setInterval(() => {
      void fetchCost();
    }, COST_POLL_INTERVAL_MS);

    return () => { clearInterval(interval); };
  }, [fetchCost, setLoading]);

  return (
    <section aria-label="Cost summary">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Cost Tracking
      </h2>

      {isLoading && !dailyCost ? (
        <div className="mt-3 flex items-center justify-center py-4">
          <Spinner size="sm" label="Loading cost data..." />
        </div>
      ) : dailyCost ? (
        <div className="mt-3 space-y-2">
          {/* Today's cost summary */}
          <Card padding="sm">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {formatUsd(dailyCost.totalCostUsd)}
                </span>
                <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                  / {formatUsd(dailyCost.dailyLimitUsd)} today
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {dailyCost.callCount} call{dailyCost.callCount !== 1 ? 's' : ''}
                </span>
                <Badge variant={alertBadgeVariant(dailyCost.alertLevel)}>
                  {alertLabel(dailyCost.alertLevel)}
                </Badge>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-1.5 rounded-full transition-all ${progressBarColor(dailyCost.alertLevel)}`}
                style={{
                  width: `${String(percentOfLimit(dailyCost.totalCostUsd, dailyCost.dailyLimitUsd))}%`,
                }}
              />
            </div>
          </Card>

          {/* Breakdown by component/model */}
          {dailyCost.breakdown.length > 0 && (
            <Card padding="sm">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Breakdown
              </p>
              <div className="mt-1.5 space-y-1">
                {dailyCost.breakdown.map((entry) => (
                  <div
                    key={`${entry.component}-${entry.provider}-${entry.model}`}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-gray-700 dark:text-gray-300">
                      {entry.component}
                      <span className="mx-1 text-gray-400">/</span>
                      {entry.model}
                    </span>
                    <span className="font-mono text-gray-600 dark:text-gray-400">
                      {formatUsd(entry.costUsd)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-center dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Cost tracking unavailable
          </p>
        </div>
      )}
    </section>
  );
}
