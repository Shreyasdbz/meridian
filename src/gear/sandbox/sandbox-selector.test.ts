// @meridian/gear — Sandbox selector tests (Phase 10.4)

import { describe, expect, it, vi } from 'vitest';

import type { GearManifest } from '@meridian/shared';

import * as containerSandbox from './container-sandbox.js';
import * as isolateSandbox from './isolate-sandbox.js';
import { selectSandboxLevel } from './sandbox-selector.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./container-sandbox.js', async (importOriginal) => {
  const original = await importOriginal<typeof containerSandbox>();
  return {
    ...original,
    isDockerAvailable: vi.fn(),
  };
});

vi.mock('./isolate-sandbox.js', async (importOriginal) => {
  const original = await importOriginal<typeof isolateSandbox>();
  return {
    ...original,
    isIsolatedVmAvailable: vi.fn(),
  };
});

const mockDockerAvailable = vi.mocked(containerSandbox.isDockerAvailable);
const mockIvmAvailable = vi.mocked(isolateSandbox.isIsolatedVmAvailable);

// ---------------------------------------------------------------------------
// Test manifests
// ---------------------------------------------------------------------------

const testAction = {
  name: 'run',
  description: 'Run',
  parameters: { type: 'object' },
  returns: { type: 'object' },
  riskLevel: 'low' as const,
};

const simpleManifest: GearManifest = {
  id: 'simple-gear',
  name: 'Simple Gear',
  version: '1.0.0',
  description: 'No filesystem or network',
  author: 'test',
  license: 'MIT',
  origin: 'user',
  checksum: 'abc123',
  actions: [testAction],
  permissions: {},
};

const fsManifest: GearManifest = {
  id: 'fs-gear',
  name: 'FS Gear',
  version: '1.0.0',
  description: 'Needs filesystem',
  author: 'test',
  license: 'MIT',
  origin: 'user',
  checksum: 'abc123',
  actions: [testAction],
  permissions: {
    filesystem: { read: ['/data/workspace'] },
  },
};

const networkManifest: GearManifest = {
  id: 'net-gear',
  name: 'Net Gear',
  version: '1.0.0',
  description: 'Needs network',
  author: 'test',
  license: 'MIT',
  origin: 'user',
  checksum: 'abc123',
  actions: [testAction],
  permissions: {
    network: { domains: ['api.example.com'] },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectSandboxLevel', () => {
  it('should default to Level 1', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(false);

    const result = await selectSandboxLevel(simpleManifest);
    expect(result.level).toBe(1);
  });

  it('should select Level 2 when preferred and available', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(true);

    const result = await selectSandboxLevel(simpleManifest, { preferredLevel: 2 });
    expect(result.level).toBe(2);
  });

  it('should fall back to Level 1 when Level 2 preferred but unavailable', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(false);

    const result = await selectSandboxLevel(simpleManifest, { preferredLevel: 2 });
    expect(result.level).toBe(1);
  });

  it('should select Level 3 when preferred and Docker available', async () => {
    mockDockerAvailable.mockResolvedValue(true);
    mockIvmAvailable.mockResolvedValue(false);

    const result = await selectSandboxLevel(simpleManifest, { preferredLevel: 3 });
    expect(result.level).toBe(3);
  });

  it('should fall back from Level 3 when Docker unavailable', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(true);

    const result = await selectSandboxLevel(simpleManifest, { preferredLevel: 3 });
    expect(result.level).toBe(2);
  });

  it('should not use Level 2 when Gear needs filesystem', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(true);

    const result = await selectSandboxLevel(fsManifest, { preferredLevel: 2 });
    expect(result.level).toBe(1);
    expect(result.reason).toContain('filesystem/network');
  });

  it('should not use Level 2 when Gear needs network', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(true);

    const result = await selectSandboxLevel(networkManifest, { preferredLevel: 2 });
    expect(result.level).toBe(1);
    expect(result.reason).toContain('filesystem/network');
  });

  it('should respect forced level', async () => {
    mockDockerAvailable.mockResolvedValue(false);
    mockIvmAvailable.mockResolvedValue(false);

    const result = await selectSandboxLevel(simpleManifest, { forceLevel: 3 });
    expect(result.level).toBe(3);
    expect(result.reason).toContain('Forced');
  });

  it('should respect manifest-level sandboxLevel in resources', async () => {
    mockDockerAvailable.mockResolvedValue(true);
    mockIvmAvailable.mockResolvedValue(false);

    const manifest: GearManifest = {
      ...simpleManifest,
      resources: { sandboxLevel: 3 } as GearManifest['resources'],
    };

    const result = await selectSandboxLevel(manifest);
    expect(result.level).toBe(3);
  });
});
