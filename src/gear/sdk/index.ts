// @meridian/gear — Gear SDK (Section 9.4)

// SDK types for Gear developers
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
  GearHandler,
  GearResult,
  GearDefinition,
} from './types.js';

// Manifest JSON Schema & validation
export { GEAR_MANIFEST_SCHEMA, validateManifest } from './manifest-schema.js';
export type { ManifestValidationResult } from './manifest-schema.js';

// Testing utilities
export {
  createMockContext,
  getMockTestData,
  createTestManifest,
  validateHandler,
} from './testing.js';
export type {
  MockContextTestData,
  HandlerValidationResult,
} from './testing.js';
