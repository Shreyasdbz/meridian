// @meridian/bridge — Memory export dialog (Phase 10.7)

import { useCallback, useState } from 'react';

import { useMemoryStore } from '../../stores/memory-store.js';
import type { MemoryType } from '../../stores/memory-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryExportDialogProps {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// MemoryExportDialog
// ---------------------------------------------------------------------------

export function MemoryExportDialog({ onClose }: MemoryExportDialogProps) {
  const [format, setFormat] = useState<'json' | 'markdown'>('json');
  const [type, setType] = useState<'all' | MemoryType>('all');
  const [isExporting, setIsExporting] = useState(false);
  const exportMemories = useMemoryStore((s) => s.exportMemories);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const typeFilter = type === 'all' ? undefined : type;
      const data = await exportMemories(format, typeFilter);

      // Download the exported data
      const blob = new Blob(
        [typeof data === 'string' ? data : JSON.stringify(data, null, 2)],
        { type: format === 'json' ? 'application/json' : 'text/markdown' },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memories-export.${format === 'json' ? 'json' : 'md'}`;
      a.click();
      URL.revokeObjectURL(url);

      onClose();
    } finally {
      setIsExporting(false);
    }
  }, [format, type, exportMemories, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Export Memories
        </h2>

        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Format
            </label>
            <select
              value={format}
              onChange={(e) => { setFormat(e.target.value as 'json' | 'markdown'); }}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Type Filter
            </label>
            <select
              value={type}
              onChange={(e) => { setType(e.target.value as 'all' | MemoryType); }}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="all">All Types</option>
              <option value="episodic">Episodic</option>
              <option value="semantic">Semantic</option>
              <option value="procedural">Procedural</option>
            </select>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleExport()}
            disabled={isExporting}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
