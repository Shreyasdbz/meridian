// Gear signing tests (Phase 10.5)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { GearManifest } from '@meridian/shared';

import {
  computeContentHash,
  signGear,
  verifyGearSignature,
  checkSignaturePolicy,
  generateSigningKeypair,
  canonicalizeManifest,
} from './signing.js';
import type { GearSigningConfig } from './signing.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let testCodePath: string;

const testManifest: GearManifest = {
  id: 'test-gear',
  name: 'Test Gear',
  version: '1.0.0',
  description: 'A test gear for signing tests',
  author: 'test',
  license: 'MIT',
  origin: 'user',
  checksum: 'abc123',
  actions: [
    {
      name: 'run',
      description: 'Run the test gear',
      parameters: { type: 'object' },
      returns: { type: 'object' },
      riskLevel: 'low',
    },
  ],
  permissions: {},
};

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `meridian-test-signing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  testCodePath = join(testDir, 'index.js');
  writeFileSync(testCodePath, 'console.log("hello world");');
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gear signing', () => {
  describe('computeContentHash', () => {
    it('should produce a 64-char hex SHA-256 hash', () => {
      const hash = computeContentHash(testManifest, testCodePath);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic for the same input', () => {
      const hash1 = computeContentHash(testManifest, testCodePath);
      const hash2 = computeContentHash(testManifest, testCodePath);
      expect(hash1).toBe(hash2);
    });

    it('should change if code changes', () => {
      const hash1 = computeContentHash(testManifest, testCodePath);
      writeFileSync(testCodePath, 'console.log("modified");');
      const hash2 = computeContentHash(testManifest, testCodePath);
      expect(hash1).not.toBe(hash2);
    });

    it('should change if manifest changes', () => {
      const hash1 = computeContentHash(testManifest, testCodePath);
      const modified = { ...testManifest, version: '2.0.0' };
      const hash2 = computeContentHash(modified, testCodePath);
      expect(hash1).not.toBe(hash2);
    });

    it('should exclude the signature field from the hash', () => {
      const hash1 = computeContentHash(testManifest, testCodePath);
      const withSig = { ...testManifest, signature: 'some-signature' };
      const hash2 = computeContentHash(withSig, testCodePath);
      expect(hash1).toBe(hash2);
    });
  });

  describe('canonicalizeManifest', () => {
    it('should produce deterministic JSON', () => {
      const json1 = canonicalizeManifest(testManifest);
      const json2 = canonicalizeManifest(testManifest);
      expect(json1).toBe(json2);
    });

    it('should exclude the signature field', () => {
      const withSig = { ...testManifest, signature: 'sig-value' };
      const json = canonicalizeManifest(withSig);
      expect(json).not.toContain('sig-value');
    });

    it('should produce valid JSON', () => {
      const json = canonicalizeManifest(testManifest);
      expect(() => { JSON.parse(json); }).not.toThrow();
    });
  });

  describe('signGear / verifyGearSignature', () => {
    it('should sign and verify a Gear package', () => {
      const keypair = generateSigningKeypair();

      const result = signGear(testManifest, testCodePath, keypair.privateKey);
      expect(result.signature).toBeDefined();
      expect(result.contentHash).toBeDefined();

      const verification = verifyGearSignature(
        testManifest,
        testCodePath,
        result.signature,
        keypair.publicKey,
      );
      expect(verification.valid).toBe(true);
      expect(verification.reason).toBeUndefined();
    });

    it('should reject a tampered manifest', () => {
      const keypair = generateSigningKeypair();
      const result = signGear(testManifest, testCodePath, keypair.privateKey);

      const tampered = { ...testManifest, version: '9.9.9' };
      const verification = verifyGearSignature(
        tampered,
        testCodePath,
        result.signature,
        keypair.publicKey,
      );
      expect(verification.valid).toBe(false);
    });

    it('should reject tampered code', () => {
      const keypair = generateSigningKeypair();
      const result = signGear(testManifest, testCodePath, keypair.privateKey);

      writeFileSync(testCodePath, 'console.log("tampered");');
      const verification = verifyGearSignature(
        testManifest,
        testCodePath,
        result.signature,
        keypair.publicKey,
      );
      expect(verification.valid).toBe(false);
    });

    it('should reject verification with wrong public key', () => {
      const keypair1 = generateSigningKeypair();
      const keypair2 = generateSigningKeypair();

      const result = signGear(testManifest, testCodePath, keypair1.privateKey);
      const verification = verifyGearSignature(
        testManifest,
        testCodePath,
        result.signature,
        keypair2.publicKey,
      );
      expect(verification.valid).toBe(false);
    });

    it('should reject an invalid signature string', () => {
      const keypair = generateSigningKeypair();
      const verification = verifyGearSignature(
        testManifest,
        testCodePath,
        'not-a-valid-signature',
        keypair.publicKey,
      );
      expect(verification.valid).toBe(false);
      expect(verification.reason).toBeDefined();
    });
  });

  describe('checkSignaturePolicy', () => {
    it('should allow everything when policy is allow', () => {
      const config: GearSigningConfig = { policy: 'allow' };
      const result = checkSignaturePolicy(testManifest, config);
      expect(result.allowed).toBe(true);
    });

    it('should allow unsigned Gear with warn policy', () => {
      const warnings: string[] = [];
      const config: GearSigningConfig = {
        policy: 'warn',
        logger: {
          info: () => {},
          warn: (msg) => warnings.push(msg),
          error: () => {},
        },
      };

      const result = checkSignaturePolicy(testManifest, config);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('warning');
      expect(warnings).toHaveLength(1);
    });

    it('should reject unsigned Gear with require policy', () => {
      const config: GearSigningConfig = { policy: 'require' };
      const result = checkSignaturePolicy(testManifest, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('unsigned');
    });

    it('should allow signed Gear with require policy', () => {
      const config: GearSigningConfig = { policy: 'require' };
      const signed = { ...testManifest, signature: 'valid-signature' };
      const result = checkSignaturePolicy(signed, config);
      expect(result.allowed).toBe(true);
    });
  });

  describe('generateSigningKeypair', () => {
    it('should generate a valid keypair', () => {
      const keypair = generateSigningKeypair();
      expect(keypair.publicKey).toBeInstanceOf(Buffer);
      expect(keypair.privateKey).toBeInstanceOf(Buffer);
      expect(keypair.publicKey.length).toBeGreaterThan(0);
      expect(keypair.privateKey.length).toBeGreaterThan(0);
    });

    it('should generate unique keypairs', () => {
      const kp1 = generateSigningKeypair();
      const kp2 = generateSigningKeypair();
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
    });
  });
});
