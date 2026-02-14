// @meridian/bridge — TLS configuration and HSTS logic tests (Phase 9.7)

import { describe, it, expect } from 'vitest';

import type { BridgeConfig } from '@meridian/shared';

/**
 * Determine whether the HSTS (Strict-Transport-Security) header should be
 * added based on the Bridge TLS configuration.
 *
 * HSTS is enabled by default when TLS is active unless explicitly disabled
 * via `tls.hsts: false`.
 */
function shouldAddHsts(config: BridgeConfig): boolean {
  return !!config.tls?.enabled && config.tls.hsts !== false;
}

/**
 * Compute the HSTS max-age value, falling back to the recommended default
 * of 1 year (31536000 seconds) when not explicitly configured.
 */
function getHstsMaxAge(config: BridgeConfig): number {
  const DEFAULT_HSTS_MAX_AGE = 31_536_000;
  return config.tls?.hstsMaxAge ?? DEFAULT_HSTS_MAX_AGE;
}

describe('TLS configuration', () => {
  describe('BridgeConfig TLS interface', () => {
    it('should accept a config without TLS (TLS is optional)', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
      };

      expect(config.tls).toBeUndefined();
    });

    it('should accept a config with TLS enabled', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
        },
      };

      expect(config.tls).toBeDefined();
      expect(config.tls!.enabled).toBe(true);
      expect(config.tls!.certPath).toBe('/etc/ssl/certs/meridian.crt');
      expect(config.tls!.keyPath).toBe('/etc/ssl/private/meridian.key');
    });

    it('should accept TLS config with optional minVersion field', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          minVersion: 'TLSv1.3',
        },
      };

      expect(config.tls!.minVersion).toBe('TLSv1.3');
    });

    it('should accept TLS config with HSTS options', () => {
      const config: BridgeConfig = {
        bind: '0.0.0.0',
        port: 443,
        sessionDurationHours: 12,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          hsts: true,
          hstsMaxAge: 63_072_000,
        },
      };

      expect(config.tls!.hsts).toBe(true);
      expect(config.tls!.hstsMaxAge).toBe(63_072_000);
    });
  });

  describe('shouldAddHsts', () => {
    it('should return true when TLS is enabled and HSTS is not explicitly set', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
        },
      };

      expect(shouldAddHsts(config)).toBe(true);
    });

    it('should return true when TLS is enabled and HSTS is explicitly true', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          hsts: true,
        },
      };

      expect(shouldAddHsts(config)).toBe(true);
    });

    it('should return false when TLS is enabled but HSTS is explicitly false', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          hsts: false,
        },
      };

      expect(shouldAddHsts(config)).toBe(false);
    });

    it('should return false when TLS is disabled', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: false,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          hsts: true,
        },
      };

      expect(shouldAddHsts(config)).toBe(false);
    });

    it('should return false when TLS config is absent', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
      };

      expect(shouldAddHsts(config)).toBe(false);
    });
  });

  describe('getHstsMaxAge', () => {
    it('should return the configured max-age when set', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          hstsMaxAge: 63_072_000,
        },
      };

      expect(getHstsMaxAge(config)).toBe(63_072_000);
    });

    it('should return the default of 1 year when max-age is not configured', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
        },
      };

      expect(getHstsMaxAge(config)).toBe(31_536_000);
    });

    it('should return the default when TLS config is absent', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3000,
        sessionDurationHours: 24,
      };

      expect(getHstsMaxAge(config)).toBe(31_536_000);
    });
  });
});
