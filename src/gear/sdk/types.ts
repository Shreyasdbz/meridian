// @meridian/gear — Gear SDK Type Definitions (Section 9.4)
// These are the types that Gear authors need to implement their Gear.
//
// When the Gear SDK is eventually published as @meridian/gear-sdk,
// these types will form its public API.

import type { GearContext, GearManifest } from '@meridian/shared';

export type {
  GearManifest,
  GearAction,
  GearPermissions,
  GearResources,
  GearContext,
  GearOrigin,
  RiskLevel,
  FetchOptions,
  FetchResponse,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// SDK-specific types
// ---------------------------------------------------------------------------

/**
 * A handler function that executes a Gear action.
 *
 * Receives a GearContext with validated parameters and constrained
 * API access (filesystem, network, secrets). Returns a GearResult
 * indicating success or failure.
 *
 * Usage:
 * ```ts
 * const readFile: GearHandler = async (context) => {
 *   const path = context.params.path as string;
 *   const content = await context.readFile(path);
 *   return { success: true, data: { content: content.toString('utf-8') } };
 * };
 * ```
 */
export interface GearHandler {
  (context: GearContext): Promise<GearResult>;
}

/**
 * Result returned from a Gear handler execution.
 */
export interface GearResult {
  /** Whether the action completed successfully. */
  success: boolean;
  /** Result data on success. */
  data?: Record<string, unknown>;
  /** Error message on failure. */
  error?: string;
}

/**
 * Complete Gear definition combining a manifest with handler implementations.
 *
 * Each key in `handlers` must correspond to an action name declared in
 * the manifest. The SDK validates this at registration time.
 *
 * Usage:
 * ```ts
 * const myGear: GearDefinition = {
 *   manifest: {
 *     id: 'my-gear',
 *     name: 'My Gear',
 *     version: '1.0.0',
 *     // ...
 *   },
 *   handlers: {
 *     read_file: async (ctx) => ({ success: true, data: { content: '...' } }),
 *     write_file: async (ctx) => ({ success: true }),
 *   },
 * };
 * ```
 */
export interface GearDefinition {
  manifest: GearManifest;
  handlers: Record<string, GearHandler>;
}
