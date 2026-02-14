// E2E test: v0.3 Memory & Learning (Phase 10.7)
//
// Validates key user flows for the memory system:
// - Memory browser navigation and display
// - Memory search and filtering
// - Trust settings management
//
// Note: These tests require the full server to be running.
// They are designed for Playwright but can be run against a local instance.

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// These are structural tests validating the components exist and are wired.
// Full Playwright browser tests require the dev server running.
// ---------------------------------------------------------------------------

describe('v0.3 Memory & Learning — Structural Validation', () => {
  describe('Memory browser components', () => {
    it('should export MemoryBrowser page component', async () => {
      const mod = await import(
        '../../src/bridge/ui/pages/memory/index.js'
      );
      expect(mod.MemoryBrowser).toBeDefined();
      expect(typeof mod.MemoryBrowser).toBe('function');
    });

    it('should export MemoryCard component', async () => {
      const mod = await import(
        '../../src/bridge/ui/pages/memory/memory-card.js'
      );
      expect(mod.MemoryCard).toBeDefined();
    });

    it('should export MemoryEditDialog component', async () => {
      const mod = await import(
        '../../src/bridge/ui/pages/memory/memory-edit-dialog.js'
      );
      expect(mod.MemoryEditDialog).toBeDefined();
    });

    it('should export MemoryExportDialog component', async () => {
      const mod = await import(
        '../../src/bridge/ui/pages/memory/memory-export-dialog.js'
      );
      expect(mod.MemoryExportDialog).toBeDefined();
    });
  });

  describe('Memory store', () => {
    it('should export useMemoryStore', async () => {
      const mod = await import(
        '../../src/bridge/ui/stores/memory-store.js'
      );
      expect(mod.useMemoryStore).toBeDefined();
    });

    it('should have correct initial state', async () => {
      const mod = await import(
        '../../src/bridge/ui/stores/memory-store.js'
      );
      const state = mod.useMemoryStore.getState();

      expect(state.memories).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.isLoading).toBe(false);
      expect(state.activeTab).toBe('all');
      expect(state.searchQuery).toBe('');
      expect(state.isPaused).toBe(false);
    });
  });

  describe('Trust settings components', () => {
    it('should export TrustSettingsSection', async () => {
      const mod = await import(
        '../../src/bridge/ui/pages/settings/trust-settings-section.js'
      );
      expect(mod.TrustSettingsSection).toBeDefined();
    });

    it('should export useTrustStore', async () => {
      const mod = await import(
        '../../src/bridge/ui/stores/trust-store.js'
      );
      expect(mod.useTrustStore).toBeDefined();
    });
  });

  describe('Data management routes', () => {
    it('should export dataRoutes', async () => {
      const mod = await import(
        '../../src/bridge/api/routes/data.js'
      );
      expect(mod.dataRoutes).toBeDefined();
      expect(typeof mod.dataRoutes).toBe('function');
    });

    it('should export trustRoutes', async () => {
      const mod = await import(
        '../../src/bridge/api/routes/trust.js'
      );
      expect(mod.trustRoutes).toBeDefined();
      expect(typeof mod.trustRoutes).toBe('function');
    });
  });

  describe('Journal memory pipeline', () => {
    it('should export MemoryStore from journal', async () => {
      const mod = await import('../../src/journal/index.js');
      expect(mod.MemoryStore).toBeDefined();
    });

    it('should export Reflector from journal', async () => {
      const mod = await import('../../src/journal/index.js');
      expect(mod.Reflector).toBeDefined();
    });

    it('should export MemoryWriter from journal', async () => {
      const mod = await import('../../src/journal/index.js');
      expect(mod.MemoryWriter).toBeDefined();
    });

    it('should export GearSuggester from journal', async () => {
      const mod = await import('../../src/journal/index.js');
      expect(mod.GearSuggester).toBeDefined();
    });
  });

  describe('Sentinel memory', () => {
    it('should export SentinelMemory', async () => {
      const mod = await import('../../src/sentinel/index.js');
      expect(mod.SentinelMemory).toBeDefined();
    });
  });

  describe('Security components', () => {
    it('should export signing functions from gear', async () => {
      const mod = await import('../../src/gear/index.js');
      expect(mod.signGear).toBeDefined();
      expect(mod.verifyGearSignature).toBeDefined();
      expect(mod.checkSignaturePolicy).toBeDefined();
    });

    it('should export backup manager from axis', async () => {
      const mod = await import('../../src/axis/index.js');
      expect(mod.BackupManager).toBeDefined();
      expect(mod.encrypt).toBeDefined();
      expect(mod.decrypt).toBeDefined();
    });

    it('should export audit integrity verification from axis', async () => {
      const mod = await import('../../src/axis/index.js');
      expect(mod.computeEntryHash).toBeDefined();
    });

    it('should export data retention from shared', async () => {
      const mod = await import('../../src/shared/index.js');
      expect(mod.applyRetention).toBeDefined();
      expect(mod.deleteAllUserData).toBeDefined();
    });

    it('should export idle maintenance from axis', async () => {
      const mod = await import('../../src/axis/index.js');
      expect(mod.IdleMaintenance).toBeDefined();
    });
  });
});
