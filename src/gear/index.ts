// @meridian/gear — public API

// Manifest parsing, validation, and checksum (Phase 5.1)
export { validateManifest, computeChecksum, computeChecksumFromBuffer } from './manifest.js';
export type { ManifestIssueType, ManifestIssue } from './manifest.js';

// Gear registry: CRUD, cache, GearLookup (Phase 5.1)
export { GearRegistry } from './registry.js';
export type {
  GearListFilter,
  RegistryLogger,
  BuiltinGearDefinition,
} from './registry.js';
