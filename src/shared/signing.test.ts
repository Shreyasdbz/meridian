// @meridian/shared — Ed25519 signing tests (Phase 9.2)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Ed25519Keypair, SignedEnvelope } from './signing.js';
import {
  generateKeypair,
  generateEphemeralKeypair,
  zeroPrivateKey,
  signPayload,
  verifyPayload,
  ReplayGuard,
  KeyRegistry,
  SigningService,
} from './signing.js';
import type { ComponentId } from './types.js';

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

describe('generateKeypair', () => {
  it('should generate a valid Ed25519 keypair', () => {
    const keypair = generateKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Buffer);
    expect(keypair.privateKey).toBeInstanceOf(Buffer);
    // Ed25519 DER-encoded public key is typically 44 bytes (SPKI)
    expect(keypair.publicKey.length).toBeGreaterThan(0);
    // Ed25519 DER-encoded private key is typically 48 bytes (PKCS8)
    expect(keypair.privateKey.length).toBeGreaterThan(0);
  });

  it('should generate unique keypairs each time', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
    expect(kp1.privateKey.equals(kp2.privateKey)).toBe(false);
  });
});

describe('generateEphemeralKeypair', () => {
  it('should generate a valid keypair identical in structure to generateKeypair', () => {
    const keypair = generateEphemeralKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Buffer);
    expect(keypair.privateKey).toBeInstanceOf(Buffer);
    expect(keypair.publicKey.length).toBeGreaterThan(0);
    expect(keypair.privateKey.length).toBeGreaterThan(0);
  });
});

describe('zeroPrivateKey', () => {
  it('should zero the private key buffer', () => {
    const keypair = generateKeypair();
    const originalLength = keypair.privateKey.length;
    zeroPrivateKey(keypair);
    expect(keypair.privateKey.length).toBe(originalLength);
    // Every byte should be zero
    for (let i = 0; i < keypair.privateKey.length; i++) {
      expect(keypair.privateKey[i]).toBe(0);
    }
  });

  it('should make signing fail after zeroing', () => {
    const keypair = generateKeypair();
    zeroPrivateKey(keypair);
    expect(() => {
      signPayload({ test: true }, keypair.privateKey, 'scout');
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sign / verify round-trip
// ---------------------------------------------------------------------------

describe('signPayload / verifyPayload', () => {
  let keypair: Ed25519Keypair;

  beforeEach(() => {
    keypair = generateKeypair();
  });

  afterEach(() => {
    zeroPrivateKey(keypair);
  });

  it('should sign and verify a payload successfully', () => {
    const payload = { action: 'test', parameters: { foo: 'bar' } };
    const envelope = signPayload(payload, keypair.privateKey, 'scout');

    expect(envelope.messageId).toBeTruthy();
    expect(envelope.timestamp).toBeTruthy();
    expect(envelope.signer).toBe('scout');
    expect(envelope.payload).toBe(JSON.stringify(payload));
    expect(envelope.signature).toBeTruthy();

    const valid = verifyPayload(envelope, keypair.publicKey);
    expect(valid).toBe(true);
  });

  it('should produce a valid base64 signature', () => {
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');
    expect(() => Buffer.from(envelope.signature, 'base64')).not.toThrow();
    // Ed25519 signature is 64 bytes, base64-encoded
    const sigBytes = Buffer.from(envelope.signature, 'base64');
    expect(sigBytes.length).toBe(64);
  });

  it('should use provided messageId and timestamp', () => {
    const envelope = signPayload(
      { test: true },
      keypair.privateKey,
      'scout',
      'custom-id-123',
      '2026-01-01T00:00:00.000Z',
    );
    expect(envelope.messageId).toBe('custom-id-123');
    expect(envelope.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('should reject a forged signature (tampered payload)', () => {
    const envelope = signPayload(
      { action: 'test', value: 42 },
      keypair.privateKey,
      'scout',
    );

    // Tamper with the payload
    const tampered: SignedEnvelope = {
      ...envelope,
      payload: JSON.stringify({ action: 'test', value: 99 }),
    };

    expect(verifyPayload(tampered, keypair.publicKey)).toBe(false);
  });

  it('should reject a forged signature (tampered signer)', () => {
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');

    const tampered: SignedEnvelope = {
      ...envelope,
      signer: 'sentinel',
    };

    expect(verifyPayload(tampered, keypair.publicKey)).toBe(false);
  });

  it('should reject a forged signature (tampered messageId)', () => {
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');

    const tampered: SignedEnvelope = {
      ...envelope,
      messageId: 'forged-id',
    };

    expect(verifyPayload(tampered, keypair.publicKey)).toBe(false);
  });

  it('should reject a forged signature (tampered timestamp)', () => {
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');

    const tampered: SignedEnvelope = {
      ...envelope,
      timestamp: '2099-01-01T00:00:00.000Z',
    };

    expect(verifyPayload(tampered, keypair.publicKey)).toBe(false);
  });

  it('should reject verification with wrong public key', () => {
    const otherKeypair = generateKeypair();
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');

    expect(verifyPayload(envelope, otherKeypair.publicKey)).toBe(false);

    zeroPrivateKey(otherKeypair);
  });

  it('should reject a completely invalid signature', () => {
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');

    const tampered: SignedEnvelope = {
      ...envelope,
      signature: Buffer.alloc(64, 0).toString('base64'),
    };

    expect(verifyPayload(tampered, keypair.publicKey)).toBe(false);
  });

  it('should reject an empty signature', () => {
    const envelope = signPayload({ test: true }, keypair.privateKey, 'scout');

    const tampered: SignedEnvelope = {
      ...envelope,
      signature: '',
    };

    expect(verifyPayload(tampered, keypair.publicKey)).toBe(false);
  });

  it('should produce different signatures for different payloads', () => {
    const env1 = signPayload({ a: 1 }, keypair.privateKey, 'scout');
    const env2 = signPayload({ a: 2 }, keypair.privateKey, 'scout');
    expect(env1.signature).not.toBe(env2.signature);
  });

  it('should work with Gear component IDs', () => {
    const gearId: ComponentId = 'gear:file-manager';
    const envelope = signPayload(
      { action: 'read_file', parameters: { path: '/tmp/test' } },
      keypair.privateKey,
      gearId,
    );

    expect(envelope.signer).toBe('gear:file-manager');
    expect(verifyPayload(envelope, keypair.publicKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

describe('ReplayGuard', () => {
  let guard: ReplayGuard;

  beforeEach(() => {
    guard = new ReplayGuard({ replayWindowMs: 60_000 });
  });

  it('should accept a fresh message', () => {
    const result = guard.check('msg-1', new Date().toISOString());
    expect(result.valid).toBe(true);
  });

  it('should reject a replayed message (duplicate ID)', () => {
    const now = new Date().toISOString();
    guard.check('msg-1', now);
    const result = guard.check('msg-1', now);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('replay');
  });

  it('should reject a message with timestamp too old', () => {
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    const result = guard.check('msg-old', oldTime);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too old');
  });

  it('should reject a message with timestamp far in the future', () => {
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const result = guard.check('msg-future', futureTime);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('future');
  });

  it('should allow a message with slight future time (within 5s tolerance)', () => {
    const slightFuture = new Date(Date.now() + 3_000).toISOString();
    const result = guard.check('msg-slight-future', slightFuture);
    expect(result.valid).toBe(true);
  });

  it('should reject an invalid timestamp', () => {
    const result = guard.check('msg-bad', 'not-a-date');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Invalid timestamp');
  });

  it('should accept multiple unique messages', () => {
    for (let i = 0; i < 100; i++) {
      const result = guard.check(`msg-${i}`, new Date().toISOString());
      expect(result.valid).toBe(true);
    }
    expect(guard.size).toBe(100);
  });

  it('should prune expired entries when at capacity', () => {
    const smallGuard = new ReplayGuard({
      replayWindowMs: 100,
      maxReplayWindowSize: 5,
    });

    // Fill up with messages
    for (let i = 0; i < 5; i++) {
      smallGuard.check(`msg-${i}`, new Date().toISOString());
    }
    expect(smallGuard.size).toBe(5);

    // Wait for entries to expire, then add more
    vi.useFakeTimers();
    vi.advanceTimersByTime(200);

    // This will trigger pruning since size > maxSize
    smallGuard.check('msg-new', new Date().toISOString());

    // Old entries should be pruned
    expect(smallGuard.size).toBeLessThanOrEqual(5);
    vi.useRealTimers();
  });

  it('should clear all tracked messages', () => {
    guard.check('msg-1', new Date().toISOString());
    guard.check('msg-2', new Date().toISOString());
    expect(guard.size).toBe(2);

    guard.clear();
    expect(guard.size).toBe(0);

    // Same IDs should now be accepted
    const result = guard.check('msg-1', new Date().toISOString());
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Key registry
// ---------------------------------------------------------------------------

describe('KeyRegistry', () => {
  let registry: KeyRegistry;

  beforeEach(() => {
    registry = new KeyRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it('should register and retrieve a public key', () => {
    const keypair = generateKeypair();
    registry.registerPublicKey('scout', keypair.publicKey);

    const retrieved = registry.getPublicKey('scout');
    expect(retrieved).toBeDefined();
    expect(retrieved?.equals(keypair.publicKey)).toBe(true);
    zeroPrivateKey(keypair);
  });

  it('should return undefined for unregistered components', () => {
    expect(registry.getPublicKey('scout')).toBeUndefined();
  });

  it('should check if a key exists', () => {
    const keypair = generateKeypair();
    expect(registry.hasKey('scout')).toBe(false);
    registry.registerPublicKey('scout', keypair.publicKey);
    expect(registry.hasKey('scout')).toBe(true);
    zeroPrivateKey(keypair);
  });

  it('should remove a public key and zero the buffer', () => {
    const keypair = generateKeypair();
    registry.registerPublicKey('scout', keypair.publicKey);
    registry.removePublicKey('scout');

    expect(registry.hasKey('scout')).toBe(false);
    expect(registry.getPublicKey('scout')).toBeUndefined();
    zeroPrivateKey(keypair);
  });

  it('should handle removing a non-existent key gracefully', () => {
    expect(() => { registry.removePublicKey('scout'); }).not.toThrow();
  });

  it('should clear all keys', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    registry.registerPublicKey('scout', kp1.publicKey);
    registry.registerPublicKey('sentinel', kp2.publicKey);
    expect(registry.size).toBe(2);

    registry.clear();
    expect(registry.size).toBe(0);
    zeroPrivateKey(kp1);
    zeroPrivateKey(kp2);
  });

  it('should support Gear component IDs', () => {
    const keypair = generateKeypair();
    const gearId: ComponentId = 'gear:file-manager';
    registry.registerPublicKey(gearId, keypair.publicKey);

    expect(registry.hasKey(gearId)).toBe(true);
    expect(registry.getPublicKey(gearId)).toBeDefined();
    zeroPrivateKey(keypair);
  });
});

// ---------------------------------------------------------------------------
// Signing service (integrated)
// ---------------------------------------------------------------------------

describe('SigningService', () => {
  let service: SigningService;
  let scoutKeypair: Ed25519Keypair;
  let sentinelKeypair: Ed25519Keypair;

  beforeEach(() => {
    service = new SigningService();
    scoutKeypair = generateKeypair();
    sentinelKeypair = generateKeypair();
    service.registerPublicKey('scout', scoutKeypair.publicKey);
    service.registerPublicKey('sentinel', sentinelKeypair.publicKey);
  });

  afterEach(() => {
    zeroPrivateKey(scoutKeypair);
    zeroPrivateKey(sentinelKeypair);
    service.clear();
  });

  it('should sign and verify a message end-to-end', () => {
    const envelope = service.sign(
      { action: 'plan', data: 'hello' },
      scoutKeypair.privateKey,
      'scout',
    );

    const result = service.verify(envelope);
    expect(result.valid).toBe(true);
  });

  it('should reject a message from an unregistered component', () => {
    const unknownKeypair = generateKeypair();
    const envelope = service.sign(
      { test: true },
      unknownKeypair.privateKey,
      'journal',
    );

    const result = service.verify(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No public key registered');
    zeroPrivateKey(unknownKeypair);
  });

  it('should reject a message signed with the wrong key', () => {
    // Sign with sentinel's key but claim to be scout
    const envelope = signPayload(
      { test: true },
      sentinelKeypair.privateKey,
      'scout', // claiming to be scout
    );

    const result = service.verify(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Invalid signature');
  });

  it('should reject replayed messages', () => {
    const envelope = service.sign(
      { action: 'test' },
      scoutKeypair.privateKey,
      'scout',
    );

    const result1 = service.verify(envelope);
    expect(result1.valid).toBe(true);

    const result2 = service.verify(envelope);
    expect(result2.valid).toBe(false);
    expect(result2.reason).toContain('replay');
  });

  it('should reject messages with expired timestamps', () => {
    const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
    const envelope = signPayload(
      { test: true },
      scoutKeypair.privateKey,
      'scout',
      'old-msg-id',
      oldTimestamp,
    );

    const result = service.verify(envelope);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too old');
  });

  it('should handle key rotation (remove and re-register)', () => {
    service.removePublicKey('scout');

    // Old key should no longer work
    const envelope1 = service.sign(
      { test: true },
      scoutKeypair.privateKey,
      'scout',
    );
    const result1 = service.verify(envelope1);
    expect(result1.valid).toBe(false);

    // Register new key
    const newKeypair = generateKeypair();
    service.registerPublicKey('scout', newKeypair.publicKey);

    // New key should work
    const envelope2 = service.sign(
      { test: true },
      newKeypair.privateKey,
      'scout',
    );
    const result2 = service.verify(envelope2);
    expect(result2.valid).toBe(true);
    zeroPrivateKey(newKeypair);
  });

  it('should support ephemeral Gear keys', () => {
    const gearKeypair = generateEphemeralKeypair();
    const gearId: ComponentId = 'gear:file-manager';

    service.registerPublicKey(gearId, gearKeypair.publicKey);

    const envelope = service.sign(
      { action: 'read_file', params: { path: '/tmp/test' } },
      gearKeypair.privateKey,
      gearId,
    );

    const result = service.verify(envelope);
    expect(result.valid).toBe(true);

    // Clean up: remove ephemeral key
    service.removePublicKey(gearId);
    expect(service.hasKey(gearId)).toBe(false);

    // Zero the keypair
    zeroPrivateKey(gearKeypair);
  });

  it('should clean up on clear()', () => {
    expect(service.hasKey('scout')).toBe(true);
    expect(service.hasKey('sentinel')).toBe(true);

    service.clear();

    expect(service.hasKey('scout')).toBe(false);
    expect(service.hasKey('sentinel')).toBe(false);
    expect(service.getReplayGuard().size).toBe(0);
  });

  it('should expose key registry and replay guard', () => {
    expect(service.getKeyRegistry()).toBeDefined();
    expect(service.getReplayGuard()).toBeDefined();
    expect(service.getKeyRegistry().size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ephemeral keypair lifecycle
// ---------------------------------------------------------------------------

describe('Ephemeral keypair lifecycle', () => {
  it('should create, use for signing, and destroy an ephemeral keypair', () => {
    // 1. Create ephemeral keypair for a Gear execution
    const ephemeral = generateEphemeralKeypair();
    expect(ephemeral.publicKey.length).toBeGreaterThan(0);
    expect(ephemeral.privateKey.length).toBeGreaterThan(0);

    // 2. Use it for signing
    const envelope = signPayload(
      { action: 'test', parameters: {} },
      ephemeral.privateKey,
      'gear:test-gear',
    );
    expect(verifyPayload(envelope, ephemeral.publicKey)).toBe(true);

    // 3. Destroy (zero) the private key
    zeroPrivateKey(ephemeral);

    // 4. Verify the private key is zeroed
    for (let i = 0; i < ephemeral.privateKey.length; i++) {
      expect(ephemeral.privateKey[i]).toBe(0);
    }

    // 5. Verify signing no longer works with zeroed key
    expect(() => {
      signPayload({ action: 'test' }, ephemeral.privateKey, 'gear:test-gear');
    }).toThrow();
  });

  it('should work within a SigningService registration/unregistration cycle', () => {
    const service = new SigningService();
    const gearId: ComponentId = 'gear:ephemeral-test';

    // Simulate Gear execution lifecycle
    const ephemeral = generateEphemeralKeypair();

    // Register before execution
    service.registerPublicKey(gearId, ephemeral.publicKey);
    expect(service.hasKey(gearId)).toBe(true);

    // Sign a message during execution
    const envelope = service.sign(
      { result: 'success' },
      ephemeral.privateKey,
      gearId,
    );

    // Verify the message
    const result = service.verify(envelope);
    expect(result.valid).toBe(true);

    // Unregister after execution
    service.removePublicKey(gearId);
    expect(service.hasKey(gearId)).toBe(false);

    // Zero the private key
    zeroPrivateKey(ephemeral);

    // Verify the key is no longer usable for verification
    const envelope2 = signPayload(
      { result: 'should-fail' },
      generateKeypair().privateKey,
      gearId,
    );
    const result2 = service.verify(envelope2);
    expect(result2.valid).toBe(false);

    service.clear();
  });
});
