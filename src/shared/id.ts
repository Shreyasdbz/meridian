// @meridian/shared — UUID v7 generation (RFC 9562)
// Time-sortable, cryptographically random UUIDs.

import { randomBytes } from 'node:crypto';

/**
 * Monotonic counter state to guarantee ordering within the same millisecond.
 * The counter is stored as a 12-bit value in the rand_a field.
 */
let lastTimestamp = 0;
let counter = 0;

/**
 * Generate a UUID v7 (time-sortable) per RFC 9562.
 *
 * Layout (128 bits):
 *   - bits  0-47:  unix_ts_ms (48-bit millisecond timestamp)
 *   - bits 48-51:  version (0b0111 = 7)
 *   - bits 52-63:  rand_a (12-bit counter for sub-millisecond ordering)
 *   - bits 64-65:  variant (0b10)
 *   - bits 66-127: rand_b (62 random bits)
 */
export function generateId(): string {
  const now = Date.now();

  if (now === lastTimestamp) {
    counter++;
    if (counter > 0xfff) {
      // Counter overflow — spin until next millisecond
      let next = Date.now();
      while (next === lastTimestamp) {
        next = Date.now();
      }
      lastTimestamp = next;
      counter = 0;
    }
  } else {
    lastTimestamp = now;
    counter = 0;
  }

  const timestamp = lastTimestamp;

  // Allocate 16 bytes
  const bytes = new Uint8Array(16);

  // Fill with random bytes first (for rand_b)
  const random = randomBytes(16);
  bytes.set(random);

  // Bytes 0-5: 48-bit timestamp (big-endian)
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Bytes 6-7: version (4 bits) + rand_a/counter (12 bits)
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + high 4 bits of counter
  bytes[7] = counter & 0xff; // low 8 bits of counter

  // Byte 8: variant (2 bits = 0b10) + high 6 bits of rand_b
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bytes[8] always exists in a 16-byte array
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // set variant to 0b10

  return formatUuid(bytes);
}

/**
 * Format 16 bytes as a UUID string: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
