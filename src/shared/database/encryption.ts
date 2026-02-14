// @meridian/shared — Optional database encryption (Phase 9.8)
// Provides SQLCipher integration via dynamic import for encrypted databases.
// When enabled, databases are encrypted at rest using AES-256-GCM (via SQLCipher)
// with keys derived from a master passphrase using Argon2id.

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

/**
 * Configuration for database encryption.
 */
export interface EncryptionConfig {
  /** Whether encryption is enabled. */
  enabled: boolean;
}

/**
 * Key derivation options using Argon2id.
 * Argon2id is the recommended algorithm for password hashing / key derivation,
 * combining resistance to GPU attacks (Argon2i) and side-channel attacks (Argon2d).
 */
export interface KeyDerivationOptions {
  /** Salt for key derivation (must be at least 16 bytes). */
  salt: Buffer;
  /** Argon2id time cost (number of iterations). Default: 3. */
  timeCost?: number;
  /** Argon2id memory cost in KiB. Default: 65536 (64 MB). */
  memoryCost?: number;
  /** Argon2id parallelism (number of threads). Default: 4. */
  parallelism?: number;
  /** Output key length in bytes. Default: 32 (256 bits). */
  keyLength?: number;
}

/**
 * Resolved key derivation parameters (all fields required).
 */
export type ResolvedKeyDerivationParams = Required<Omit<KeyDerivationOptions, 'salt'>>;

// ---------------------------------------------------------------------------
// SQLCipher availability check
// ---------------------------------------------------------------------------

/**
 * Check if SQLCipher is available as an optional dependency.
 * Returns true if `@journeyapps/sqlcipher` can be dynamically imported.
 *
 * SQLCipher is a native module that replaces `better-sqlite3` with an
 * encryption-capable build. It is not required for basic operation.
 */
export async function isSqlCipherAvailable(): Promise<boolean> {
  try {
    // @ts-expect-error — @journeyapps/sqlcipher is an optional peer dependency
    await import('@journeyapps/sqlcipher');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Storage type detection
// ---------------------------------------------------------------------------

/**
 * Detect the likely storage type (SSD vs SD card).
 * Helps configure appropriate Argon2id parameters — SD cards are much slower
 * for random I/O, so lighter key derivation parameters reduce startup latency
 * on low-power devices like Raspberry Pi.
 *
 * Returns `'ssd'` for fast storage, `'sdcard'` for slow storage (ARM Linux),
 * or `'unknown'` for unrecognizable platforms.
 */
export function detectStorageType(): 'ssd' | 'sdcard' | 'unknown' {
  const platform = process.platform;
  const cpuArch = process.arch;

  // ARM on Linux → likely Raspberry Pi with SD card storage
  if ((cpuArch === 'arm' || cpuArch === 'arm64') && platform === 'linux') {
    return 'sdcard';
  }

  // macOS ARM = Apple Silicon with NVMe SSD
  // macOS x64 = Intel Mac with SSD
  if (platform === 'darwin') {
    return 'ssd';
  }

  // Linux x64 or Windows → typically SSD (desktop or VPS)
  if (platform === 'linux' || platform === 'win32') {
    return 'ssd';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Recommended key derivation parameters
// ---------------------------------------------------------------------------

/**
 * Get recommended Argon2id parameters based on storage type.
 *
 * SD card devices (Raspberry Pi) get lighter parameters to keep startup
 * time reasonable on slow I/O and limited RAM. SSD/unknown devices use
 * standard OWASP-recommended parameters.
 *
 * @param storageType - Detected or manually specified storage type.
 * @returns Fully resolved key derivation parameters (excluding salt).
 */
export function getRecommendedKeyDerivationParams(
  storageType: 'ssd' | 'sdcard' | 'unknown',
): ResolvedKeyDerivationParams {
  if (storageType === 'sdcard') {
    return {
      timeCost: 2,
      memoryCost: 32768, // 32 MB — fits within Pi's limited RAM
      parallelism: 2,
      keyLength: 32, // 256-bit key for AES-256
    };
  }

  // SSD or unknown — use standard parameters
  return {
    timeCost: 3,
    memoryCost: 65536, // 64 MB
    parallelism: 4,
    keyLength: 32, // 256-bit key for AES-256
  };
}
