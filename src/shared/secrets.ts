// @meridian/shared — Encrypted secrets vault with ACL enforcement
// Secrets are stored as Buffer objects, never JavaScript strings.
// AES-256-GCM encryption with Argon2id key derivation.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import argon2 from 'argon2';

import { AuthenticationError, NotFoundError, SecretAccessError } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata about a stored secret (never includes the value). */
export interface SecretMetadata {
  name: string;
  allowedGear: string[];
  createdAt: string;
  lastUsedAt: string;
  rotateAfterDays?: number;
}

/** Warning for a secret that should be rotated. */
export interface SecretRotationWarning {
  name: string;
  ageInDays: number;
  rotateAfterDays: number;
}

/** Argon2id tier configuration. */
type VaultTier = 'standard' | 'low-power';

/** On-disk representation of a single secret entry. */
interface VaultSecretEntry {
  iv: string; // base64
  authTag: string; // base64
  ciphertext: string; // base64
  allowedGear: string[];
  createdAt: string;
  lastUsedAt: string;
  rotateAfterDays?: number;
}

/**
 * On-disk vault file format.
 * Note: Secret *values* are encrypted (AES-256-GCM). Secret *names*, ACLs,
 * and timestamps are stored as plaintext JSON — consistent with how most
 * password managers expose entry names. If name confidentiality is needed,
 * a future enhancement could encrypt the entire secrets map as one blob.
 */
interface VaultFile {
  version: number;
  salt: string; // base64
  tier: VaultTier;
  verifier: string; // base64 — encrypted known value to validate password
  verifierIv: string; // base64
  verifierTag: string; // base64
  secrets: Record<string, VaultSecretEntry>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_VERSION = 1;
const AES_KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const ALGORITHM = 'aes-256-gcm';
const VERIFIER_PLAINTEXT = Buffer.from('meridian-vault-verifier');

/** Argon2id parameters per tier (from architecture Section 6.4). */
const ARGON2_PARAMS: Record<
  VaultTier,
  { memoryCost: number; timeCost: number; parallelism: number }
> = {
  standard: { memoryCost: 65536, timeCost: 3, parallelism: 1 }, // 64 MiB
  'low-power': { memoryCost: 19456, timeCost: 2, parallelism: 1 }, // 19 MiB
};

// ---------------------------------------------------------------------------
// SecretsVault
// ---------------------------------------------------------------------------

export class SecretsVault {
  private readonly vaultPath: string;
  private derivedKey: Buffer | null = null;
  private vault: VaultFile | null = null;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  /**
   * Initialize a new vault with the given password.
   * Creates the vault file. Fails if a vault already exists.
   */
  async initialize(password: string, tier: VaultTier): Promise<void> {
    if (existsSync(this.vaultPath)) {
      throw new SecretAccessError('Vault already exists. Use unlock() instead.');
    }

    const salt = randomBytes(32);
    const key = await this.deriveKey(password, salt, tier);

    // Encrypt verifier to validate password on unlock
    const { ciphertext, iv, authTag } = this.encrypt(VERIFIER_PLAINTEXT, key);

    const vaultData: VaultFile = {
      version: VAULT_VERSION,
      salt: salt.toString('base64'),
      tier,
      verifier: ciphertext.toString('base64'),
      verifierIv: iv.toString('base64'),
      verifierTag: authTag.toString('base64'),
      secrets: {},
    };

    await this.ensureDirectory();
    await writeFile(this.vaultPath, JSON.stringify(vaultData, null, 2), 'utf-8');

    this.derivedKey = key;
    this.vault = vaultData;
  }

  /**
   * Unlock an existing vault with the given password.
   * Derives the key and validates it against the stored verifier.
   */
  async unlock(password: string): Promise<void> {
    if (!existsSync(this.vaultPath)) {
      throw new NotFoundError('Vault file not found. Use initialize() to create one.');
    }

    const raw = await readFile(this.vaultPath, 'utf-8');
    const vaultData = JSON.parse(raw) as VaultFile;

    if (vaultData.version !== VAULT_VERSION) {
      throw new SecretAccessError(
        `Unsupported vault version: ${String(vaultData.version)}`,
      );
    }

    const salt = Buffer.from(vaultData.salt, 'base64');
    const key = await this.deriveKey(password, salt, vaultData.tier);

    // Validate password by decrypting the verifier.
    // GCM auth tag check will throw on wrong password, but we also
    // explicitly compare the plaintext for defense-in-depth.
    const verifierPlaintext = this.decrypt(
      Buffer.from(vaultData.verifier, 'base64'),
      Buffer.from(vaultData.verifierIv, 'base64'),
      Buffer.from(vaultData.verifierTag, 'base64'),
      key,
    );
    const isValid = VERIFIER_PLAINTEXT.equals(verifierPlaintext);
    verifierPlaintext.fill(0);
    if (!isValid) {
      key.fill(0);
      throw new AuthenticationError('Invalid vault password');
    }

    this.derivedKey = key;
    this.vault = vaultData;
  }

  /** Lock the vault and zero the derived key from memory. */
  lock(): void {
    if (this.derivedKey) {
      this.derivedKey.fill(0);
      this.derivedKey = null;
    }
    this.vault = null;
  }

  /** Store a secret with an ACL specifying which Gear can access it. */
  async store(
    name: string,
    value: Buffer,
    allowedGear: string[],
    options?: { rotateAfterDays?: number },
  ): Promise<void> {
    const { vault, key } = this.getUnlockedState();

    const { ciphertext, iv, authTag } = this.encrypt(value, key);
    const now = new Date().toISOString();

    vault.secrets[name] = {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      allowedGear,
      createdAt: vault.secrets[name]?.createdAt ?? now,
      lastUsedAt: now,
      rotateAfterDays: options?.rotateAfterDays,
    };

    await this.persistVault(vault);
  }

  /**
   * Retrieve a secret value as a Buffer.
   * Enforces ACL: the requesting Gear must be in the secret's allowedGear list.
   * Returns undefined if the secret does not exist.
   * IMPORTANT: The caller MUST zero the returned Buffer after use.
   */
  async retrieve(name: string, requestingGear: string): Promise<Buffer | undefined> {
    const { vault, key } = this.getUnlockedState();

    const entry = vault.secrets[name];
    if (!entry) {
      return undefined;
    }

    // ACL enforcement — missing ACL = denied
    if (!entry.allowedGear.includes(requestingGear)) {
      throw new SecretAccessError(
        `Gear '${requestingGear}' is not authorized to access secret '${name}'`,
      );
    }

    const plaintext = this.decrypt(
      Buffer.from(entry.ciphertext, 'base64'),
      Buffer.from(entry.iv, 'base64'),
      Buffer.from(entry.authTag, 'base64'),
      key,
    );

    // Update lastUsedAt
    entry.lastUsedAt = new Date().toISOString();
    await this.persistVault(vault);

    return plaintext;
  }

  /** Delete a secret from the vault. */
  async delete(name: string): Promise<void> {
    const { vault } = this.getUnlockedState();

    if (!(name in vault.secrets)) {
      throw new NotFoundError(`Secret '${name}' not found`);
    }

    // Use a rebuilt secrets object to avoid dynamic delete
    const updated: Record<string, VaultSecretEntry> = {};
    for (const [key, value] of Object.entries(vault.secrets)) {
      if (key !== name) {
        updated[key] = value;
      }
    }
    vault.secrets = updated;

    await this.persistVault(vault);
  }

  /** List all secret metadata (names and metadata only, never values). */
  // eslint-disable-next-line @typescript-eslint/require-await
  async list(): Promise<SecretMetadata[]> {
    const { vault } = this.getUnlockedState();

    return Object.entries(vault.secrets).map(([name, entry]) => ({
      name,
      allowedGear: [...entry.allowedGear],
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      rotateAfterDays: entry.rotateAfterDays,
    }));
  }

  /** Check for secrets that should be rotated based on rotateAfterDays. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async rotationCheck(): Promise<SecretRotationWarning[]> {
    const { vault } = this.getUnlockedState();

    const now = Date.now();
    const warnings: SecretRotationWarning[] = [];

    for (const [name, entry] of Object.entries(vault.secrets)) {
      if (entry.rotateAfterDays === undefined) continue;

      const createdMs = new Date(entry.createdAt).getTime();
      const ageInDays = Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));

      if (ageInDays >= entry.rotateAfterDays) {
        warnings.push({
          name,
          ageInDays,
          rotateAfterDays: entry.rotateAfterDays,
        });
      }
    }

    return warnings;
  }

  /** Returns true if the vault is currently unlocked. */
  get isUnlocked(): boolean {
    return this.derivedKey !== null && this.vault !== null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the unlocked vault state with narrowed types.
   * Throws if the vault is locked.
   */
  private getUnlockedState(): { vault: VaultFile; key: Buffer } {
    if (!this.derivedKey || !this.vault) {
      throw new SecretAccessError('Vault is locked. Call unlock() first.');
    }
    return { vault: this.vault, key: this.derivedKey };
  }

  private async deriveKey(
    password: string,
    salt: Buffer,
    tier: VaultTier,
  ): Promise<Buffer> {
    const params = ARGON2_PARAMS[tier];
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      salt,
      memoryCost: params.memoryCost,
      timeCost: params.timeCost,
      parallelism: params.parallelism,
      hashLength: AES_KEY_LENGTH,
      raw: true,
    });
    return Buffer.isBuffer(hash) ? hash : Buffer.from(hash);
  }

  private encrypt(
    plaintext: Buffer,
    key: Buffer,
  ): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext: encrypted, iv, authTag };
  }

  private decrypt(
    ciphertext: Buffer,
    iv: Buffer,
    authTag: Buffer,
    key: Buffer,
  ): Buffer {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new AuthenticationError(
        'Decryption failed — invalid password or corrupted data',
      );
    }
  }

  private async persistVault(vault: VaultFile): Promise<void> {
    await writeFile(this.vaultPath, JSON.stringify(vault, null, 2), 'utf-8');
  }

  private async ensureDirectory(): Promise<void> {
    const dir = dirname(this.vaultPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
}
