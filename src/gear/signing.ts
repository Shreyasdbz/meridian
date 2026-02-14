// @meridian/gear — Gear signing (Phase 10.5)
//
// Ed25519 signature of canonical manifest+code SHA-256.
// Signing policy: 'require' | 'warn' | 'allow' (default: 'allow' in v0.3).

import { createHash, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { generateEphemeralKeypair } from '@meridian/shared';
import type { Ed25519Keypair, GearManifest } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GearSigningPolicy = 'require' | 'warn' | 'allow';

export interface GearSigningConfig {
  /** Policy for unsigned Gear. Default: 'allow'. */
  policy: GearSigningPolicy;
  /** Logger. */
  logger?: GearSigningLogger;
}

export interface GearSigningLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface SignatureResult {
  signature: string;
  contentHash: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Compute the canonical content hash for signing.
 * Hash = SHA-256 of (canonical manifest JSON + code bytes).
 */
export function computeContentHash(
  manifest: GearManifest,
  codePath: string,
): string {
  const canonicalManifest = canonicalizeManifest(manifest);
  const code = readFileSync(codePath);

  const hash = createHash('sha256');
  hash.update(canonicalManifest);
  hash.update(code);

  return hash.digest('hex');
}

/**
 * Sign a Gear package with an Ed25519 private key.
 */
export function signGear(
  manifest: GearManifest,
  codePath: string,
  privateKey: Buffer,
): SignatureResult {
  const contentHash = computeContentHash(manifest, codePath);
  const hashBuffer = Buffer.from(contentHash, 'hex');
  const signature = sign(null, hashBuffer, {
    key: privateKey,
    format: 'der',
    type: 'pkcs8',
  });

  return {
    signature: signature.toString('hex'),
    contentHash,
  };
}

/**
 * Verify a Gear package signature.
 */
export function verifyGearSignature(
  manifest: GearManifest,
  codePath: string,
  signature: string,
  publicKey: Buffer,
): VerificationResult {
  try {
    const contentHash = computeContentHash(manifest, codePath);
    const hashBuffer = Buffer.from(contentHash, 'hex');
    const signatureBuffer = Buffer.from(signature, 'hex');

    const valid = verify(null, hashBuffer, {
      key: publicKey,
      format: 'der',
      type: 'spki',
    }, signatureBuffer);

    return {
      valid,
      reason: valid ? undefined : 'Signature does not match content',
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

/**
 * Check a Gear's signature against the configured policy.
 * Returns true if the Gear is allowed to execute.
 */
export function checkSignaturePolicy(
  manifest: GearManifest,
  config: GearSigningConfig,
): { allowed: boolean; reason?: string } {
  if (config.policy === 'allow') {
    return { allowed: true };
  }

  if (!manifest.signature) {
    if (config.policy === 'require') {
      return {
        allowed: false,
        reason: `Gear '${manifest.id}' is unsigned and signing policy is 'require'`,
      };
    }
    // policy === 'warn'
    config.logger?.warn('Unsigned Gear detected', { gearId: manifest.id });
    return { allowed: true, reason: 'Unsigned Gear (warning)' };
  }

  return { allowed: true };
}

/**
 * Generate a new signing keypair.
 * The private key should be stored securely and zeroed after use.
 */
export function generateSigningKeypair(): Ed25519Keypair {
  return generateEphemeralKeypair();
}

/**
 * Zero a private key buffer after use.
 */
export { zeroPrivateKey } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a manifest for signing.
 * Produces a deterministic JSON representation by sorting keys.
 * Excludes the 'signature' field itself.
 */
export function canonicalizeManifest(manifest: GearManifest): string {
  const { signature: _sig, ...rest } = manifest;
  return JSON.stringify(rest, Object.keys(rest).sort());
}
