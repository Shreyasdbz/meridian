// @meridian/bridge — Memory edit dialog (Phase 10.7)

import { useCallback, useState } from 'react';

import { useMemoryStore } from '../../stores/memory-store.js';
import type { Memory } from '../../stores/memory-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryEditDialogProps {
  memory: Memory;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// MemoryEditDialog
// ---------------------------------------------------------------------------

export function MemoryEditDialog({ memory, onClose }: MemoryEditDialogProps) {
  const [content, setContent] = useState(memory.content);
  const [isSaving, setIsSaving] = useState(false);
  const updateMemory = useMemoryStore((s) => s.updateMemory);

  const handleSave = useCallback(async () => {
    if (!content.trim() || content === memory.content) {
      onClose();
      return;
    }

    setIsSaving(true);
    try {
      await updateMemory(memory.id, { content: content.trim() });
      onClose();
    } finally {
      setIsSaving(false);
    }
  }, [content, memory, updateMemory, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Edit Memory
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {memory.type} | {memory.id.slice(0, 8)}...
        </p>

        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); }}
          rows={6}
          className="mt-4 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={isSaving || !content.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
