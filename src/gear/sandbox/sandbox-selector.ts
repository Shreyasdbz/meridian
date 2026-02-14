// @meridian/gear — Sandbox level selection (Phase 10.4)
//
// Determines which sandbox level to use for a Gear:
// - Level 1: child_process.fork() — always available, default
// - Level 2: isolated-vm — if package available and manifest allows
// - Level 3: Docker — if Docker available and manifest/config requests it

import type { GearManifest } from '@meridian/shared';

import { isDockerAvailable } from './container-sandbox.js';
import { isIsolatedVmAvailable } from './isolate-sandbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SandboxLevel = 1 | 2 | 3;

export interface SandboxSelectionConfig {
  /** Preferred sandbox level. Actual level may be lower if deps unavailable. */
  preferredLevel?: SandboxLevel;
  /** Force a specific sandbox level (no fallback). */
  forceLevel?: SandboxLevel;
  /** Logger. */
  logger?: SandboxSelectorLogger;
}

export interface SandboxSelectorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface SandboxSelection {
  level: SandboxLevel;
  reason: string;
}

// ---------------------------------------------------------------------------
// Selection logic
// ---------------------------------------------------------------------------

/**
 * Select the appropriate sandbox level for a Gear.
 *
 * Decision logic:
 * 1. If forceLevel is set, use it (no fallback — may throw if unavailable)
 * 2. If manifest declares sandboxLevel, respect it
 * 3. If manifest needs filesystem or network, must use Level 1 or 3 (not 2)
 * 4. Try preferred level, falling back to lower levels if unavailable
 * 5. Default: Level 1 (always available)
 */
export async function selectSandboxLevel(
  manifest: GearManifest,
  config: SandboxSelectionConfig = {},
): Promise<SandboxSelection> {
  const { preferredLevel, forceLevel, logger } = config;

  // Check if manifest explicitly requests a level (via resources field)
  const manifestLevel = manifest.resources?.['sandboxLevel' as keyof typeof manifest.resources] as SandboxLevel | undefined;

  // Force level — no fallback
  if (forceLevel) {
    logger?.debug('Forced sandbox level', { level: forceLevel, gearId: manifest.id });
    return { level: forceLevel, reason: `Forced to Level ${forceLevel}` };
  }

  const targetLevel = manifestLevel ?? preferredLevel ?? 1;

  // Check if Gear needs filesystem or network (requires Level 1 or 3, not 2)
  const needsFs = hasFilesystemAccess(manifest);
  const needsNet = hasNetworkAccess(manifest);

  if (targetLevel === 2 && (needsFs || needsNet)) {
    logger?.info('Gear needs filesystem/network, cannot use Level 2 (isolate)', {
      gearId: manifest.id,
      needsFs,
      needsNet,
    });
    return { level: 1, reason: 'Level 2 incompatible: Gear needs filesystem/network access' };
  }

  // Try Level 3 (Docker)
  if (targetLevel >= 3) {
    const dockerOk = await isDockerAvailable();
    if (dockerOk) {
      return { level: 3, reason: 'Docker available' };
    }
    logger?.warn('Docker not available, falling back', { gearId: manifest.id });
  }

  // Try Level 2 (isolated-vm)
  if (targetLevel >= 2 && !needsFs && !needsNet) {
    const ivmOk = await isIsolatedVmAvailable();
    if (ivmOk) {
      return { level: 2, reason: 'isolated-vm available' };
    }
    logger?.warn('isolated-vm not available, falling back to Level 1', {
      gearId: manifest.id,
    });
  }

  // Default: Level 1 (always available)
  return { level: 1, reason: 'Default process sandbox' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFilesystemAccess(manifest: GearManifest): boolean {
  const perms = manifest.permissions;
  return (
    (perms.filesystem?.read !== undefined && perms.filesystem.read.length > 0) ||
    (perms.filesystem?.write !== undefined && perms.filesystem.write.length > 0)
  );
}

function hasNetworkAccess(manifest: GearManifest): boolean {
  const perms = manifest.permissions;
  return (
    perms.network !== undefined &&
    (perms.network.domains !== undefined && perms.network.domains.length > 0)
  );
}
