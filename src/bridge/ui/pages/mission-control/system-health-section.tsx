// System Health section of Mission Control (Section 5.5.2).
// Shows connection status, resource usage, and active Gear count from GET /api/health.

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '../../components/badge.js';
import { Card } from '../../components/card.js';
import { Spinner } from '../../components/spinner.js';
import { api } from '../../hooks/use-api.js';

interface ComponentHealth {
  status: string;
  queue_depth?: number;
  provider?: string;
  memory_count?: number;
  active_sessions?: number;
}

interface HealthResponse {
  status: string;
  version: string;
  uptime_seconds: number;
  components: Record<string, ComponentHealth>;
}

interface SystemHealthSectionProps {
  connectionState?: string;
}

const HEALTH_POLL_INTERVAL_MS = 30_000;

/**
 * Displays system health information fetched from the health endpoint.
 */
export function SystemHealthSection({
  connectionState,
}: SystemHealthSectionProps): React.ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchHealth = useCallback(async (): Promise<void> => {
    try {
      const data = await api.get<HealthResponse>('/health');
      setHealth(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();

    const interval = setInterval(() => {
      void fetchHealth();
    }, HEALTH_POLL_INTERVAL_MS);

    return () => { clearInterval(interval); };
  }, [fetchHealth]);

  return (
    <section aria-label="System health">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">System Health</h2>

      {loading ? (
        <div className="mt-3 flex items-center justify-center py-4">
          <Spinner size="sm" label="Loading health status..." />
        </div>
      ) : error ? (
        <div className="mt-3">
          <Card padding="sm">
            <div className="flex items-center gap-2">
              <StatusDot status="unhealthy" />
              <span className="text-sm text-red-600 dark:text-red-400">
                Unable to reach server
              </span>
            </div>
          </Card>
        </div>
      ) : health ? (
        <div className="mt-3 space-y-2">
          {/* Overall status */}
          <Card padding="sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusDot status={health.status} />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Meridian
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <span>v{health.version}</span>
                <span>{formatUptime(health.uptime_seconds)}</span>
              </div>
            </div>
          </Card>

          {/* Connection status */}
          <Card padding="sm">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600 dark:text-gray-400">WebSocket</span>
              <Badge variant={connectionState === 'connected' ? 'success' : 'warning'}>
                {connectionState ?? 'unknown'}
              </Badge>
            </div>
          </Card>

          {/* Component statuses */}
          {Object.entries(health.components).map(([name, component]) => (
            <Card key={name} padding="sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot status={component.status} />
                  <span className="text-xs font-medium capitalize text-gray-700 dark:text-gray-300">
                    {name}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  {component.queue_depth !== undefined && (
                    <span>Queue: {component.queue_depth}</span>
                  )}
                  {component.provider && (
                    <span>{component.provider}</span>
                  )}
                  {component.memory_count !== undefined && (
                    <span>{component.memory_count} memories</span>
                  )}
                  {component.active_sessions !== undefined && (
                    <span>{component.active_sessions} session{component.active_sessions !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }): React.ReactElement {
  const colorClass = status === 'healthy'
    ? 'bg-green-500'
    : status === 'degraded'
      ? 'bg-yellow-500'
      : 'bg-red-500';

  return (
    <span className={`inline-block h-2 w-2 rounded-full ${colorClass}`} aria-label={status} />
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
