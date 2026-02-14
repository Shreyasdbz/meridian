// @meridian/bridge/ui — Sentinel configuration guidance (Phase 9.8)
// Shows security level options for the Scout/Sentinel LLM pairing during
// onboarding. Helps users understand the trade-off between safety and cost
// when choosing providers for the dual-LLM trust boundary.

interface SecurityLevel {
  label: string;
  description: string;
  example: string;
  badge?: string;
}

const SECURITY_LEVELS: SecurityLevel[] = [
  {
    label: 'High Security',
    description:
      'Use different providers for Scout and Sentinel (e.g., Anthropic + OpenAI). ' +
      'A compromise of one provider cannot bypass the other.',
    example: 'Scout: Anthropic Claude, Sentinel: OpenAI GPT-4',
    badge: 'Recommended',
  },
  {
    label: 'Balanced',
    description:
      'Same provider, different models. Good safety with simpler key management.',
    example: 'Scout: Claude Sonnet, Sentinel: Claude Haiku',
  },
  {
    label: 'Budget',
    description:
      'Same model for both Scout and Sentinel. Lowest cost but reduced safety margin — ' +
      'a single model may not catch its own mistakes.',
    example: 'Scout: GPT-4o, Sentinel: GPT-4o',
  },
];

export function SentinelGuidance(): React.ReactElement {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Scout & Sentinel pairing
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Meridian uses two independent LLMs: Scout plans actions and Sentinel
          reviews them for safety. Choosing different providers strengthens the
          trust boundary.
        </p>
      </div>

      <div className="space-y-3">
        {SECURITY_LEVELS.map((level) => (
          <div
            key={level.label}
            className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {level.label}
              </span>
              {level.badge && (
                <span className="rounded-full bg-meridian-100 px-2 py-0.5 text-xs font-medium text-meridian-700 dark:bg-meridian-900/30 dark:text-meridian-400">
                  {level.badge}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {level.description}
            </p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-500">
              Example: {level.example}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
