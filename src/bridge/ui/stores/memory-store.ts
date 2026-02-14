// @meridian/bridge — Memory store (Phase 10.7)
// Zustand store for memory browser state.

import { create } from 'zustand';

import { api } from '../hooks/use-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  source?: string;
  linkedGearId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

interface MemoryListResponse {
  items: Memory[];
  total: number;
  hasMore: boolean;
}

interface ExportResponse {
  format: string;
  count: number;
  data: unknown;
}

export interface MemoryStore {
  // State
  memories: Memory[];
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  activeTab: 'all' | MemoryType;
  searchQuery: string;
  isPaused: boolean;
  offset: number;

  // Actions
  fetchMemories: () => Promise<void>;
  loadMore: () => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  updateMemory: (id: string, updates: { content?: string }) => Promise<void>;
  exportMemories: (format: 'json' | 'markdown', type?: MemoryType) => Promise<unknown>;
  setActiveTab: (tab: 'all' | MemoryType) => void;
  setSearchQuery: (query: string) => void;
  togglePause: () => Promise<void>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  // Initial state
  memories: [],
  total: 0,
  hasMore: false,
  isLoading: false,
  error: null,
  activeTab: 'all',
  searchQuery: '',
  isPaused: false,
  offset: 0,

  fetchMemories: async () => {
    const { activeTab, searchQuery } = get();
    set({ isLoading: true, error: null, offset: 0 });

    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
      if (activeTab !== 'all') {
        params.set('type', activeTab);
      }
      if (searchQuery) {
        params.set('keyword', searchQuery);
      }

      const response = await api.get<MemoryListResponse>(
        `/memories?${params.toString()}`,
      );

      set({
        memories: response.items,
        total: response.total,
        hasMore: response.hasMore,
        isLoading: false,
        offset: PAGE_SIZE,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load memories',
        isLoading: false,
      });
    }
  },

  loadMore: async () => {
    const { activeTab, searchQuery, offset, memories } = get();
    set({ isLoading: true });

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (activeTab !== 'all') {
        params.set('type', activeTab);
      }
      if (searchQuery) {
        params.set('keyword', searchQuery);
      }

      const response = await api.get<MemoryListResponse>(
        `/memories?${params.toString()}`,
      );

      set({
        memories: [...memories, ...response.items],
        total: response.total,
        hasMore: response.hasMore,
        isLoading: false,
        offset: offset + PAGE_SIZE,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load more',
        isLoading: false,
      });
    }
  },

  deleteMemory: async (id: string) => {
    try {
      await api.delete(`/memories/${id}`);
      const { memories, total } = get();
      set({
        memories: memories.filter((m) => m.id !== id),
        total: total - 1,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete memory',
      });
    }
  },

  updateMemory: async (id: string, updates: { content?: string }) => {
    try {
      const updated = await api.put<Memory>(`/memories/${id}`, updates);
      const { memories } = get();
      set({
        memories: memories.map((m) =>
          m.id === id ? { ...m, ...updated } : m,
        ),
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to update memory',
      });
    }
  },

  exportMemories: async (format: 'json' | 'markdown', type?: MemoryType) => {
    const body: Record<string, string> = { format };
    if (type) {
      body['type'] = type;
    }
    const response = await api.post<ExportResponse>('/memories/export', body);
    return response.data;
  },

  setActiveTab: (tab: 'all' | MemoryType) => {
    set({ activeTab: tab });
    void get().fetchMemories();
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  togglePause: async () => {
    const { isPaused } = get();
    try {
      await api.put('/memories/pause', { paused: !isPaused });
      set({ isPaused: !isPaused });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to toggle pause',
      });
    }
  },

  reset: () => {
    set({
      memories: [],
      total: 0,
      hasMore: false,
      isLoading: false,
      error: null,
      activeTab: 'all',
      searchQuery: '',
      offset: 0,
    });
  },
}));
