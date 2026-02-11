import { describe, it, expect } from 'vitest';

import { generateId } from './id.js';

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateId', () => {
  it('should return a valid UUID v7 string', () => {
    const id = generateId();
    expect(id).toMatch(UUID_V7_REGEX);
  });

  it('should have version 7 in the correct position', () => {
    const id = generateId();
    // Version nibble is the 13th hex character (index 14 including hyphens)
    expect(id[14]).toBe('7');
  });

  it('should have the correct variant bits', () => {
    const id = generateId();
    // Variant nibble is the 17th hex character (index 19 including hyphens)
    const variantChar = id.charAt(19);
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });

  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });

  it('should be monotonically increasing (time-sortable)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(generateId());
    }

    // Strip hyphens for lexicographic comparison
    const stripped = ids.map((id) => id.replace(/-/g, ''));
    for (let i = 1; i < stripped.length; i++) {
      const current = stripped[i] ?? '';
      const previous = stripped[i - 1] ?? '';
      expect(current > previous).toBe(true);
    }
  });

  it('should encode the current timestamp in the first 48 bits', () => {
    const before = Date.now();
    const id = generateId();
    const after = Date.now();

    // Extract timestamp from the first 12 hex chars (48 bits)
    const hex = id.replace(/-/g, '').slice(0, 12);
    const timestamp = parseInt(hex, 16);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should produce 36-character strings with hyphens', () => {
    const id = generateId();
    expect(id.length).toBe(36);
    expect(id[8]).toBe('-');
    expect(id[13]).toBe('-');
    expect(id[18]).toBe('-');
    expect(id[23]).toBe('-');
  });
});
