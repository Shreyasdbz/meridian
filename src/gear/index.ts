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

// Process sandbox: Level 1 sandbox with OS-level restrictions (Phase 5.2)
export {
  createSandbox,
  destroySandbox,
  signMessage,
  verifySignature,
  generateSigningKey,
  generateSeatbeltProfile,
  generateSeccompProfile,
  buildSandboxEnv,
  injectSecrets,
  cleanupSecrets,
  isPathAllowed,
  isDomainAllowed,
} from './sandbox/process-sandbox.js';
export type {
  SandboxRequest,
  SandboxResponse,
  SandboxProgress,
  SandboxStdoutMessage,
  SandboxOptions,
  SandboxLogger,
  SandboxHandle,
  SeccompProfile,
} from './sandbox/process-sandbox.js';

// Gear host: host-side process management and communication (Phase 5.2)
export { GearHost } from './sandbox/gear-host.js';
export type {
  GearExecutionResult,
  ExecuteActionOptions,
  ProgressCallback,
  GearHostConfig,
} from './sandbox/gear-host.js';

// Gear context: constrained API for Gear code inside the sandbox (Phase 5.3)
export {
  GearContextImpl,
  createGearContext,
  validatePath,
  validateUrl,
  isPrivateIp,
  checkDnsRebinding,
} from './context.js';
export type {
  SecretProvider,
  SubJobCreator,
  LogSink,
  ProgressSink,
  GearContextConfig,
  DnsResolver,
} from './context.js';

// Gear runtime: runs inside the sandbox process (Phase 5.3)
export { startRuntime } from './sandbox/gear-runtime.js';
