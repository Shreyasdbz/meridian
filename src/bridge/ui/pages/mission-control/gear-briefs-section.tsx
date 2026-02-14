// Gear Briefs section of Mission Control (Phase 11.1).
// Lists proposed Gear briefs from Journal reflection with actions to dismiss, refine, or delete.

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { Spinner } from '../../components/spinner.js';
import { useGearBriefStore } from '../../stores/gear-brief-store.js';
import type { GearBriefItem } from '../../stores/gear-brief-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeVariant(
  status: string,
): 'default' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'proposed':
      return 'info';
    case 'refined':
      return 'success';
    case 'dismissed':
      return 'default';
    default:
      return 'default';
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Brief card component
// ---------------------------------------------------------------------------

interface BriefCardProps {
  brief: GearBriefItem;
  onDismiss: (id: string) => void;
  onDelete: (id: string) => void;
  isExpanded: boolean;
  onToggle: () => void;
}

function BriefCard({ brief, onDismiss, onDelete, isExpanded, onToggle }: BriefCardProps): React.ReactElement {
  return (
    <Card padding="sm">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="flex-1 text-left"
          onClick={onToggle}
          aria-expanded={isExpanded}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {brief.brief.problem}
            </span>
            <Badge variant={statusBadgeVariant(brief.status)}>
              {brief.status}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {formatDate(brief.createdAt)}
          </p>
        </button>

        {brief.status !== 'dismissed' && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { onDismiss(brief.id); }}
              aria-label="Dismiss brief"
            >
              Dismiss
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { onDelete(brief.id); }}
              aria-label="Delete brief"
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          <div>
            <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Proposed Solution
            </p>
            <p className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">
              {brief.brief.proposedSolution}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Example Input
              </p>
              <pre className="mt-0.5 overflow-x-auto rounded bg-gray-100 p-1.5 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                {brief.brief.exampleInput}
              </pre>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Example Output
              </p>
              <pre className="mt-0.5 overflow-x-auto rounded bg-gray-100 p-1.5 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                {brief.brief.exampleOutput}
              </pre>
            </div>
          </div>
          {brief.brief.manifestSkeleton && (
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Manifest Skeleton
              </p>
              <pre className="mt-0.5 overflow-x-auto rounded bg-gray-100 p-1.5 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                {brief.brief.manifestSkeleton}
              </pre>
            </div>
          )}
          {brief.brief.pseudocode && (
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Pseudocode
              </p>
              <pre className="mt-0.5 overflow-x-auto rounded bg-gray-100 p-1.5 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                {brief.brief.pseudocode}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Displays proposed Gear briefs from Journal reflection.
 * Users can expand briefs to see details, dismiss, or delete them.
 */
export function GearBriefsSection(): React.ReactElement {
  const briefs = useGearBriefStore((s) => s.briefs);
  const loading = useGearBriefStore((s) => s.loading);
  const error = useGearBriefStore((s) => s.error);
  const fetchBriefs = useGearBriefStore((s) => s.fetchBriefs);
  const dismissBrief = useGearBriefStore((s) => s.dismissBrief);
  const deleteBrief = useGearBriefStore((s) => s.deleteBrief);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void fetchBriefs();
  }, [fetchBriefs]);

  const handleDismiss = useCallback((id: string) => {
    void dismissBrief(id);
  }, [dismissBrief]);

  const handleDelete = useCallback((id: string) => {
    void deleteBrief(id);
    if (expandedId === id) {
      setExpandedId(null);
    }
  }, [deleteBrief, expandedId]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // Filter out dismissed briefs by default (show only proposed/refined)
  const activeBriefs = briefs.filter((b) => b.status !== 'dismissed');

  return (
    <section aria-label="Gear briefs">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Gear Suggestions
        {activeBriefs.length > 0 && (
          <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
            ({activeBriefs.length})
          </span>
        )}
      </h2>

      {loading && briefs.length === 0 ? (
        <div className="mt-3 flex items-center justify-center py-4">
          <Spinner size="sm" label="Loading gear briefs..." />
        </div>
      ) : error && briefs.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-center dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {error}
          </p>
        </div>
      ) : activeBriefs.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-center dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No gear suggestions yet. Suggestions appear after Journal reflection detects recurring patterns.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {activeBriefs.map((brief) => (
            <BriefCard
              key={brief.id}
              brief={brief}
              onDismiss={handleDismiss}
              onDelete={handleDelete}
              isExpanded={expandedId === brief.id}
              onToggle={() => { toggleExpand(brief.id); }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
