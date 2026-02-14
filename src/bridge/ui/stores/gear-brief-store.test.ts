// Gear Brief store tests (Phase 11.1)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGearBriefStore } from './gear-brief-store.js';

// ---------------------------------------------------------------------------
// Mock the api module
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock('../hooks/use-api.js', () => ({
  api: {
    get: (...args: unknown[]): unknown => mockGet(...args),
    post: (...args: unknown[]): unknown => mockPost(...args),
    delete: (...args: unknown[]): unknown => mockDelete(...args),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset store state between tests
  useGearBriefStore.setState({
    briefs: [],
    loading: false,
    error: null,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGearBriefStore', () => {
  describe('fetchBriefs', () => {
    it('should load briefs from API', async () => {
      const mockBriefs = [
        {
          id: 'brief-2026-01-01-abc',
          fileName: 'brief-2026-01-01-abc.json',
          origin: 'journal',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'proposed',
          brief: {
            problem: 'CSV parsing needed',
            proposedSolution: 'Create a CSV Gear',
            exampleInput: 'name,age',
            exampleOutput: '[{"name":"Alice"}]',
          },
        },
      ];

      mockGet.mockResolvedValueOnce({ items: mockBriefs, total: 1 });

      await useGearBriefStore.getState().fetchBriefs();

      expect(mockGet).toHaveBeenCalledWith('/gear/briefs');
      expect(useGearBriefStore.getState().briefs).toEqual(mockBriefs);
      expect(useGearBriefStore.getState().loading).toBe(false);
      expect(useGearBriefStore.getState().error).toBeNull();
    });

    it('should set loading state while fetching', () => {
      mockGet.mockImplementation(() => new Promise(() => {})); // Never resolves

      void useGearBriefStore.getState().fetchBriefs();

      // Check loading was set to true
      expect(useGearBriefStore.getState().loading).toBe(true);
    });

    it('should handle fetch errors', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      await useGearBriefStore.getState().fetchBriefs();

      expect(useGearBriefStore.getState().error).toBe('Network error');
      expect(useGearBriefStore.getState().loading).toBe(false);
    });
  });

  describe('dismissBrief', () => {
    it('should dismiss a brief and update status', async () => {
      useGearBriefStore.setState({
        briefs: [
          {
            id: 'brief-abc',
            fileName: 'brief-abc.json',
            origin: 'journal',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'proposed',
            brief: {
              problem: 'Test',
              proposedSolution: 'Solution',
              exampleInput: 'in',
              exampleOutput: 'out',
            },
          },
        ],
      });

      mockPost.mockResolvedValueOnce({ status: 'dismissed', message: 'Brief dismissed' });

      await useGearBriefStore.getState().dismissBrief('brief-abc');

      expect(mockPost).toHaveBeenCalledWith('/gear/briefs/brief-abc/dismiss');
      expect(useGearBriefStore.getState().briefs[0]?.status).toBe('dismissed');
    });

    it('should handle dismiss errors', async () => {
      useGearBriefStore.setState({
        briefs: [
          {
            id: 'brief-abc',
            fileName: 'brief-abc.json',
            origin: 'journal',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'proposed',
            brief: {
              problem: 'Test',
              proposedSolution: 'Solution',
              exampleInput: 'in',
              exampleOutput: 'out',
            },
          },
        ],
      });

      mockPost.mockRejectedValueOnce(new Error('Not found'));

      await useGearBriefStore.getState().dismissBrief('brief-abc');

      expect(useGearBriefStore.getState().error).toBe('Not found');
      // Status should remain unchanged
      expect(useGearBriefStore.getState().briefs[0]?.status).toBe('proposed');
    });
  });

  describe('refineBrief', () => {
    it('should refine a brief and update content', async () => {
      useGearBriefStore.setState({
        briefs: [
          {
            id: 'brief-abc',
            fileName: 'brief-abc.json',
            origin: 'journal',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'proposed',
            brief: {
              problem: 'Old problem',
              proposedSolution: 'Old solution',
              exampleInput: 'in',
              exampleOutput: 'out',
            },
          },
        ],
      });

      mockPost.mockResolvedValueOnce({
        status: 'refined',
        brief: {
          problem: 'Updated problem',
          proposedSolution: 'Updated solution',
          exampleInput: 'in',
          exampleOutput: 'out',
        },
      });

      await useGearBriefStore.getState().refineBrief('brief-abc', {
        problem: 'Updated problem',
        proposedSolution: 'Updated solution',
      });

      expect(mockPost).toHaveBeenCalledWith('/gear/briefs/brief-abc/refine', {
        problem: 'Updated problem',
        proposedSolution: 'Updated solution',
      });
      expect(useGearBriefStore.getState().briefs[0]?.status).toBe('refined');
      expect(useGearBriefStore.getState().briefs[0]?.brief.problem).toBe('Updated problem');
    });
  });

  describe('deleteBrief', () => {
    it('should remove a brief from the list', async () => {
      useGearBriefStore.setState({
        briefs: [
          {
            id: 'brief-abc',
            fileName: 'brief-abc.json',
            origin: 'journal',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'proposed',
            brief: {
              problem: 'Test',
              proposedSolution: 'Solution',
              exampleInput: 'in',
              exampleOutput: 'out',
            },
          },
          {
            id: 'brief-def',
            fileName: 'brief-def.json',
            origin: 'journal',
            createdAt: '2026-01-02T00:00:00.000Z',
            status: 'proposed',
            brief: {
              problem: 'Other',
              proposedSolution: 'Other solution',
              exampleInput: 'in',
              exampleOutput: 'out',
            },
          },
        ],
      });

      mockDelete.mockResolvedValueOnce({ id: 'brief-abc', message: 'Brief deleted' });

      await useGearBriefStore.getState().deleteBrief('brief-abc');

      expect(mockDelete).toHaveBeenCalledWith('/gear/briefs/brief-abc');
      expect(useGearBriefStore.getState().briefs).toHaveLength(1);
      expect(useGearBriefStore.getState().briefs[0]?.id).toBe('brief-def');
    });

    it('should handle delete errors', async () => {
      useGearBriefStore.setState({
        briefs: [
          {
            id: 'brief-abc',
            fileName: 'brief-abc.json',
            origin: 'journal',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'proposed',
            brief: {
              problem: 'Test',
              proposedSolution: 'Solution',
              exampleInput: 'in',
              exampleOutput: 'out',
            },
          },
        ],
      });

      mockDelete.mockRejectedValueOnce(new Error('Server error'));

      await useGearBriefStore.getState().deleteBrief('brief-abc');

      expect(useGearBriefStore.getState().error).toBe('Server error');
      // Brief should still be in the list
      expect(useGearBriefStore.getState().briefs).toHaveLength(1);
    });
  });
});
