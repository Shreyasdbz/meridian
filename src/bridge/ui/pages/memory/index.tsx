// @meridian/bridge — Memory browser page (Phase 10.7)
// Tabs (All/Episodic/Semantic/Procedural), search, edit, delete, export, pause.

import { useCallback, useEffect, useState } from 'react';

import { useMemoryStore } from '../../stores/memory-store.js';

import { MemoryCard } from './memory-card.js';
import { MemoryEditDialog } from './memory-edit-dialog.js';
import { MemoryExportDialog } from './memory-export-dialog.js';

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'all' as const, label: 'All' },
  { key: 'episodic' as const, label: 'Episodic' },
  { key: 'semantic' as const, label: 'Semantic' },
  { key: 'procedural' as const, label: 'Procedural' },
] as const;

// ---------------------------------------------------------------------------
// MemoryBrowser
// ---------------------------------------------------------------------------

export function MemoryBrowser() {
  const {
    memories,
    total,
    hasMore,
    isLoading,
    error,
    activeTab,
    isPaused,
    fetchMemories,
    loadMore,
    deleteMemory,
    setActiveTab,
    setSearchQuery,
    togglePause,
  } = useMemoryStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    void fetchMemories();
  }, [fetchMemories]);

  const handleSearch = useCallback(() => {
    setSearchQuery(searchInput);
    void fetchMemories();
  }, [searchInput, setSearchQuery, fetchMemories]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSearch();
      }
    },
    [handleSearch],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (window.confirm('Delete this memory? This cannot be undone.')) {
        await deleteMemory(id);
      }
    },
    [deleteMemory],
  );

  const editingMemory = editingId
    ? memories.find((m) => m.id === editingId)
    : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Memory Browser
          </h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void togglePause()}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                isPaused
                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200'
                  : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200'
              }`}
            >
              {isPaused ? 'Recording Paused' : 'Recording Active'}
            </button>
            <button
              onClick={() => { setShowExport(true); }}
              className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Export
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => { setSearchInput(e.target.value); }}
            onKeyDown={handleKeyDown}
            placeholder="Search memories..."
            className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-400"
          />
          <button
            onClick={handleSearch}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Search
          </button>
        </div>

        {/* Tabs */}
        <div className="mt-3 flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Memory list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        )}

        {memories.length === 0 && !isLoading ? (
          <div className="py-12 text-center text-gray-500 dark:text-gray-400">
            No memories found.
          </div>
        ) : (
          <div className="space-y-3">
            {memories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onEdit={() => { setEditingId(memory.id); }}
                onDelete={() => void handleDelete(memory.id)}
              />
            ))}
          </div>
        )}

        {/* Load more */}
        {hasMore && (
          <div className="mt-4 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={isLoading}
              className="rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {isLoading ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}

        {isLoading && memories.length === 0 && (
          <div className="py-12 text-center text-gray-500 dark:text-gray-400">
            Loading memories...
          </div>
        )}

        {/* Footer count */}
        <div className="mt-4 text-center text-xs text-gray-400 dark:text-gray-500">
          Showing {memories.length} of {total} memories
        </div>
      </div>

      {/* Edit dialog */}
      {editingMemory && (
        <MemoryEditDialog
          memory={editingMemory}
          onClose={() => { setEditingId(null); }}
        />
      )}

      {/* Export dialog */}
      {showExport && (
        <MemoryExportDialog onClose={() => { setShowExport(false); }} />
      )}
    </div>
  );
}
