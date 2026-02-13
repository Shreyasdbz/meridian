import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { ChatPage } from '../pages/chat/index.js';
import { MissionControl } from '../pages/mission-control/index.js';
import { useUIStore } from '../stores/ui-store.js';

import { Badge } from './badge.js';

const BREAKPOINT = 1280;

/**
 * Base layout component with responsive behavior:
 * - >= 1280px: side-by-side (conversation left, Mission Control right)
 * - < 1280px: toggle between views, badge on MC toggle for pending approvals
 */
export function Layout() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const pendingApprovalCount = useUIStore((s) => s.pendingApprovalCount);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const [isWide, setIsWide] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= BREAKPOINT : true,
  );

  useEffect(() => {
    const handleResize = (): void => {
      setIsWide(window.innerWidth >= BREAKPOINT);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const cycleTheme = (): void => {
    const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(next);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Meridian</h1>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle (narrow screens only) */}
          {!isWide && (
            <div className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
              <button
                onClick={() => {
                  setActiveView('chat');
                }}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  activeView === 'chat'
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => {
                  setActiveView('mission-control');
                }}
                className={`relative rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  activeView === 'mission-control'
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                }`}
              >
                Mission Control
                {pendingApprovalCount > 0 && (
                  <Badge
                    variant="warning"
                    className="absolute -right-1 -top-1 min-w-[1.25rem] px-1 text-xs"
                  >
                    {pendingApprovalCount}
                  </Badge>
                )}
              </button>
            </div>
          )}

          {/* Theme toggle */}
          <button
            onClick={cycleTheme}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label={`Current theme: ${theme}. Click to cycle.`}
          >
            {theme === 'dark' && (
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            )}
            {theme === 'light' && (
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            )}
            {theme === 'system' && (
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 overflow-hidden">
        {isWide ? (
          // Wide: side-by-side layout
          <>
            <div className="flex flex-1 flex-col overflow-hidden border-r border-gray-200 dark:border-gray-800">
              <ChatPage />
            </div>
            <div className="flex w-[480px] shrink-0 flex-col overflow-hidden">
              <MissionControl />
            </div>
          </>
        ) : (
          // Narrow: toggled view
          <>{activeView === 'chat' ? <ChatPage /> : <MissionControl />}</>
        )}
      </main>

      {/* Router outlet for modals/overlays */}
      <Outlet />
    </div>
  );
}
