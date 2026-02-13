// User-facing vocabulary module (Section 5.5.5)
// Maps internal component/term names to user-friendly language.
// Shared across all UI components.

/**
 * Maps internal job status values to user-friendly labels.
 */
export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  planning: 'Thinking...',
  validating: 'Checking safety...',
  awaiting_approval: 'Needs your OK',
  executing: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Maps internal component names to user-friendly terms.
 */
export const COMPONENT_LABELS: Record<string, string> = {
  scout: 'Planner',
  sentinel: 'Safety check',
  gear: 'Tool',
  journal: 'Memory',
  axis: 'Runtime',
  bridge: 'Interface',
};

/**
 * Maps internal terms that appear in plans/logs to user-facing language.
 */
export const TERM_LABELS: Record<string, string> = {
  'sentinel_memory': 'Trust settings',
  'sentinel_rejected': 'This was flagged',
  'execution_plan': 'Action plan',
  'needs_user_approval': 'I need your OK before proceeding',
  'gear_executing': 'Working on it...',
  'gear_failed': 'Something went wrong',
  'risk_level': 'Safety level',
  'gear_manifest': 'Tool permissions',
  'fast_path': 'Quick response',
  'full_path': 'Full action pipeline',
};

/**
 * Returns the user-facing label for a job status.
 */
export function getStatusLabel(status: string): string {
  return JOB_STATUS_LABELS[status] ?? status;
}

/**
 * Returns the user-facing label for an internal component name.
 */
export function getComponentLabel(component: string): string {
  return COMPONENT_LABELS[component] ?? component;
}

/**
 * Returns the user-facing label for an internal term.
 */
export function getTermLabel(term: string): string {
  return TERM_LABELS[term] ?? term;
}

/**
 * Translates a Gear name to user-friendly "tool" or "skill" phrasing.
 * Gear is presented as "tool" in action contexts, "skill" in capability contexts.
 */
export function getGearLabel(gearName: string, context: 'action' | 'capability' = 'action'): string {
  const prefix = context === 'action' ? 'tool' : 'skill';
  return `${prefix}: ${gearName}`;
}
