interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const PADDING_CLASSES = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export function Card({ children, className = '', padding = 'md' }: CardProps) {
  return (
    <div
      className={`rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${PADDING_CLASSES[padding]} ${className}`}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function CardHeader({ title, description, actions }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {description && (
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        )}
      </div>
      {actions && <div className="ml-4">{actions}</div>}
    </div>
  );
}
