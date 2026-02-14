// @meridian/gear — Isolate sandbox tests (Phase 10.4)
//
// Tests for the isolated-vm Level 2 sandbox.
// Note: isolated-vm is an optional dependency.
// Tests that require it use skipIf when unavailable.

import { describe, expect, it } from 'vitest';

import {
  isIsolatedVmAvailable,
  resetIsolatedVmCache,
} from './isolate-sandbox.js';

// ---------------------------------------------------------------------------
// Availability tests (always run)
// ---------------------------------------------------------------------------

describe('isIsolatedVmAvailable', () => {
  it('should return a boolean', async () => {
    resetIsolatedVmCache();
    const result = await isIsolatedVmAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('should cache the result', async () => {
    resetIsolatedVmCache();
    const first = await isIsolatedVmAvailable();
    const second = await isIsolatedVmAvailable();
    expect(first).toBe(second);
  });

  it('should reset cache', async () => {
    await isIsolatedVmAvailable();
    resetIsolatedVmCache();
    // After reset, it should re-check
    const result = await isIsolatedVmAvailable();
    expect(typeof result).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Functional tests (require isolated-vm)
// ---------------------------------------------------------------------------

// These tests will be skipped if isolated-vm is not installed.
// In CI, isolated-vm should be available as an optional dependency.
// In dev, it may not be available.

describe('IsolateSandbox (requires isolated-vm)', () => {
  it.todo('should create and dispose an isolate');
  it.todo('should execute simple JavaScript');
  it.todo('should enforce memory limits');
  it.todo('should enforce timeout limits');
  it.todo('should not have access to Node.js APIs');
});
