import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { api } from '../hooks/use-api.js';
import { ChatPage } from '../pages/chat/index.js';
import { MissionControl } from '../pages/mission-control/index.js';
import { SettingsPage } from '../pages/settings/index.js';
import { useJobStore } from '../stores/job-store.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { useUIStore } from '../stores/ui-store.js';

import { ApprovalDialog } from './approval-dialog/index.js';
import { Badge } from './badge.js';
import { CommandPalette } from './command-palette/index.js';

const BREAKPOINT = 1280;

/**
 * Base layout component with responsive behavior:
 * - >= 1280px: side-by-side (conversation left, Mission Control right)
 * - < 1280px: toggle between views, badge on MC toggle for pending approvals
 *
 * Phase 7.6 additions: command palette, keyboard shortcuts, settings panel,
 * Shell Gear persistent indicator.
 */
export function Layout() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const pendingApprovalCount = useUIStore((s) => s.pendingApprovalCount);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const shellGearEnabled = useSettingsStore((s) => s.shellGearEnabled);
  const activeJobs = useJobStore((s) => s.activeJobs);

  const [isWide, setIsWide] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= BREAKPOINT : true,
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Load settings on mount
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  // Responsive breakpoint
  useEffect(() => {
    const handleResize = (): void => {
      setIsWide(window.innerWidth >= BREAKPOINT);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Cancel the first active job (for Cmd+. shortcut)
  const cancelActiveJob = useCallback((): void => {
    if (activeJobs.length > 0) {
      const firstJob = activeJobs[0];
      if (firstJob) {
        void api.post(`/jobs/${firstJob.id}/cancel`);
      }
    }
  }, [activeJobs]);

  // Global keyboard shortcuts (Section 5.5.10)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      // Cmd+K / Ctrl+K — open command palette (always active)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Cmd+. / Ctrl+. — cancel running task
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        cancelActiveJob();
        return;
      }

      // Escape — dismiss dialogs/overlays
      if (e.key === 'Escape') {
        if (commandPaletteOpen) {
          e.preventDefault();
          setCommandPaletteOpen(false);
          return;
        }
        if (settingsOpen) {
          e.preventDefault();
          setSettingsOpen(false);
          return;
        }
        // Let other dialogs handle Escape naturally
        return;
      }

      // / — focus chat input (only when not in an input field)
      if (e.key === '/' && !isInput) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('meridian:focus-chat-input'));
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [commandPaletteOpen, settingsOpen, cancelActiveJob]);

  const cycleTheme = (): void => {
    const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(next);
  };

  // If settings is open, show settings page instead of main content
  if (settingsOpen) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <SettingsPage onClose={() => { setSettingsOpen(false); }} />
        <CommandPalette
          open={commandPaletteOpen}
          onClose={() => { setCommandPaletteOpen(false); }}
          onOpenSettings={() => { setSettingsOpen(true); }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Meridian</h1>
          {/* Shell Gear persistent indicator (Section 5.6.5) */}
          {shellGearEnabled && (
            <span
              className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
              title="Shell access is enabled. Shell commands always require fresh approval."
              aria-label="Shell access enabled"
            >
              Shell active
            </span>
          )}
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

          {/* Settings button */}
          <button
            onClick={() => { setSettingsOpen(true); }}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label="Open settings"
          >
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
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>

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

      {/* Approval dialog (Phase 7.5 — shown as modal for Sentinel escalations) */}
      <ApprovalDialog />

      {/* Command palette (Phase 7.6) */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => { setCommandPaletteOpen(false); }}
        onOpenSettings={() => { setSettingsOpen(true); }}
      />

      {/* Router outlet for modals/overlays */}
      <Outlet />
    </div>
  );
}
