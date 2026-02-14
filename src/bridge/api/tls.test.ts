// @meridian/bridge — TLS configuration and HSTS logic tests (Phase 9.7)
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { describe, it, expect } from 'vitest';

import type { BridgeConfig } from '@meridian/shared';

import { shouldAddHsts, getHstsMaxAge, buildHstsHeader } from './tls.js';

describe('TLS configuration', () => {
  describe('BridgeConfig TLS interface', () => {
    it('should accept a config without TLS (TLS is optional)', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3200,
        sessionDurationHours: 24,
      };

      expect(config.tls).toBeUndefined();
    });

    it('should accept a config with TLS enabled', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3200,
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
        port: 3200,
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
        port: 3200,
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
        port: 3200,
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
        port: 3200,
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
        port: 3200,
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
        port: 3200,
        sessionDurationHours: 24,
      };

      expect(shouldAddHsts(config)).toBe(false);
    });
  });

  describe('getHstsMaxAge', () => {
    it('should return the configured max-age when set', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3200,
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
        port: 3200,
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
        port: 3200,
        sessionDurationHours: 24,
      };

      expect(getHstsMaxAge(config)).toBe(31_536_000);
    });
  });

  describe('buildHstsHeader', () => {
    it('should build header with default max-age and includeSubDomains', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3200,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
        },
      };

      expect(buildHstsHeader(config)).toBe(
        'max-age=31536000; includeSubDomains',
      );
    });

    it('should build header with custom max-age', () => {
      const config: BridgeConfig = {
        bind: '127.0.0.1',
        port: 3200,
        sessionDurationHours: 24,
        tls: {
          enabled: true,
          certPath: '/etc/ssl/certs/meridian.crt',
          keyPath: '/etc/ssl/private/meridian.key',
          hstsMaxAge: 63_072_000,
        },
      };

      expect(buildHstsHeader(config)).toBe(
        'max-age=63072000; includeSubDomains',
      );
    });
  });
});
