// @meridian/gear — Container sandbox tests (Phase 10.4)

import { describe, expect, it } from 'vitest';

import type { GearManifest } from '@meridian/shared';

import { buildDockerArgs } from './container-sandbox.js';

// ---------------------------------------------------------------------------
// Test manifest
// ---------------------------------------------------------------------------

const testManifest: GearManifest = {
  id: 'test-gear',
  name: 'Test Gear',
  version: '1.0.0',
  description: 'A test Gear',
  author: 'test',
  license: 'MIT',
  origin: 'user',
  checksum: 'abc123',
  actions: [
    {
      name: 'run',
      description: 'Run the Gear',
      parameters: { type: 'object' },
      returns: { type: 'object' },
      riskLevel: 'low',
    },
  ],
  permissions: {},
  resources: {
    maxMemoryMb: 256,
    maxCpuPercent: 50,
    timeoutMs: 30000,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDockerArgs', () => {
  it('should include read-only root filesystem', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    expect(args).toContain('--read-only');
  });

  it('should disable networking', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    expect(args).toContain('--network=none');
  });

  it('should set memory limit', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
      memoryLimit: '512m',
    });

    expect(args).toContain('--memory=512m');
  });

  it('should set CPU limit', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
      cpuLimit: '1.0',
    });

    expect(args).toContain('--cpus=1.0');
  });

  it('should set pids limit', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
      pidsLimit: 32,
    });

    expect(args).toContain('--pids-limit=32');
  });

  it('should mount workspace read-only', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    const mountArg = args.find((a) => a.startsWith('-v='));
    expect(mountArg).toBeTruthy();
    expect(mountArg).toContain('/data/workspace');
    expect(mountArg).toContain(':ro');
  });

  it('should include tmpfs for secrets', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    const secretsTmpfs = args.find((a) => a.includes('/secrets'));
    expect(secretsTmpfs).toBeTruthy();
    expect(secretsTmpfs).toContain('noexec');
    expect(secretsTmpfs).toContain('nosuid');
  });

  it('should include tmpfs for /tmp', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    const tmpTmpfs = args.find((a) => a.includes('/tmp'));
    expect(tmpTmpfs).toBeTruthy();
  });

  it('should prevent privilege escalation', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('should use default image when not specified', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    expect(args).toContain('node:20-slim');
  });

  it('should use custom image when specified', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
      image: 'custom:latest',
    });

    expect(args).toContain('custom:latest');
  });

  it('should include Gear ID in container name', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    const nameArg = args.find((a) => a.startsWith('--name='));
    expect(nameArg).toBeTruthy();
    expect(nameArg).toContain('test-gear');
  });

  it('should run detached with auto-remove', () => {
    const args = buildDockerArgs({
      manifest: testManifest,
      workspacePath: '/data/workspace',
    });

    expect(args).toContain('--rm');
    expect(args).toContain('-d');
  });
});
