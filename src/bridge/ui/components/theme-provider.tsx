import { useEffect } from 'react';

import { useUIStore } from '../stores/ui-store.js';

/**
 * ThemeProvider applies the resolved theme class to <html> and
 * listens for system preference changes when theme is set to 'system'.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useUIStore((s) => s.theme);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);
  const setResolvedTheme = useUIStore((s) => s.setResolvedTheme);

  // Apply dark/light class to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [resolvedTheme]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent): void => {
      setResolvedTheme(e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handler);
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, [theme, setResolvedTheme]);

  return <>{children}</>;
}
