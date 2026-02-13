// Command palette (Section 5.5.10).
// Triggered by Cmd+K / Ctrl+K. Provides quick actions:
// new conversation, switch conversations, open settings,
// toggle developer mode, cancel running task, focus chat input.

import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../hooks/use-api.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useJobStore } from '../../stores/job-store.js';
import { useSettingsStore } from '../../stores/settings-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category: 'navigation' | 'action' | 'conversation';
  action: () => void | Promise<void>;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
  open,
  onClose,
  onOpenSettings,
}: CommandPaletteProps): React.ReactElement | null {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Store access
  const conversations = useConversationStore((s) => s.conversations);
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId);
  const activeJobs = useJobStore((s) => s.activeJobs);
  const developerMode = useSettingsStore((s) => s.developerMode);
  const setDeveloperMode = useSettingsStore((s) => s.setDeveloperMode);

  // Build command list
  const commands = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [
      {
        id: 'new-conversation',
        label: 'New conversation',
        description: 'Start a fresh conversation',
        category: 'navigation',
        action: () => {
          setActiveConversationId(null);
          onClose();
        },
      },
      {
        id: 'open-settings',
        label: 'Open settings',
        shortcut: undefined,
        category: 'navigation',
        action: () => {
          onOpenSettings();
          onClose();
        },
      },
      {
        id: 'toggle-developer-mode',
        label: developerMode ? 'Disable developer mode' : 'Enable developer mode',
        description: 'Toggle internal details visibility',
        category: 'action',
        action: () => {
          void setDeveloperMode(!developerMode);
          onClose();
        },
      },
      {
        id: 'focus-chat-input',
        label: 'Focus chat input',
        shortcut: '/',
        category: 'action',
        action: () => {
          onClose();
          // Dispatch a custom event that chat-input listens for
          window.dispatchEvent(new CustomEvent('meridian:focus-chat-input'));
        },
      },
    ];

    // Add cancel task command if there are active jobs
    if (activeJobs.length > 0) {
      for (const job of activeJobs) {
        items.push({
          id: `cancel-job-${job.id}`,
          label: `Cancel task`,
          description: job.id.slice(0, 8),
          shortcut: undefined,
          category: 'action',
          action: () => {
            void api.post(`/jobs/${job.id}/cancel`);
            onClose();
          },
        });
      }
    }

    // Add conversation switching
    for (const conv of conversations.slice(0, 10)) {
      items.push({
        id: `switch-${conv.id}`,
        label: conv.title || 'Untitled conversation',
        category: 'conversation',
        action: () => {
          setActiveConversationId(conv.id);
          onClose();
        },
      });
    }

    return items;
  }, [
    conversations,
    activeJobs,
    developerMode,
    onClose,
    onOpenSettings,
    setActiveConversationId,
    setDeveloperMode,
  ]);

  // Filter by query
  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const lower = query.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lower) ||
        (cmd.description && cmd.description.toLowerCase().includes(lower)),
    );
  }, [commands, query]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Keep selection in bounds
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[selectedIndex];
      if (cmd) {
        void cmd.action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Palette */}
      <div
        className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
      >
        {/* Search input */}
        <div className="border-b border-gray-200 p-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 shrink-0 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Type a command..."
              className="w-full bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none dark:text-gray-100 dark:placeholder-gray-500"
              aria-label="Search commands"
              aria-activedescendant={
                filtered[selectedIndex]
                  ? `cmd-${filtered[selectedIndex].id}`
                  : undefined
              }
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-controls="command-list"
              aria-autocomplete="list"
            />
          </div>
        </div>

        {/* Results */}
        <div
          id="command-list"
          ref={listRef}
          className="max-h-64 overflow-y-auto p-1"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              No commands found
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                id={`cmd-${cmd.id}`}
                role="option"
                aria-selected={i === selectedIndex}
                onClick={() => { void cmd.action(); }}
                onMouseEnter={() => { setSelectedIndex(i); }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  i === selectedIndex
                    ? 'bg-meridian-50 text-meridian-900 dark:bg-meridian-950/30 dark:text-meridian-100'
                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate">{cmd.label}</span>
                  {cmd.description && (
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {cmd.description}
                    </span>
                  )}
                </div>
                {cmd.shortcut && (
                  <kbd className="ml-2 shrink-0 rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    {cmd.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
          <div className="flex items-center gap-3 text-[10px] text-gray-400 dark:text-gray-500">
            <span>
              <kbd className="rounded border border-gray-200 px-1 dark:border-gray-700">↑↓</kbd>{' '}
              Navigate
            </span>
            <span>
              <kbd className="rounded border border-gray-200 px-1 dark:border-gray-700">↵</kbd>{' '}
              Select
            </span>
            <span>
              <kbd className="rounded border border-gray-200 px-1 dark:border-gray-700">Esc</kbd>{' '}
              Close
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
