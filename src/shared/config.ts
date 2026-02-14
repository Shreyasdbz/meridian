// @meridian/shared — Configuration loading with precedence hierarchy
// Precedence: defaults → config file → environment variables → database config table

import { readFileSync, existsSync } from 'node:fs';
import { arch, totalmem } from 'node:os';

import { parse as parseTOML } from 'smol-toml';

import {
  DEFAULT_WORKERS_PI,
  DEFAULT_WORKERS_DESKTOP,
  DEFAULT_WORKERS_VPS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_DAILY_COST_LIMIT_USD,
  DEFAULT_SESSION_DURATION_HOURS,
} from './constants.js';
import type { DeploymentTier } from './database/types.js';
import { ValidationError } from './errors.js';
import type { Result } from './result.js';
import { ok, err } from './result.js';

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

export interface AxisConfig {
  workers: number;
  jobTimeoutMs: number;
}

export interface ScoutModelsConfig {
  primary: string;
  secondary: string;
}

export interface ScoutConfig {
  provider: string;
  maxContextTokens: number;
  temperature: number;
  models: ScoutModelsConfig;
}

export interface SentinelConfig {
  provider: string;
  model: string;
  maxContextTokens: number;
}

export interface JournalConfig {
  embeddingProvider: string;
  embeddingModel: string;
  episodeRetentionDays: number;
  reflectionEnabled: boolean;
}

export interface BridgeConfig {
  bind: string;
  port: number;
  sessionDurationHours: number;
  tls?: {
    enabled: boolean;
    certPath: string;
    keyPath: string;
    minVersion?: 'TLSv1.2' | 'TLSv1.3';
    hsts?: boolean;
    hstsMaxAge?: number;
  };
}

export interface SecurityConfig {
  dailyCostLimitUsd: number;
  requireApprovalFor: string[];
}

export interface EncryptionToggleConfig {
  enabled: boolean;
}

export interface MeridianConfig {
  axis: AxisConfig;
  scout: ScoutConfig;
  sentinel: SentinelConfig;
  journal: JournalConfig;
  bridge: BridgeConfig;
  security: SecurityConfig;
  encryption?: EncryptionToggleConfig;
}

/** Deep partial type that preserves arrays as-is. */
export type DeepPartial<T> = T extends unknown[]
  ? T
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T;

export interface LoadConfigOptions {
  /** Path to config.toml. Default: 'data/config.toml' */
  configPath?: string;
  /** Explicit deployment tier override. Auto-detected if omitted. */
  tier?: DeploymentTier;
  /** Overrides from database config table (highest precedence). */
  dbOverrides?: DeepPartial<MeridianConfig>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const WORKERS_BY_TIER: Record<DeploymentTier, number> = {
  pi: DEFAULT_WORKERS_PI,
  desktop: DEFAULT_WORKERS_DESKTOP,
  vps: DEFAULT_WORKERS_VPS,
};

export function getDefaultConfig(tier: DeploymentTier): MeridianConfig {
  return {
    axis: {
      workers: WORKERS_BY_TIER[tier],
      jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
    },
    scout: {
      provider: 'anthropic',
      maxContextTokens: 100_000,
      temperature: 0.3,
      models: {
        primary: 'claude-sonnet-4-5-20250929',
        secondary: 'claude-haiku-4-5-20251001',
      },
    },
    sentinel: {
      provider: 'openai',
      model: 'gpt-4o',
      maxContextTokens: 32_000,
    },
    journal: {
      embeddingProvider: 'local',
      embeddingModel: 'nomic-embed-text',
      episodeRetentionDays: 90,
      reflectionEnabled: true,
    },
    bridge: {
      bind: '127.0.0.1',
      port: 3000,
      sessionDurationHours: DEFAULT_SESSION_DURATION_HOURS,
    },
    security: {
      dailyCostLimitUsd: DEFAULT_DAILY_COST_LIMIT_USD,
      requireApprovalFor: ['file.delete', 'shell.execute', 'network.post', 'message.send'],
    },
    encryption: {
      enabled: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Deployment tier detection
// ---------------------------------------------------------------------------

/** Auto-detect deployment tier based on hardware characteristics. */
export function detectDeploymentTier(): DeploymentTier {
  // Explicit override via env var
  const explicit = process.env['MERIDIAN_TIER'];
  if (explicit === 'pi' || explicit === 'desktop' || explicit === 'vps') {
    return explicit;
  }

  const totalMemMB = totalmem() / (1024 * 1024);
  const cpuArch = arch();

  // ARM with < 4 GB RAM → Raspberry Pi
  if ((cpuArch === 'arm' || cpuArch === 'arm64') && totalMemMB < 4096) {
    return 'pi';
  }

  // > 16 GB RAM → likely a VPS or server
  if (totalMemMB > 16_384) {
    return 'vps';
  }

  return 'desktop';
}

// ---------------------------------------------------------------------------
// TOML loading with snake_case → camelCase conversion
// ---------------------------------------------------------------------------

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function convertKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = snakeToCamel(key);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[camelKey] = convertKeys(value as Record<string, unknown>);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

function loadConfigFile(
  configPath: string,
): Result<DeepPartial<MeridianConfig> | undefined, string> {
  if (!existsSync(configPath)) {
    return ok(undefined);
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseTOML(raw);
    const converted = convertKeys(parsed as unknown as Record<string, unknown>);
    return ok(converted as DeepPartial<MeridianConfig>);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`Failed to parse config file '${configPath}': ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Environment variable mapping
// ---------------------------------------------------------------------------

interface EnvMapping {
  path: string[];
  type: 'string' | 'number' | 'boolean' | 'string[]';
}

const ENV_MAP: Record<string, EnvMapping> = {
  MERIDIAN_AXIS_WORKERS: {
    path: ['axis', 'workers'],
    type: 'number',
  },
  MERIDIAN_AXIS_JOB_TIMEOUT_MS: {
    path: ['axis', 'jobTimeoutMs'],
    type: 'number',
  },
  MERIDIAN_SCOUT_PROVIDER: {
    path: ['scout', 'provider'],
    type: 'string',
  },
  MERIDIAN_SCOUT_MAX_CONTEXT_TOKENS: {
    path: ['scout', 'maxContextTokens'],
    type: 'number',
  },
  MERIDIAN_SCOUT_TEMPERATURE: {
    path: ['scout', 'temperature'],
    type: 'number',
  },
  MERIDIAN_SCOUT_MODELS_PRIMARY: {
    path: ['scout', 'models', 'primary'],
    type: 'string',
  },
  MERIDIAN_SCOUT_MODELS_SECONDARY: {
    path: ['scout', 'models', 'secondary'],
    type: 'string',
  },
  MERIDIAN_SENTINEL_PROVIDER: {
    path: ['sentinel', 'provider'],
    type: 'string',
  },
  MERIDIAN_SENTINEL_MODEL: {
    path: ['sentinel', 'model'],
    type: 'string',
  },
  MERIDIAN_SENTINEL_MAX_CONTEXT_TOKENS: {
    path: ['sentinel', 'maxContextTokens'],
    type: 'number',
  },
  MERIDIAN_JOURNAL_EMBEDDING_PROVIDER: {
    path: ['journal', 'embeddingProvider'],
    type: 'string',
  },
  MERIDIAN_JOURNAL_EMBEDDING_MODEL: {
    path: ['journal', 'embeddingModel'],
    type: 'string',
  },
  MERIDIAN_JOURNAL_EPISODE_RETENTION_DAYS: {
    path: ['journal', 'episodeRetentionDays'],
    type: 'number',
  },
  MERIDIAN_JOURNAL_REFLECTION_ENABLED: {
    path: ['journal', 'reflectionEnabled'],
    type: 'boolean',
  },
  MERIDIAN_BRIDGE_BIND: {
    path: ['bridge', 'bind'],
    type: 'string',
  },
  MERIDIAN_BRIDGE_PORT: {
    path: ['bridge', 'port'],
    type: 'number',
  },
  MERIDIAN_BRIDGE_SESSION_DURATION_HOURS: {
    path: ['bridge', 'sessionDurationHours'],
    type: 'number',
  },
  MERIDIAN_SECURITY_DAILY_COST_LIMIT_USD: {
    path: ['security', 'dailyCostLimitUsd'],
    type: 'number',
  },
  MERIDIAN_SECURITY_REQUIRE_APPROVAL_FOR: {
    path: ['security', 'requireApprovalFor'],
    type: 'string[]',
  },
};

function parseEnvValue(raw: string, type: EnvMapping['type']): unknown {
  switch (type) {
    case 'string':
      return raw;
    case 'number': {
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    }
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'string[]':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  }
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === undefined) continue;
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path.at(-1);
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}

function loadEnvOverrides(): DeepPartial<MeridianConfig> {
  const overrides: Record<string, unknown> = {};

  for (const [envKey, mapping] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined) continue;

    const value = parseEnvValue(raw, mapping.type);
    if (value === undefined) continue;

    setNestedValue(overrides, mapping.path, value);
  }

  return overrides as DeepPartial<MeridianConfig>;
}

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    const targetValue = result[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config: MeridianConfig): string[] {
  const errors: string[] = [];

  // Axis
  if (!Number.isInteger(config.axis.workers) || config.axis.workers < 1) {
    errors.push('axis.workers must be a positive integer');
  }
  if (config.axis.jobTimeoutMs <= 0) {
    errors.push('axis.jobTimeoutMs must be positive');
  }

  // Scout
  if (!config.scout.provider) {
    errors.push('scout.provider must not be empty');
  }
  if (config.scout.maxContextTokens <= 0) {
    errors.push('scout.maxContextTokens must be positive');
  }
  if (config.scout.temperature < 0 || config.scout.temperature > 2) {
    errors.push('scout.temperature must be between 0 and 2');
  }
  if (!config.scout.models.primary) {
    errors.push('scout.models.primary must not be empty');
  }
  if (!config.scout.models.secondary) {
    errors.push('scout.models.secondary must not be empty');
  }

  // Sentinel
  if (!config.sentinel.provider) {
    errors.push('sentinel.provider must not be empty');
  }
  if (!config.sentinel.model) {
    errors.push('sentinel.model must not be empty');
  }
  if (config.sentinel.maxContextTokens <= 0) {
    errors.push('sentinel.maxContextTokens must be positive');
  }

  // Journal
  if (!config.journal.embeddingProvider) {
    errors.push('journal.embeddingProvider must not be empty');
  }
  if (!config.journal.embeddingModel) {
    errors.push('journal.embeddingModel must not be empty');
  }
  if (config.journal.episodeRetentionDays <= 0) {
    errors.push('journal.episodeRetentionDays must be positive');
  }

  // Bridge
  if (!config.bridge.bind) {
    errors.push('bridge.bind must not be empty');
  }
  if (
    !Number.isInteger(config.bridge.port) ||
    config.bridge.port < 1 ||
    config.bridge.port > 65535
  ) {
    errors.push('bridge.port must be an integer between 1 and 65535');
  }
  if (config.bridge.sessionDurationHours <= 0) {
    errors.push('bridge.sessionDurationHours must be positive');
  }

  // Security
  if (config.security.dailyCostLimitUsd < 0) {
    errors.push('security.dailyCostLimitUsd must be non-negative');
  }
  if (!Array.isArray(config.security.requireApprovalFor)) {
    errors.push('security.requireApprovalFor must be an array');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Load configuration with full precedence hierarchy:
 * defaults → config file → environment variables → database overrides.
 */
export function loadConfig(options?: LoadConfigOptions): Result<MeridianConfig, ValidationError> {
  const tier = options?.tier ?? detectDeploymentTier();
  const configPath = options?.configPath ?? 'data/config.toml';

  // 1. Start with defaults
  let config = getDefaultConfig(tier) as unknown as Record<string, unknown>;

  // 2. Merge config file
  const fileResult = loadConfigFile(configPath);
  if (!fileResult.ok) {
    return err(new ValidationError(fileResult.error));
  }
  if (fileResult.value !== undefined) {
    config = deepMerge(config, fileResult.value as unknown as Record<string, unknown>);
  }

  // 3. Merge environment variables
  const envOverrides = loadEnvOverrides();
  config = deepMerge(config, envOverrides as unknown as Record<string, unknown>);

  // 4. Merge database overrides (highest precedence)
  if (options?.dbOverrides) {
    config = deepMerge(config, options.dbOverrides as unknown as Record<string, unknown>);
  }

  // 5. Validate
  const merged = config as unknown as MeridianConfig;
  const errors = validateConfig(merged);
  if (errors.length > 0) {
    return err(
      new ValidationError(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`),
    );
  }

  return ok(merged);
}
