// Conversation sidebar: list, create new, archive conversations.

import { useCallback, useState } from 'react';

import type { Conversation } from '@meridian/shared';

import { Spinner } from '../../components/spinner.js';

interface ConversationSidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  isLoading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: (id: string) => void;
}

/**
 * Sidebar listing conversations with create/archive actions.
 * Displayed in the left panel of the chat view.
 */
export function ConversationSidebar({
  conversations,
  activeConversationId,
  isLoading,
  onSelect,
  onCreate,
  onArchive,
}: ConversationSidebarProps): React.ReactElement {
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const handleArchive = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setArchivingId(id);
      onArchive(id);
      // Reset after a brief delay (parent will remove from list)
      setTimeout(() => { setArchivingId(null); }, 500);
    },
    [onArchive],
  );

  const formatDate = (dateStr: string): string => {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${String(diffDays)}d ago`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950">
      {/* Header with New button */}
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2.5 dark:border-gray-800">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Conversations</h2>
        <button
          onClick={onCreate}
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          aria-label="New conversation"
          data-testid="new-conversation-button"
          title="New conversation"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-4">
            <Spinner size="sm" label="Loading conversations..." />
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
            No conversations yet
          </div>
        ) : (
          <ul className="py-1" role="listbox" aria-label="Conversations">
            {conversations.map((conv) => (
              <li
                key={conv.id}
                role="option"
                aria-selected={conv.id === activeConversationId}
                onClick={() => { onSelect(conv.id); }}
                className={`group flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left transition-colors ${
                  conv.id === activeConversationId
                    ? 'bg-meridian-50 text-meridian-900 dark:bg-meridian-900/20 dark:text-meridian-100'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800/50'
                }`}
                data-testid={`conversation-${conv.id}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {conv.title || 'New conversation'}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {formatDate(conv.updatedAt)}
                  </p>
                </div>

                {/* Archive button (visible on hover) */}
                <button
                  onClick={(e) => { handleArchive(e, conv.id); }}
                  className={`shrink-0 rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-200 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-300 ${
                    archivingId === conv.id ? 'opacity-100' : ''
                  }`}
                  aria-label={`Archive "${conv.title || 'conversation'}"`}
                  title="Archive"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
