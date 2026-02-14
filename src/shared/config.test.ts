import { existsSync, readFileSync } from 'node:fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loadConfig, getDefaultConfig, detectDeploymentTier } from './config.js';
import {
  DEFAULT_WORKERS_PI,
  DEFAULT_WORKERS_DESKTOP,
  DEFAULT_WORKERS_VPS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_DAILY_COST_LIMIT_USD,
  DEFAULT_SESSION_DURATION_HOURS,
} from './constants.js';

// Mock node:fs so we can simulate config files without touching disk
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  renameSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// Store original env
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Reset env to original — remove any MERIDIAN_* vars set by tests
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MERIDIAN_')) {
      process.env[key] = undefined;
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// getDefaultConfig
// ---------------------------------------------------------------------------

describe('getDefaultConfig', () => {
  it('should return pi-tier defaults', () => {
    const config = getDefaultConfig('pi');
    expect(config.axis.workers).toBe(DEFAULT_WORKERS_PI);
    expect(config.axis.jobTimeoutMs).toBe(DEFAULT_JOB_TIMEOUT_MS);
    expect(config.bridge.bind).toBe('127.0.0.1');
    expect(config.bridge.port).toBe(3200);
  });

  it('should return desktop-tier defaults', () => {
    const config = getDefaultConfig('desktop');
    expect(config.axis.workers).toBe(DEFAULT_WORKERS_DESKTOP);
  });

  it('should return vps-tier defaults', () => {
    const config = getDefaultConfig('vps');
    expect(config.axis.workers).toBe(DEFAULT_WORKERS_VPS);
  });

  it('should set all required config sections', () => {
    const config = getDefaultConfig('desktop');
    expect(config.axis).toBeDefined();
    expect(config.scout).toBeDefined();
    expect(config.sentinel).toBeDefined();
    expect(config.journal).toBeDefined();
    expect(config.bridge).toBeDefined();
    expect(config.security).toBeDefined();
  });

  it('should use architecture-specified defaults', () => {
    const config = getDefaultConfig('desktop');
    expect(config.scout.provider).toBe('anthropic');
    expect(config.scout.maxContextTokens).toBe(100_000);
    expect(config.scout.temperature).toBe(0.3);
    expect(config.sentinel.provider).toBe('openai');
    expect(config.sentinel.model).toBe('gpt-4o');
    expect(config.sentinel.maxContextTokens).toBe(32_000);
    expect(config.journal.embeddingProvider).toBe('local');
    expect(config.journal.embeddingModel).toBe('nomic-embed-text');
    expect(config.journal.episodeRetentionDays).toBe(90);
    expect(config.journal.reflectionEnabled).toBe(true);
    expect(config.bridge.sessionDurationHours).toBe(DEFAULT_SESSION_DURATION_HOURS);
    expect(config.security.dailyCostLimitUsd).toBe(DEFAULT_DAILY_COST_LIMIT_USD);
    expect(config.security.requireApprovalFor).toEqual([
      'file.delete',
      'shell.execute',
      'network.post',
      'message.send',
    ]);
  });
});

// ---------------------------------------------------------------------------
// detectDeploymentTier
// ---------------------------------------------------------------------------

describe('detectDeploymentTier', () => {
  it('should respect explicit MERIDIAN_TIER env var', () => {
    process.env['MERIDIAN_TIER'] = 'pi';
    expect(detectDeploymentTier()).toBe('pi');

    process.env['MERIDIAN_TIER'] = 'vps';
    expect(detectDeploymentTier()).toBe('vps');

    process.env['MERIDIAN_TIER'] = 'desktop';
    expect(detectDeploymentTier()).toBe('desktop');
  });

  it('should ignore invalid MERIDIAN_TIER values', () => {
    process.env['MERIDIAN_TIER'] = 'invalid';
    const tier = detectDeploymentTier();
    expect(['pi', 'desktop', 'vps']).toContain(tier);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — defaults only (no config file)
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  describe('with defaults only', () => {
    it('should load with sane defaults when no config file exists', () => {
      mockExistsSync.mockReturnValue(false);
      const result = loadConfig({ tier: 'desktop' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.axis.workers).toBe(DEFAULT_WORKERS_DESKTOP);
        expect(result.value.bridge.port).toBe(3200);
        expect(result.value.bridge.bind).toBe('127.0.0.1');
        expect(result.value.scout.provider).toBe('anthropic');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Config file loading with TOML parsing
  // ---------------------------------------------------------------------------

  describe('with config file', () => {
    it('should merge TOML config over defaults', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[bridge]
port = 4000

[axis]
workers = 16
`);

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bridge.port).toBe(4000);
        expect(result.value.axis.workers).toBe(16);
        // Other values should remain defaults
        expect(result.value.scout.provider).toBe('anthropic');
      }
    });

    it('should convert snake_case TOML keys to camelCase', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[axis]
job_timeout_ms = 600000

[scout]
max_context_tokens = 200000

[journal]
embedding_provider = "openai"
embedding_model = "text-embedding-3-small"
episode_retention_days = 30
reflection_enabled = false
`);

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.axis.jobTimeoutMs).toBe(600000);
        expect(result.value.scout.maxContextTokens).toBe(200000);
        expect(result.value.journal.embeddingProvider).toBe('openai');
        expect(result.value.journal.embeddingModel).toBe('text-embedding-3-small');
        expect(result.value.journal.episodeRetentionDays).toBe(30);
        expect(result.value.journal.reflectionEnabled).toBe(false);
      }
    });

    it('should handle nested TOML sections like scout.models', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[scout.models]
primary = "custom-model"
secondary = "custom-secondary"
`);

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.scout.models.primary).toBe('custom-model');
        expect(result.value.scout.models.secondary).toBe('custom-secondary');
      }
    });

    it('should return error for invalid TOML', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid [[ toml content');

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ERR_VALIDATION');
        expect(result.error.message).toContain('Failed to parse config');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Environment variable overrides
  // ---------------------------------------------------------------------------

  describe('with environment variables', () => {
    it('should override config file values with env vars', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[bridge]
port = 4000
`);

      process.env['MERIDIAN_BRIDGE_PORT'] = '5000';

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Env var (5000) should override config file (4000)
        expect(result.value.bridge.port).toBe(5000);
      }
    });

    it('should map all supported env vars', () => {
      mockExistsSync.mockReturnValue(false);

      process.env['MERIDIAN_AXIS_WORKERS'] = '6';
      process.env['MERIDIAN_AXIS_JOB_TIMEOUT_MS'] = '500000';
      process.env['MERIDIAN_SCOUT_PROVIDER'] = 'openai';
      process.env['MERIDIAN_SCOUT_MAX_CONTEXT_TOKENS'] = '50000';
      process.env['MERIDIAN_SCOUT_TEMPERATURE'] = '0.7';
      process.env['MERIDIAN_SCOUT_MODELS_PRIMARY'] = 'gpt-4o';
      process.env['MERIDIAN_SENTINEL_PROVIDER'] = 'anthropic';
      process.env['MERIDIAN_SENTINEL_MODEL'] = 'claude-haiku';
      process.env['MERIDIAN_BRIDGE_BIND'] = '0.0.0.0';
      process.env['MERIDIAN_BRIDGE_PORT'] = '8080';
      process.env['MERIDIAN_BRIDGE_SESSION_DURATION_HOURS'] = '24';
      process.env['MERIDIAN_SECURITY_DAILY_COST_LIMIT_USD'] = '10';
      process.env['MERIDIAN_JOURNAL_EMBEDDING_PROVIDER'] = 'openai';
      process.env['MERIDIAN_JOURNAL_REFLECTION_ENABLED'] = 'false';

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.axis.workers).toBe(6);
        expect(result.value.axis.jobTimeoutMs).toBe(500000);
        expect(result.value.scout.provider).toBe('openai');
        expect(result.value.scout.maxContextTokens).toBe(50000);
        expect(result.value.scout.temperature).toBe(0.7);
        expect(result.value.scout.models.primary).toBe('gpt-4o');
        expect(result.value.sentinel.provider).toBe('anthropic');
        expect(result.value.sentinel.model).toBe('claude-haiku');
        expect(result.value.bridge.bind).toBe('0.0.0.0');
        expect(result.value.bridge.port).toBe(8080);
        expect(result.value.bridge.sessionDurationHours).toBe(24);
        expect(result.value.security.dailyCostLimitUsd).toBe(10);
        expect(result.value.journal.embeddingProvider).toBe('openai');
        expect(result.value.journal.reflectionEnabled).toBe(false);
      }
    });

    it('should parse boolean env vars correctly', () => {
      mockExistsSync.mockReturnValue(false);

      process.env['MERIDIAN_JOURNAL_REFLECTION_ENABLED'] = 'true';
      const result1 = loadConfig({ tier: 'desktop' });
      expect(result1.ok).toBe(true);
      if (result1.ok) {
        expect(result1.value.journal.reflectionEnabled).toBe(true);
      }

      process.env['MERIDIAN_JOURNAL_REFLECTION_ENABLED'] = '1';
      const result2 = loadConfig({ tier: 'desktop' });
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value.journal.reflectionEnabled).toBe(true);
      }

      process.env['MERIDIAN_JOURNAL_REFLECTION_ENABLED'] = '0';
      const result3 = loadConfig({ tier: 'desktop' });
      expect(result3.ok).toBe(true);
      if (result3.ok) {
        expect(result3.value.journal.reflectionEnabled).toBe(false);
      }
    });

    it('should parse comma-separated string[] env vars', () => {
      mockExistsSync.mockReturnValue(false);

      process.env['MERIDIAN_SECURITY_REQUIRE_APPROVAL_FOR'] =
        'file.delete,shell.execute,custom.action';

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.security.requireApprovalFor).toEqual([
          'file.delete',
          'shell.execute',
          'custom.action',
        ]);
      }
    });

    it('should ignore non-numeric values for number env vars', () => {
      mockExistsSync.mockReturnValue(false);

      process.env['MERIDIAN_BRIDGE_PORT'] = 'not-a-number';

      const result = loadConfig({ tier: 'desktop' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should keep default since env var was invalid
        expect(result.value.bridge.port).toBe(3200);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Database overrides (highest precedence)
  // ---------------------------------------------------------------------------

  describe('with database overrides', () => {
    it('should apply db overrides over env vars and config file', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[bridge]
port = 4000
`);
      process.env['MERIDIAN_BRIDGE_PORT'] = '5000';

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: {
          bridge: { port: 6000 },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // DB override (6000) beats env var (5000) beats config file (4000)
        expect(result.value.bridge.port).toBe(6000);
      }
    });

    it('should deep-merge db overrides without overwriting siblings', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: {
          bridge: { port: 9000 },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bridge.port).toBe(9000);
        // Siblings should remain at defaults
        expect(result.value.bridge.bind).toBe('127.0.0.1');
        expect(result.value.bridge.sessionDurationHours).toBe(DEFAULT_SESSION_DURATION_HOURS);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('validation', () => {
    it('should reject zero workers', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { axis: { workers: 0 } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('axis.workers');
      }
    });

    it('should reject negative job timeout', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { axis: { jobTimeoutMs: -1 } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('axis.jobTimeoutMs');
      }
    });

    it('should reject invalid port numbers', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { bridge: { port: 70000 } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('bridge.port');
      }
    });

    it('should reject temperature out of range', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { scout: { temperature: 3 } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('scout.temperature');
      }
    });

    it('should reject empty provider strings', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { scout: { provider: '' } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('scout.provider');
      }
    });

    it('should reject empty scout.models.secondary', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { scout: { models: { secondary: '' } } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('scout.models.secondary');
      }
    });

    it('should reject negative daily cost limit', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { security: { dailyCostLimitUsd: -1 } },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('security.dailyCostLimitUsd');
      }
    });

    it('should collect multiple validation errors', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: {
          axis: { workers: 0 },
          bridge: { port: -1 },
          scout: { temperature: 5 },
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('axis.workers');
        expect(result.error.message).toContain('bridge.port');
        expect(result.error.message).toContain('scout.temperature');
      }
    });

    it('should accept zero daily cost limit (free tier)', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { security: { dailyCostLimitUsd: 0 } },
      });

      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Full precedence order
  // ---------------------------------------------------------------------------

  describe('precedence order', () => {
    it('should follow defaults → file → env → db precedence', () => {
      // Config file sets workers to 3
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[axis]
workers = 3
`);

      // Env var sets workers to 5
      process.env['MERIDIAN_AXIS_WORKERS'] = '5';

      // DB override sets workers to 10
      const result = loadConfig({
        tier: 'desktop',
        dbOverrides: { axis: { workers: 10 } },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // DB override wins
        expect(result.value.axis.workers).toBe(10);
      }
    });

    it('should use env over file when no db override', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[axis]
workers = 3
`);

      process.env['MERIDIAN_AXIS_WORKERS'] = '5';

      const result = loadConfig({ tier: 'desktop' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.axis.workers).toBe(5);
      }
    });

    it('should use file over defaults when no env override', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[axis]
workers = 3
`);

      const result = loadConfig({ tier: 'desktop' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.axis.workers).toBe(3);
      }
    });
  });
});
