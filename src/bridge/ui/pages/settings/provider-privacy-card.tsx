// Provider privacy information card (Settings page).
// Displays a summary of data retention, training opt-out, and region
// for a given AI provider so users can make informed choices.

interface ProviderPrivacyInfo {
  name: string;
  dataRetention: string;
  trainingOptOut: string;
  region: string;
  apiLink: string;
}

const PROVIDER_PRIVACY: Record<string, ProviderPrivacyInfo> = {
  anthropic: {
    name: 'Anthropic',
    dataRetention: 'API data not retained beyond 30 days',
    trainingOptOut: 'API data not used for training by default',
    region: 'US (GCP)',
    apiLink: 'https://docs.anthropic.com/en/docs/about-claude/data-privacy',
  },
  openai: {
    name: 'OpenAI',
    dataRetention: 'API data retained for 30 days for abuse monitoring',
    trainingOptOut: 'API data not used for training by default',
    region: 'US (Azure)',
    apiLink: 'https://openai.com/enterprise-privacy',
  },
  ollama: {
    name: 'Ollama (Local)',
    dataRetention: 'All data stays on your device',
    trainingOptOut: 'N/A — fully local',
    region: 'Local',
    apiLink: 'https://ollama.com',
  },
};

interface ProviderPrivacyCardProps {
  provider: string;
}

export function ProviderPrivacyCard({
  provider,
}: ProviderPrivacyCardProps): React.ReactElement {
  const info = PROVIDER_PRIVACY[provider];

  if (!info) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No privacy information available for this provider.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {info.name} Privacy
      </h4>

      <dl className="mt-3 space-y-2">
        <PrivacyRow label="Data Retention" value={info.dataRetention} />
        <PrivacyRow label="Training Opt-Out" value={info.trainingOptOut} />
        <PrivacyRow label="Region" value={info.region} />
      </dl>

      <div className="mt-3">
        <a
          href={info.apiLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-meridian-600 hover:text-meridian-700 dark:text-meridian-400 dark:hover:text-meridian-300"
        >
          View privacy policy
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
            />
          </svg>
        </a>
      </div>

      <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
        Privacy information may change. Check the provider&apos;s site for the
        latest details.
      </p>
    </div>
  );
}

interface PrivacyRowProps {
  label: string;
  value: string;
}

function PrivacyRow({ label, value }: PrivacyRowProps): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-right text-xs font-medium text-gray-700 dark:text-gray-300">
        {value}
      </dd>
    </div>
  );
}
