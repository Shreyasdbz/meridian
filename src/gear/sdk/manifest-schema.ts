// @meridian/gear — Gear Manifest JSON Schema (Section 9.4)
// JSON Schema for validating GearManifest structure.
// Used by SDK consumers and the Gear install flow.

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

/**
 * JSON Schema for validating a GearManifest.
 *
 * This schema enforces the structural requirements of a Gear manifest,
 * including identity fields, actions, permissions, and resource limits.
 * It mirrors the validation logic in `src/gear/manifest.ts` but in a
 * portable JSON Schema format that can be used by external tools.
 */
export const GEAR_MANIFEST_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'id',
    'name',
    'version',
    'description',
    'author',
    'license',
    'actions',
    'permissions',
    'origin',
    'checksum',
  ],
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z][a-z0-9-]*$',
      minLength: 1,
      maxLength: 64,
      description: 'Unique Gear identifier (lowercase alphanumeric with hyphens)',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Human-readable Gear name',
    },
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?(?:\\+[\\w.]+)?$',
      description: 'Semantic version (e.g., "1.0.0")',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Short description of the Gear',
    },
    author: {
      type: 'string',
      minLength: 1,
      description: 'Author or organization name',
    },
    license: {
      type: 'string',
      minLength: 1,
      description: 'SPDX license identifier',
    },
    repository: {
      type: 'string',
      description: 'Repository URL',
    },
    actions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'description', 'parameters', 'returns', 'riskLevel'],
        properties: {
          name: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]*$',
            minLength: 1,
            maxLength: 64,
            description: 'Action name (lowercase with underscores)',
          },
          description: {
            type: 'string',
            minLength: 1,
            description: 'Human-readable action description',
          },
          parameters: {
            type: 'object',
            description: 'JSON Schema for action input parameters',
          },
          returns: {
            type: 'object',
            description: 'JSON Schema for action return value',
          },
          riskLevel: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Risk level for Sentinel validation',
          },
        },
        additionalProperties: false,
      },
      description: 'Actions this Gear can perform',
    },
    permissions: {
      type: 'object',
      properties: {
        filesystem: {
          type: 'object',
          properties: {
            read: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              description: 'Glob patterns for readable paths',
            },
            write: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              description: 'Glob patterns for writable paths',
            },
          },
          additionalProperties: false,
        },
        network: {
          type: 'object',
          properties: {
            domains: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              description: 'Allowed domain patterns',
            },
            protocols: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['https', 'http', 'wss', 'ws'],
              },
              description: 'Allowed network protocols',
            },
          },
          additionalProperties: false,
        },
        secrets: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Secret names this Gear can access',
        },
        shell: {
          type: 'boolean',
          description: 'Whether this Gear needs shell access',
        },
        environment: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Environment variable names this Gear can access',
        },
      },
      additionalProperties: false,
      description: 'Required permissions for this Gear',
    },
    resources: {
      type: 'object',
      properties: {
        maxMemoryMb: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Maximum memory in MB',
        },
        maxCpuPercent: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 100,
          description: 'Maximum CPU percentage (0-100)',
        },
        timeoutMs: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Maximum execution time in milliseconds',
        },
        maxNetworkBytesPerCall: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Maximum network bytes per call',
        },
      },
      additionalProperties: false,
      description: 'Resource limits for this Gear',
    },
    origin: {
      type: 'string',
      enum: ['builtin', 'user', 'journal'],
      description: 'Gear origin (builtin, user-installed, or journal-suggested)',
    },
    signature: {
      type: 'string',
      description: 'Ed25519 signature for integrity verification',
    },
    checksum: {
      type: 'string',
      minLength: 1,
      description: 'SHA-256 checksum of the Gear package',
    },
    draft: {
      type: 'boolean',
      description: 'Whether this Gear is in draft/development mode',
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validation result returned by `validateManifest()`.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a manifest object against the Gear manifest JSON Schema.
 *
 * This provides a lightweight schema-level validation. For full validation
 * including vulnerability scanning and resource defaults, use the
 * `validateManifest()` function from `@meridian/gear`.
 *
 * @param manifest - The manifest object to validate
 * @returns Validation result with any errors
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { valid: false, errors: ['Manifest must be a non-null object'] };
  }

  const m = manifest as Record<string, unknown>;
  const schema = GEAR_MANIFEST_SCHEMA;
  const required = schema['required'] as string[];

  // Check required fields
  for (const field of required) {
    if (m[field] === undefined || m[field] === null) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  // Validate id format
  if (typeof m['id'] === 'string') {
    if (!/^[a-z][a-z0-9-]*$/.test(m['id'])) {
      errors.push('Field "id" must match pattern ^[a-z][a-z0-9-]*$');
    }
    if (m['id'].length > 64) {
      errors.push('Field "id" must be at most 64 characters');
    }
  } else if (m['id'] !== undefined && m['id'] !== null) {
    errors.push('Field "id" must be a string');
  }

  // Validate name
  if (typeof m['name'] === 'string') {
    if (m['name'].length === 0) {
      errors.push('Field "name" must not be empty');
    }
    if (m['name'].length > 100) {
      errors.push('Field "name" must be at most 100 characters');
    }
  } else if (m['name'] !== undefined && m['name'] !== null) {
    errors.push('Field "name" must be a string');
  }

  // Validate version
  if (typeof m['version'] === 'string') {
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/.test(m['version'])) {
      errors.push('Field "version" must be a valid semver (e.g., "1.0.0")');
    }
  } else if (m['version'] !== undefined && m['version'] !== null) {
    errors.push('Field "version" must be a string');
  }

  // Validate origin
  if (typeof m['origin'] === 'string') {
    if (!['builtin', 'user', 'journal'].includes(m['origin'])) {
      errors.push('Field "origin" must be "builtin", "user", or "journal"');
    }
  } else if (m['origin'] !== undefined && m['origin'] !== null) {
    errors.push('Field "origin" must be a string');
  }

  // Validate actions
  if (m['actions'] !== undefined && m['actions'] !== null) {
    if (!Array.isArray(m['actions'])) {
      errors.push('Field "actions" must be an array');
    } else if (m['actions'].length === 0) {
      errors.push('Field "actions" must contain at least one action');
    } else {
      const actionNames = new Set<string>();
      for (let i = 0; i < m['actions'].length; i++) {
        const actionRaw: unknown = m['actions'][i];
        if (typeof actionRaw !== 'object' || actionRaw === null) {
          errors.push(`actions[${i}] must be an object`);
          continue;
        }
        validateAction(actionRaw as Record<string, unknown>, i, actionNames, errors);
      }
    }
  }

  // Validate permissions
  if (m['permissions'] !== undefined && m['permissions'] !== null) {
    if (typeof m['permissions'] !== 'object' || Array.isArray(m['permissions'])) {
      errors.push('Field "permissions" must be an object');
    }
  }

  // Validate resources
  if (m['resources'] !== undefined && m['resources'] !== null) {
    if (typeof m['resources'] !== 'object' || Array.isArray(m['resources'])) {
      errors.push('Field "resources" must be an object');
    } else {
      validateResources(m['resources'] as Record<string, unknown>, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Internal validation helpers
// ---------------------------------------------------------------------------

function validateAction(
  action: Record<string, unknown>,
  index: number,
  names: Set<string>,
  errors: string[],
): void {
  const prefix = `actions[${index}]`;

  // Required fields
  for (const field of ['name', 'description'] as const) {
    if (typeof action[field] !== 'string' || action[field].length === 0) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
    }
  }

  // Name format
  if (typeof action['name'] === 'string') {
    if (!/^[a-z][a-z0-9_]*$/.test(action['name'])) {
      errors.push(`${prefix}.name must match pattern ^[a-z][a-z0-9_]*$`);
    }
    if (names.has(action['name'])) {
      errors.push(`${prefix}.name "${action['name']}" is duplicated`);
    }
    names.add(action['name']);
  }

  // Risk level
  if (typeof action['riskLevel'] !== 'string') {
    errors.push(`${prefix}.riskLevel must be a string`);
  } else if (!['low', 'medium', 'high', 'critical'].includes(action['riskLevel'])) {
    errors.push(`${prefix}.riskLevel must be "low", "medium", "high", or "critical"`);
  }

  // Parameters and returns must be objects
  for (const field of ['parameters', 'returns'] as const) {
    if (typeof action[field] !== 'object' || action[field] === null || Array.isArray(action[field])) {
      errors.push(`${prefix}.${field} must be a JSON Schema object`);
    }
  }
}

function validateResources(
  resources: Record<string, unknown>,
  errors: string[],
): void {
  if (resources['maxMemoryMb'] !== undefined) {
    if (typeof resources['maxMemoryMb'] !== 'number' || resources['maxMemoryMb'] <= 0) {
      errors.push('resources.maxMemoryMb must be a positive number');
    }
  }
  if (resources['maxCpuPercent'] !== undefined) {
    if (
      typeof resources['maxCpuPercent'] !== 'number' ||
      resources['maxCpuPercent'] <= 0 ||
      resources['maxCpuPercent'] > 100
    ) {
      errors.push('resources.maxCpuPercent must be between 0 (exclusive) and 100 (inclusive)');
    }
  }
  if (resources['timeoutMs'] !== undefined) {
    if (typeof resources['timeoutMs'] !== 'number' || resources['timeoutMs'] <= 0) {
      errors.push('resources.timeoutMs must be a positive number');
    }
  }
  if (resources['maxNetworkBytesPerCall'] !== undefined) {
    if (
      typeof resources['maxNetworkBytesPerCall'] !== 'number' ||
      resources['maxNetworkBytesPerCall'] <= 0
    ) {
      errors.push('resources.maxNetworkBytesPerCall must be a positive number');
    }
  }
}
