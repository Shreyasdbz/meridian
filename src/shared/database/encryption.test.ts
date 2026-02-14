import { describe, it, expect, afterEach } from 'vitest';

import {
  detectStorageType,
  getRecommendedKeyDerivationParams,
  isSqlCipherAvailable,
} from './encryption.js';
import type { ResolvedKeyDerivationParams } from './encryption.js';

describe('isSqlCipherAvailable', () => {
  it('should return false when @journeyapps/sqlcipher is not installed', async () => {
    // In the test environment, sqlcipher is not installed, so this should be false
    const result = await isSqlCipherAvailable();
    expect(result).toBe(false);
  });
});

describe('detectStorageType', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  afterEach(() => {
    // Restore original values
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  it('should return "sdcard" for ARM Linux (Raspberry Pi)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    expect(detectStorageType()).toBe('sdcard');
  });

  it('should return "sdcard" for 32-bit ARM Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'arm' });

    expect(detectStorageType()).toBe('sdcard');
  });

  it('should return "ssd" for macOS ARM (Apple Silicon)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    expect(detectStorageType()).toBe('ssd');
  });

  it('should return "ssd" for macOS x64 (Intel Mac)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    expect(detectStorageType()).toBe('ssd');
  });

  it('should return "ssd" for Linux x64 (desktop/VPS)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    expect(detectStorageType()).toBe('ssd');
  });

  it('should return "ssd" for Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    expect(detectStorageType()).toBe('ssd');
  });

  it('should return "unknown" for unrecognized platform', () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    expect(detectStorageType()).toBe('unknown');
  });
});

describe('getRecommendedKeyDerivationParams', () => {
  it('should return lighter parameters for sdcard', () => {
    const params = getRecommendedKeyDerivationParams('sdcard');

    expect(params).toEqual<ResolvedKeyDerivationParams>({
      timeCost: 2,
      memoryCost: 32768,
      parallelism: 2,
      keyLength: 32,
    });
  });

  it('should return standard parameters for ssd', () => {
    const params = getRecommendedKeyDerivationParams('ssd');

    expect(params).toEqual<ResolvedKeyDerivationParams>({
      timeCost: 3,
      memoryCost: 65536,
      parallelism: 4,
      keyLength: 32,
    });
  });

  it('should return standard parameters for unknown storage', () => {
    const params = getRecommendedKeyDerivationParams('unknown');

    expect(params).toEqual<ResolvedKeyDerivationParams>({
      timeCost: 3,
      memoryCost: 65536,
      parallelism: 4,
      keyLength: 32,
    });
  });

  it('should always produce a 256-bit key length', () => {
    const storageTypes: Array<'ssd' | 'sdcard' | 'unknown'> = ['ssd', 'sdcard', 'unknown'];

    for (const storageType of storageTypes) {
      const params = getRecommendedKeyDerivationParams(storageType);
      expect(params.keyLength).toBe(32); // 32 bytes = 256 bits
    }
  });

  it('should use lower memory cost for sdcard than ssd', () => {
    const sdcardParams = getRecommendedKeyDerivationParams('sdcard');
    const ssdParams = getRecommendedKeyDerivationParams('ssd');

    expect(sdcardParams.memoryCost).toBeLessThan(ssdParams.memoryCost);
  });
});
