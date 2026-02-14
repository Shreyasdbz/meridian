// @meridian/bridge — TLS utilities (Phase 9.7)
// Helper functions for TLS configuration, HSTS, and certificate loading.

import { readFileSync } from 'node:fs';
import type { SecureContextOptions } from 'node:tls';

import type { BridgeConfig, Logger } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default HSTS max-age: 1 year in seconds. */
const DEFAULT_HSTS_MAX_AGE = 31_536_000;

/**
 * Recommended TLS cipher suites (Mozilla Intermediate compatibility).
 * Excludes weak ciphers while supporting most modern clients.
 */
const TLS_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
].join(':');

// ---------------------------------------------------------------------------
// HSTS helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether the HSTS header should be added based on Bridge config.
 * HSTS is enabled by default when TLS is active unless explicitly disabled.
 */
export function shouldAddHsts(config: BridgeConfig): boolean {
  return !!config.tls?.enabled && config.tls.hsts !== false;
}

/**
 * Compute the HSTS max-age value, falling back to the recommended default
 * of 1 year (31536000 seconds) when not explicitly configured.
 */
export function getHstsMaxAge(config: BridgeConfig): number {
  return config.tls?.hstsMaxAge ?? DEFAULT_HSTS_MAX_AGE;
}

/**
 * Build the HSTS header value string.
 */
export function buildHstsHeader(config: BridgeConfig): string {
  const maxAge = getHstsMaxAge(config);
  return `max-age=${maxAge}; includeSubDomains`;
}

// ---------------------------------------------------------------------------
// Certificate loading
// ---------------------------------------------------------------------------

/**
 * Load TLS certificate and key from disk.
 * Throws if files are missing or unreadable.
 */
export function loadTlsCertificates(
  certPath: string,
  keyPath: string,
  logger: Logger,
): { cert: Buffer; key: Buffer } {
  logger.info('Loading TLS certificates', {
    component: 'bridge',
    certPath,
    keyPath,
  });

  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);

  return { cert, key };
}

// ---------------------------------------------------------------------------
// Fastify HTTPS options
// ---------------------------------------------------------------------------

/**
 * Build the `https` options object for Fastify when TLS is enabled.
 * Returns `undefined` when TLS is not configured.
 */
export function buildHttpsOptions(
  config: BridgeConfig,
  logger: Logger,
): SecureContextOptions | undefined {
  if (!config.tls?.enabled) {
    return undefined;
  }

  const { cert, key } = loadTlsCertificates(
    config.tls.certPath,
    config.tls.keyPath,
    logger,
  );

  return {
    cert,
    key,
    minVersion: config.tls.minVersion ?? 'TLSv1.2',
    ciphers: TLS_CIPHERS,
  };
}
