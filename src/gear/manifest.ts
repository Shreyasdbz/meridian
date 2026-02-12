// @meridian/gear — Gear manifest parsing, validation, and integrity (Section 5.6.2, 5.6.4)

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { Ajv } from 'ajv';

import type { GearManifest, Result } from '@meridian/shared';
import {
  ok,
  err,
  ValidationError,
  DEFAULT_GEAR_MEMORY_MB,
  DEFAULT_GEAR_CPU_PERCENT,
  DEFAULT_GEAR_TIMEOUT_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Category of manifest validation issue.
 */
export type ManifestIssueType =
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_version'
  | 'invalid_action'
  | 'invalid_permissions'
  | 'invalid_resources'
  | 'duplicate_action'
  | 'vulnerability_detected';

/**
 * A single validation issue found during manifest validation.
 */
export interface ManifestIssue {
  type: ManifestIssueType;
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Semver regex (loose — accepts x.y.z with optional pre-release and build) */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

/** Valid Gear ID pattern: lowercase alphanumeric with hyphens */
const GEAR_ID_RE = /^[a-z][a-z0-9-]*$/;

/** Maximum length for Gear ID */
const MAX_GEAR_ID_LENGTH = 64;

/** Maximum length for action name */
const MAX_ACTION_NAME_LENGTH = 64;

/** Valid action name pattern: lowercase alphanumeric with underscores */
const ACTION_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Valid network domain pattern */
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** Valid SPDX license identifiers (common subset) */
const KNOWN_LICENSES = new Set([
  'Apache-2.0', 'MIT', 'GPL-2.0', 'GPL-3.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'ISC', 'MPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'Unlicense', 'CC0-1.0',
  'AGPL-3.0', 'Proprietary',
]);

/** Valid network protocols */
const VALID_PROTOCOLS = new Set(['https', 'http', 'wss', 'ws']);

/** Valid risk levels */
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

/** Valid Gear origins */
const VALID_ORIGINS = new Set(['builtin', 'user', 'journal']);

/**
 * Known vulnerability patterns checked at install time (Section 5.6.4).
 * These are structural red flags in manifests or dependency declarations.
 */
const VULNERABILITY_PATTERNS: Array<{
  id: string;
  description: string;
  check: (manifest: GearManifest) => boolean;
}> = [
  {
    id: 'VULN_SHELL_WITH_NETWORK',
    description: 'Gear requests both shell access and network access — potential exfiltration vector',
    check: (m) =>
      m.permissions.shell === true &&
      (m.permissions.network?.domains ?? []).length > 0,
  },
  {
    id: 'VULN_WILDCARD_FILESYSTEM',
    description: 'Gear requests wildcard filesystem access — overly broad permissions',
    check: (m) => {
      const readPaths = m.permissions.filesystem?.read ?? [];
      const writePaths = m.permissions.filesystem?.write ?? [];
      return [...readPaths, ...writePaths].some(
        (p) => p === '**' || p === '/**' || p === '*' || p === '/*',
      );
    },
  },
  {
    id: 'VULN_WILDCARD_NETWORK',
    description: 'Gear requests wildcard network access — overly broad permissions',
    check: (m) =>
      (m.permissions.network?.domains ?? []).some((d) => d === '*'),
  },
  {
    id: 'VULN_EXCESSIVE_SECRETS',
    description: 'Gear requests more than 10 secrets — unusually high for a single plugin',
    check: (m) => (m.permissions.secrets ?? []).length > 10,
  },
  {
    id: 'VULN_SHELL_DEFAULT_ENABLED',
    description: 'Gear requests shell access — shell Gear should be disabled by default',
    check: (m) => m.permissions.shell === true && m.origin !== 'builtin',
  },
];

// ---------------------------------------------------------------------------
// AJV instance for action parameter/return schema validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/**
 * Validate a GearManifest object against all structural rules.
 *
 * Returns `ok(manifest)` with resource defaults applied, or `err(issues)`
 * with every issue found (non-short-circuiting).
 */
export function validateManifest(
  manifest: unknown,
): Result<GearManifest, ManifestIssue[]> {
  const issues: ManifestIssue[] = [];

  // First, validate that the input is an object
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    issues.push({
      type: 'missing_field',
      field: '',
      message: 'Manifest must be a non-null object',
    });
    return err(issues);
  }

  const m = manifest as Record<string, unknown>;

  // --- Identity fields ---
  validateRequiredString(m, 'id', issues);
  validateRequiredString(m, 'name', issues);
  validateRequiredString(m, 'version', issues);
  validateRequiredString(m, 'description', issues);
  validateRequiredString(m, 'author', issues);
  validateRequiredString(m, 'license', issues);
  validateRequiredString(m, 'checksum', issues);

  // ID format
  if (typeof m.id === 'string') {
    if (!GEAR_ID_RE.test(m.id)) {
      issues.push({
        type: 'invalid_field',
        field: 'id',
        message: 'Gear ID must be lowercase alphanumeric with hyphens, starting with a letter',
      });
    }
    if (m.id.length > MAX_GEAR_ID_LENGTH) {
      issues.push({
        type: 'invalid_field',
        field: 'id',
        message: `Gear ID must be at most ${MAX_GEAR_ID_LENGTH} characters`,
      });
    }
  }

  // Version format (semver)
  if (typeof m.version === 'string' && !SEMVER_RE.test(m.version)) {
    issues.push({
      type: 'invalid_version',
      field: 'version',
      message: 'Version must follow semver format (e.g., "1.0.0")',
    });
  }

  // License validation
  if (typeof m.license === 'string' && !KNOWN_LICENSES.has(m.license)) {
    issues.push({
      type: 'invalid_field',
      field: 'license',
      message: `Unknown license identifier: '${m.license}'. Use a valid SPDX identifier.`,
    });
  }

  // Origin validation
  if (m.origin === undefined || m.origin === null) {
    issues.push({
      type: 'missing_field',
      field: 'origin',
      message: 'Manifest must include "origin" field',
    });
  } else if (typeof m.origin !== 'string' || !VALID_ORIGINS.has(m.origin)) {
    issues.push({
      type: 'invalid_field',
      field: 'origin',
      message: `Origin must be one of: ${[...VALID_ORIGINS].join(', ')}`,
    });
  }

  // Optional: repository URL
  if (m.repository !== undefined && typeof m.repository !== 'string') {
    issues.push({
      type: 'invalid_field',
      field: 'repository',
      message: 'Repository must be a string URL',
    });
  }

  // Optional: draft boolean
  if (m.draft !== undefined && typeof m.draft !== 'boolean') {
    issues.push({
      type: 'invalid_field',
      field: 'draft',
      message: 'Draft must be a boolean',
    });
  }

  // Optional: signature string (cryptographic verification deferred to v0.2 — Ed25519)
  if (m.signature !== undefined && typeof m.signature !== 'string') {
    issues.push({
      type: 'invalid_field',
      field: 'signature',
      message: 'Signature must be a string',
    });
  }

  // --- Actions ---
  if (!Array.isArray(m.actions)) {
    issues.push({
      type: 'missing_field',
      field: 'actions',
      message: 'Manifest must include an "actions" array',
    });
  } else if (m.actions.length === 0) {
    issues.push({
      type: 'invalid_field',
      field: 'actions',
      message: 'Manifest must declare at least one action',
    });
  } else {
    validateActions(m.actions as unknown[], issues);
  }

  // --- Permissions ---
  if (m.permissions === undefined || m.permissions === null) {
    issues.push({
      type: 'missing_field',
      field: 'permissions',
      message: 'Manifest must include a "permissions" object',
    });
  } else if (typeof m.permissions !== 'object' || Array.isArray(m.permissions)) {
    issues.push({
      type: 'invalid_permissions',
      field: 'permissions',
      message: 'Permissions must be a non-null object',
    });
  } else {
    validatePermissions(m.permissions as Record<string, unknown>, issues);
  }

  // --- Resources ---
  if (m.resources !== undefined) {
    if (typeof m.resources !== 'object' || m.resources === null || Array.isArray(m.resources)) {
      issues.push({
        type: 'invalid_resources',
        field: 'resources',
        message: 'Resources must be a non-null object',
      });
    } else {
      validateResources(m.resources as Record<string, unknown>, issues);
    }
  }

  // If there are structural issues, return before vulnerability scanning
  if (issues.length > 0) {
    return err(issues);
  }

  // Cast to GearManifest now that structure is validated
  const validManifest = manifest as GearManifest;

  // Apply resource defaults
  const withDefaults = applyResourceDefaults(validManifest);

  // --- Vulnerability scanning (Section 5.6.4) ---
  const vulnIssues = scanVulnerabilities(withDefaults);
  if (vulnIssues.length > 0) {
    return err(vulnIssues);
  }

  return ok(withDefaults);
}

// ---------------------------------------------------------------------------
// Actions validation
// ---------------------------------------------------------------------------

function validateActions(actions: unknown[], issues: ManifestIssue[]): void {
  const actionNames = new Set<string>();

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const prefix = `actions[${i}]`;

    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
      issues.push({
        type: 'invalid_action',
        field: prefix,
        message: `Action at index ${i} must be a non-null object`,
      });
      continue;
    }

    const a = action as Record<string, unknown>;

    // Required string fields
    for (const field of ['name', 'description'] as const) {
      const fieldVal = a[field];
      if (typeof fieldVal !== 'string' || fieldVal.length === 0) {
        issues.push({
          type: 'invalid_action',
          field: `${prefix}.${field}`,
          message: `Action "${field}" must be a non-empty string`,
        });
      }
    }

    // Action name format
    if (typeof a.name === 'string') {
      if (!ACTION_NAME_RE.test(a.name)) {
        issues.push({
          type: 'invalid_action',
          field: `${prefix}.name`,
          message: 'Action name must be lowercase alphanumeric with underscores, starting with a letter',
        });
      }
      if (a.name.length > MAX_ACTION_NAME_LENGTH) {
        issues.push({
          type: 'invalid_action',
          field: `${prefix}.name`,
          message: `Action name must be at most ${MAX_ACTION_NAME_LENGTH} characters`,
        });
      }

      // Duplicate check
      if (actionNames.has(a.name)) {
        issues.push({
          type: 'duplicate_action',
          field: `${prefix}.name`,
          message: `Duplicate action name: '${a.name}'`,
        });
      }
      actionNames.add(a.name);
    }

    // Risk level
    if (typeof a.riskLevel !== 'string' || !VALID_RISK_LEVELS.has(a.riskLevel)) {
      issues.push({
        type: 'invalid_action',
        field: `${prefix}.riskLevel`,
        message: `Action riskLevel must be one of: ${[...VALID_RISK_LEVELS].join(', ')}`,
      });
    }

    // Parameters and returns must be objects (JSON Schema)
    for (const schemaField of ['parameters', 'returns'] as const) {
      if (
        typeof a[schemaField] !== 'object' ||
        a[schemaField] === null ||
        Array.isArray(a[schemaField])
      ) {
        issues.push({
          type: 'invalid_action',
          field: `${prefix}.${schemaField}`,
          message: `Action "${schemaField}" must be a JSON Schema object`,
        });
      } else {
        // Validate that it's a valid JSON Schema by trying to compile it
        try {
          ajv.compile(a[schemaField] as Record<string, unknown>);
        } catch {
          issues.push({
            type: 'invalid_action',
            field: `${prefix}.${schemaField}`,
            message: `Action "${schemaField}" is not a valid JSON Schema`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Permissions validation
// ---------------------------------------------------------------------------

function validatePermissions(
  perms: Record<string, unknown>,
  issues: ManifestIssue[],
): void {
  // Filesystem permissions
  if (perms.filesystem !== undefined) {
    if (typeof perms.filesystem !== 'object' || perms.filesystem === null || Array.isArray(perms.filesystem)) {
      issues.push({
        type: 'invalid_permissions',
        field: 'permissions.filesystem',
        message: 'Filesystem permissions must be an object',
      });
    } else {
      const fs = perms.filesystem as Record<string, unknown>;
      for (const key of ['read', 'write'] as const) {
        if (fs[key] !== undefined) {
          if (!Array.isArray(fs[key])) {
            issues.push({
              type: 'invalid_permissions',
              field: `permissions.filesystem.${key}`,
              message: `Filesystem ${key} paths must be an array of strings`,
            });
          } else {
            for (let i = 0; i < (fs[key] as unknown[]).length; i++) {
              const path = (fs[key] as unknown[])[i];
              if (typeof path !== 'string' || path.length === 0) {
                issues.push({
                  type: 'invalid_permissions',
                  field: `permissions.filesystem.${key}[${i}]`,
                  message: 'Filesystem path must be a non-empty string',
                });
              } else if (path.includes('..')) {
                issues.push({
                  type: 'invalid_permissions',
                  field: `permissions.filesystem.${key}[${i}]`,
                  message: 'Filesystem path must not contain ".." (directory traversal)',
                });
              }
            }
          }
        }
      }
    }
  }

  // Network permissions
  if (perms.network !== undefined) {
    if (typeof perms.network !== 'object' || perms.network === null || Array.isArray(perms.network)) {
      issues.push({
        type: 'invalid_permissions',
        field: 'permissions.network',
        message: 'Network permissions must be an object',
      });
    } else {
      const net = perms.network as Record<string, unknown>;

      if (net.domains !== undefined) {
        if (!Array.isArray(net.domains)) {
          issues.push({
            type: 'invalid_permissions',
            field: 'permissions.network.domains',
            message: 'Network domains must be an array of strings',
          });
        } else {
          const domains = net.domains as unknown[];
          for (let i = 0; i < domains.length; i++) {
            const domain: unknown = domains[i];
            if (typeof domain !== 'string' || domain.length === 0) {
              issues.push({
                type: 'invalid_permissions',
                field: `permissions.network.domains[${i}]`,
                message: 'Network domain must be a non-empty string',
              });
            } else if (domain !== '*' && !DOMAIN_RE.test(domain)) {
              issues.push({
                type: 'invalid_permissions',
                field: `permissions.network.domains[${i}]`,
                message: `Invalid domain pattern: '${domain}'`,
              });
            }
          }
        }
      }

      if (net.protocols !== undefined) {
        if (!Array.isArray(net.protocols)) {
          issues.push({
            type: 'invalid_permissions',
            field: 'permissions.network.protocols',
            message: 'Network protocols must be an array of strings',
          });
        } else {
          const protocols = net.protocols as unknown[];
          for (let i = 0; i < protocols.length; i++) {
            const proto: unknown = protocols[i];
            if (typeof proto !== 'string' || !VALID_PROTOCOLS.has(proto)) {
              issues.push({
                type: 'invalid_permissions',
                field: `permissions.network.protocols[${i}]`,
                message: `Invalid protocol: '${String(proto)}'. Must be one of: ${[...VALID_PROTOCOLS].join(', ')}`,
              });
            }
          }
        }
      }
    }
  }

  // Secrets
  if (perms.secrets !== undefined) {
    if (!Array.isArray(perms.secrets)) {
      issues.push({
        type: 'invalid_permissions',
        field: 'permissions.secrets',
        message: 'Secrets must be an array of strings',
      });
    } else {
      for (let i = 0; i < perms.secrets.length; i++) {
        if (typeof perms.secrets[i] !== 'string' || (perms.secrets[i] as string).length === 0) {
          issues.push({
            type: 'invalid_permissions',
            field: `permissions.secrets[${i}]`,
            message: 'Secret name must be a non-empty string',
          });
        }
      }
    }
  }

  // Shell
  if (perms.shell !== undefined && typeof perms.shell !== 'boolean') {
    issues.push({
      type: 'invalid_permissions',
      field: 'permissions.shell',
      message: 'Shell permission must be a boolean',
    });
  }

  // Environment variables
  if (perms.environment !== undefined) {
    if (!Array.isArray(perms.environment)) {
      issues.push({
        type: 'invalid_permissions',
        field: 'permissions.environment',
        message: 'Environment variables must be an array of strings',
      });
    } else {
      for (let i = 0; i < perms.environment.length; i++) {
        if (typeof perms.environment[i] !== 'string' || (perms.environment[i] as string).length === 0) {
          issues.push({
            type: 'invalid_permissions',
            field: `permissions.environment[${i}]`,
            message: 'Environment variable name must be a non-empty string',
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Resources validation
// ---------------------------------------------------------------------------

function validateResources(
  resources: Record<string, unknown>,
  issues: ManifestIssue[],
): void {
  if (resources.maxMemoryMb !== undefined) {
    if (typeof resources.maxMemoryMb !== 'number' || resources.maxMemoryMb <= 0) {
      issues.push({
        type: 'invalid_resources',
        field: 'resources.maxMemoryMb',
        message: 'maxMemoryMb must be a positive number',
      });
    }
  }

  if (resources.maxCpuPercent !== undefined) {
    if (
      typeof resources.maxCpuPercent !== 'number' ||
      resources.maxCpuPercent <= 0 ||
      resources.maxCpuPercent > 100
    ) {
      issues.push({
        type: 'invalid_resources',
        field: 'resources.maxCpuPercent',
        message: 'maxCpuPercent must be a number between 0 (exclusive) and 100 (inclusive)',
      });
    }
  }

  if (resources.timeoutMs !== undefined) {
    if (typeof resources.timeoutMs !== 'number' || resources.timeoutMs <= 0) {
      issues.push({
        type: 'invalid_resources',
        field: 'resources.timeoutMs',
        message: 'timeoutMs must be a positive number',
      });
    }
  }

  if (resources.maxNetworkBytesPerCall !== undefined) {
    if (
      typeof resources.maxNetworkBytesPerCall !== 'number' ||
      resources.maxNetworkBytesPerCall <= 0
    ) {
      issues.push({
        type: 'invalid_resources',
        field: 'resources.maxNetworkBytesPerCall',
        message: 'maxNetworkBytesPerCall must be a positive number',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Resource defaults
// ---------------------------------------------------------------------------

/**
 * Apply default resource limits to a validated manifest (Section 5.6.2).
 */
function applyResourceDefaults(manifest: GearManifest): GearManifest {
  return {
    ...manifest,
    resources: {
      maxMemoryMb: manifest.resources?.maxMemoryMb ?? DEFAULT_GEAR_MEMORY_MB,
      maxCpuPercent: manifest.resources?.maxCpuPercent ?? DEFAULT_GEAR_CPU_PERCENT,
      timeoutMs: manifest.resources?.timeoutMs ?? DEFAULT_GEAR_TIMEOUT_MS,
      maxNetworkBytesPerCall: manifest.resources?.maxNetworkBytesPerCall,
    },
  };
}

// ---------------------------------------------------------------------------
// Vulnerability scanning (Section 5.6.4)
// ---------------------------------------------------------------------------

/**
 * Scan a validated manifest for known vulnerability patterns.
 */
function scanVulnerabilities(manifest: GearManifest): ManifestIssue[] {
  const vulnIssues: ManifestIssue[] = [];

  for (const pattern of VULNERABILITY_PATTERNS) {
    if (pattern.check(manifest)) {
      vulnIssues.push({
        type: 'vulnerability_detected',
        field: pattern.id,
        message: pattern.description,
      });
    }
  }

  return vulnIssues;
}

// ---------------------------------------------------------------------------
// Checksum computation (SHA-256)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 checksum of a Gear package file.
 * Used at install time and for execution-time integrity verification (Section 5.6.3).
 */
export function computeChecksum(packagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(packagePath);

    stream.on('data', (chunk: Buffer) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (error: Error) => {
      reject(new ValidationError(`Failed to compute checksum: ${error.message}`));
    });
  });
}

/**
 * Compute the SHA-256 checksum of a Buffer (for in-memory data).
 * Useful for testing or when the package content is already loaded.
 */
export function computeChecksumFromBuffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateRequiredString(
  obj: Record<string, unknown>,
  field: string,
  issues: ManifestIssue[],
): void {
  const val = obj[field];
  if (typeof val !== 'string' || val.length === 0) {
    issues.push({
      type: 'missing_field',
      field,
      message: `Manifest must include a non-empty "${field}" string`,
    });
  }
}
