// Accessibility settings section (Section 5.5.14).
// Provides high contrast mode, font size, and reduced motion toggles.

import { useSettingsStore, type FontSize } from '../../stores/settings-store.js';

// ---------------------------------------------------------------------------
// Font size options
// ---------------------------------------------------------------------------

const FONT_SIZE_OPTIONS: { value: FontSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
  { value: 'x-large', label: 'Extra Large' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccessibilitySection(): React.ReactElement {
  const highContrast = useSettingsStore((s) => s.highContrast);
  const setHighContrast = useSettingsStore((s) => s.setHighContrast);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const setReducedMotion = useSettingsStore((s) => s.setReducedMotion);

  return (
    <section aria-labelledby="accessibility-heading">
      <h3
        id="accessibility-heading"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        Accessibility
      </h3>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        WCAG 2.1 AA compliance target. Adjust display preferences for your comfort.
      </p>

      <div className="mt-4 space-y-4">
        {/* High contrast mode */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              High contrast
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {highContrast
                ? 'Enhanced contrast for better visibility.'
                : 'Standard contrast mode.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={highContrast}
            aria-label="Toggle high contrast mode"
            onClick={() => { setHighContrast(!highContrast); }}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-meridian-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${
              highContrast ? 'bg-meridian-600' : 'bg-gray-200 dark:bg-gray-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                highContrast ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Font size */}
        <div>
          <p
            id="font-size-label"
            className="text-sm font-medium text-gray-900 dark:text-gray-100"
          >
            Font size
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Adjust the base text size across the interface.
          </p>
          <div className="mt-2 flex gap-2" role="radiogroup" aria-labelledby="font-size-label">
            {FONT_SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                role="radio"
                aria-checked={fontSize === option.value}
                onClick={() => { setFontSize(option.value); }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-meridian-500 ${
                  fontSize === option.value
                    ? 'bg-meridian-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* Reduced motion */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Reduce motion
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {reducedMotion
                ? 'Animations and transitions are minimized.'
                : 'Standard animations enabled.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={reducedMotion}
            aria-label="Toggle reduced motion"
            onClick={() => { setReducedMotion(!reducedMotion); }}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-meridian-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${
              reducedMotion ? 'bg-meridian-600' : 'bg-gray-200 dark:bg-gray-700'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                reducedMotion ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}
