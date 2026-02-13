import { type ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-meridian-600 text-white hover:bg-meridian-700 focus-visible:ring-meridian-500 dark:bg-meridian-500 dark:hover:bg-meridian-600',
  secondary:
    'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus-visible:ring-meridian-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
  ghost:
    'text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-meridian-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100',
  danger:
    'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 dark:bg-red-500 dark:hover:bg-red-600',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={`inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950 disabled:pointer-events-none disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
