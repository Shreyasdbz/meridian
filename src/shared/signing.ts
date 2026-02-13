// @meridian/shared — Ed25519 message signing and verification (Section 6.3, v0.2)
// Per-component keypairs with ephemeral keys for Gear and replay protection.

import {
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
} from 'node:crypto';

import { REPLAY_WINDOW_MS } from './constants.js';
import type { ComponentId } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An Ed25519 keypair for a component.
 * Private key is stored as a Buffer for explicit zeroing on disposal.
 */
export interface Ed25519Keypair {
  /** DER-encoded Ed25519 public key */
  publicKey: Buffer;
  /** DER-encoded Ed25519 private key (sensitive — zero after use) */
  privateKey: Buffer;
}

/**
 * A signed message envelope wrapping a payload with Ed25519 signature.
 */
export interface SignedEnvelope {
  /** Unique message ID (for replay detection) */
  messageId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Component that signed the message */
  signer: ComponentId;
  /** The serialized payload (JSON string) */
  payload: string;
  /** Base64-encoded Ed25519 signature over `messageId|timestamp|signer|payload` */
  signature: string;
}

/**
 * Options for the SigningService constructor.
 */
export interface SigningServiceOptions {
  /** Replay window duration in milliseconds. Defaults to REPLAY_WINDOW_MS (60s). */
  replayWindowMs?: number;
  /** Maximum number of message IDs to track in the replay window. Defaults to 10000. */
  maxReplayWindowSize?: number;
}

/**
 * Result of signature verification.
 */
export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum replay window entries before pruning */
const DEFAULT_MAX_REPLAY_WINDOW_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Keypair management
// ---------------------------------------------------------------------------

/**
 * Generate an Ed25519 keypair for a component.
 * Returns DER-encoded keys as Buffers so they can be zeroed after use.
 */
export function generateKeypair(): Ed25519Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey: Buffer.from(publicKey),
    privateKey: Buffer.from(privateKey),
  };
}

/**
 * Generate an ephemeral Ed25519 keypair for a single Gear execution.
 * Identical to generateKeypair() but semantically distinct — callers
 * must zero the private key after the execution completes.
 */
export function generateEphemeralKeypair(): Ed25519Keypair {
  return generateKeypair();
}

/**
 * Zero and discard a private key buffer.
 * Call this when a keypair is no longer needed (shutdown, Gear execution complete).
 */
export function zeroPrivateKey(keypair: Ed25519Keypair): void {
  keypair.privateKey.fill(0);
}

// ---------------------------------------------------------------------------
// Message signing
// ---------------------------------------------------------------------------

/**
 * Construct the canonical byte string for signing.
 * Format: `messageId|timestamp|signer|payload`
 * Using pipe-delimited concatenation with fixed-order fields.
 */
function buildSigningInput(
  messageId: string,
  timestamp: string,
  signer: string,
  payload: string,
): Buffer {
  return Buffer.from(`${messageId}|${timestamp}|${signer}|${payload}`, 'utf-8');
}

/**
 * Sign a message payload with an Ed25519 private key.
 *
 * @param payload - The payload object to sign (will be JSON-serialized)
 * @param privateKey - DER-encoded Ed25519 private key
 * @param signer - The component ID of the signer
 * @param messageId - Unique message ID (for replay protection)
 * @param timestamp - ISO 8601 timestamp
 * @returns A SignedEnvelope containing the payload and signature
 */
export function signPayload(
  payload: Record<string, unknown>,
  privateKey: Buffer,
  signer: ComponentId,
  messageId?: string,
  timestamp?: string,
): SignedEnvelope {
  const id = messageId ?? randomBytes(16).toString('hex');
  const ts = timestamp ?? new Date().toISOString();
  const payloadStr = JSON.stringify(payload);

  const signingInput = buildSigningInput(id, ts, signer, payloadStr);
  const signature = sign(null, signingInput, {
    key: privateKey,
    format: 'der',
    type: 'pkcs8',
  });

  return {
    messageId: id,
    timestamp: ts,
    signer,
    payload: payloadStr,
    signature: signature.toString('base64'),
  };
}

/**
 * Verify an Ed25519 signature on a signed envelope.
 *
 * @param envelope - The signed envelope to verify
 * @param publicKey - DER-encoded Ed25519 public key of the claimed signer
 * @returns true if the signature is valid
 */
export function verifyPayload(
  envelope: SignedEnvelope,
  publicKey: Buffer,
): boolean {
  const signingInput = buildSigningInput(
    envelope.messageId,
    envelope.timestamp,
    envelope.signer,
    envelope.payload,
  );

  const signatureBuffer = Buffer.from(envelope.signature, 'base64');

  try {
    return verify(null, signingInput, {
      key: publicKey,
      format: 'der',
      type: 'spki',
    }, signatureBuffer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

/**
 * Manages a sliding window of recently seen message IDs to prevent replay attacks.
 * Also validates message timestamps (rejects messages older than the replay window).
 */
export class ReplayGuard {
  private readonly windowMs: number;
  private readonly maxSize: number;
  /** Map of messageId -> timestamp (ms) when the message was first seen */
  private readonly seen = new Map<string, number>();

  constructor(options?: SigningServiceOptions) {
    this.windowMs = options?.replayWindowMs ?? REPLAY_WINDOW_MS;
    this.maxSize = options?.maxReplayWindowSize ?? DEFAULT_MAX_REPLAY_WINDOW_SIZE;
  }

  /**
   * Check whether a message should be accepted based on replay protection rules.
   *
   * Rules:
   * 1. Message timestamp must not be older than the replay window (default 60s)
   * 2. Message ID must not have been seen before within the window
   *
   * If accepted, the message ID is recorded in the window.
   *
   * @param messageId - Unique message ID
   * @param timestamp - ISO 8601 timestamp from the message
   * @returns VerificationResult indicating acceptance or rejection with reason
   */
  check(messageId: string, timestamp: string): VerificationResult {
    const now = Date.now();
    const messageTime = new Date(timestamp).getTime();

    // Validate timestamp is parseable
    if (isNaN(messageTime)) {
      return { valid: false, reason: 'Invalid timestamp format' };
    }

    // Reject messages older than the replay window
    if (now - messageTime > this.windowMs) {
      return { valid: false, reason: `Message timestamp too old (>${this.windowMs}ms)` };
    }

    // Reject messages from the future (> 5s tolerance for clock skew)
    if (messageTime - now > 5_000) {
      return { valid: false, reason: 'Message timestamp is in the future' };
    }

    // Check for replay
    if (this.seen.has(messageId)) {
      return { valid: false, reason: 'Duplicate message ID (replay detected)' };
    }

    // Accept and record
    this.seen.set(messageId, now);

    // Prune expired entries if we're at capacity
    if (this.seen.size > this.maxSize) {
      this.prune(now);
    }

    return { valid: true };
  }

  /**
   * Remove expired entries from the sliding window.
   */
  private prune(now: number): void {
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt > this.windowMs) {
        this.seen.delete(id);
      }
    }
  }

  /**
   * Clear all tracked message IDs. Used during shutdown/testing.
   */
  clear(): void {
    this.seen.clear();
  }

  /**
   * Get the number of currently tracked message IDs.
   */
  get size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------
// Key registry (holds public keys for verification)
// ---------------------------------------------------------------------------

/**
 * Registry of component public keys for signature verification.
 * Axis holds all public keys and uses this to verify message origins.
 */
export class KeyRegistry {
  private readonly keys = new Map<string, Buffer>();

  /**
   * Register a component's public key.
   */
  registerPublicKey(componentId: ComponentId, publicKey: Buffer): void {
    this.keys.set(componentId, Buffer.from(publicKey));
  }

  /**
   * Remove a component's public key (e.g., when an ephemeral Gear key expires).
   */
  removePublicKey(componentId: ComponentId): void {
    const key = this.keys.get(componentId);
    if (key) {
      key.fill(0);
      this.keys.delete(componentId);
    }
  }

  /**
   * Get a component's public key for verification.
   * Returns undefined if no key is registered.
   */
  getPublicKey(componentId: ComponentId): Buffer | undefined {
    return this.keys.get(componentId);
  }

  /**
   * Check if a component has a registered public key.
   */
  hasKey(componentId: ComponentId): boolean {
    return this.keys.has(componentId);
  }

  /**
   * Clear all registered keys. Zeros key buffers before removal.
   */
  clear(): void {
    for (const key of this.keys.values()) {
      key.fill(0);
    }
    this.keys.clear();
  }

  /**
   * Get the number of registered keys.
   */
  get size(): number {
    return this.keys.size;
  }
}

// ---------------------------------------------------------------------------
// High-level signing service
// ---------------------------------------------------------------------------

/**
 * SigningService combines keypair management, signing, verification,
 * and replay protection into a single facade.
 *
 * Used by Axis to verify all incoming messages and by components
 * to sign outgoing messages.
 */
export class SigningService {
  private readonly keyRegistry: KeyRegistry;
  private readonly replayGuard: ReplayGuard;

  constructor(options?: SigningServiceOptions) {
    this.keyRegistry = new KeyRegistry();
    this.replayGuard = new ReplayGuard(options);
  }

  /**
   * Register a component's public key for verification.
   */
  registerPublicKey(componentId: ComponentId, publicKey: Buffer): void {
    this.keyRegistry.registerPublicKey(componentId, publicKey);
  }

  /**
   * Remove a component's public key.
   */
  removePublicKey(componentId: ComponentId): void {
    this.keyRegistry.removePublicKey(componentId);
  }

  /**
   * Check if a component has a registered key.
   */
  hasKey(componentId: ComponentId): boolean {
    return this.keyRegistry.hasKey(componentId);
  }

  /**
   * Sign a payload using the given private key and component identity.
   */
  sign(
    payload: Record<string, unknown>,
    privateKey: Buffer,
    signer: ComponentId,
  ): SignedEnvelope {
    return signPayload(payload, privateKey, signer);
  }

  /**
   * Verify a signed envelope: check signature validity and replay protection.
   *
   * @param envelope - The signed envelope to verify
   * @returns VerificationResult indicating success or failure with reason
   */
  verify(envelope: SignedEnvelope): VerificationResult {
    // 1. Look up signer's public key
    const publicKey = this.keyRegistry.getPublicKey(envelope.signer);
    if (!publicKey) {
      return { valid: false, reason: `No public key registered for '${envelope.signer}'` };
    }

    // 2. Verify the cryptographic signature
    const signatureValid = verifyPayload(envelope, publicKey);
    if (!signatureValid) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // 3. Check replay protection
    return this.replayGuard.check(envelope.messageId, envelope.timestamp);
  }

  /**
   * Clear all state (keys and replay window). Used during shutdown.
   */
  clear(): void {
    this.keyRegistry.clear();
    this.replayGuard.clear();
  }

  /**
   * Get the underlying key registry (for direct access when needed).
   */
  getKeyRegistry(): KeyRegistry {
    return this.keyRegistry;
  }

  /**
   * Get the underlying replay guard (for direct access when needed).
   */
  getReplayGuard(): ReplayGuard {
    return this.replayGuard;
  }
}
