import { describe, it, expect } from 'vitest';

import { ok, err, isOk, isErr, unwrap, unwrapOr, map, mapErr } from './result.js';

describe('Result', () => {
  describe('ok()', () => {
    it('should create a successful Result', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      expect(result).toHaveProperty('value', 42);
    });

    it('should work with string values', () => {
      const result = ok('hello');
      expect(result.ok).toBe(true);
      expect(result).toHaveProperty('value', 'hello');
    });

    it('should work with object values', () => {
      const obj = { name: 'test' };
      const result = ok(obj);
      expect(result.ok).toBe(true);
      expect(result).toHaveProperty('value', obj);
    });

    it('should work with null and undefined values', () => {
      expect(ok(null).ok).toBe(true);
      expect(ok(undefined).ok).toBe(true);
    });
  });

  describe('err()', () => {
    it('should create a failed Result', () => {
      const result = err('something went wrong');
      expect(result.ok).toBe(false);
      expect(result).toHaveProperty('error', 'something went wrong');
    });

    it('should work with Error objects', () => {
      const error = new Error('fail');
      const result = err(error);
      expect(result.ok).toBe(false);
      expect(result).toHaveProperty('error', error);
    });
  });

  describe('isOk()', () => {
    it('should return true for Ok results', () => {
      expect(isOk(ok(1))).toBe(true);
    });

    it('should return false for Err results', () => {
      expect(isOk(err('fail'))).toBe(false);
    });
  });

  describe('isErr()', () => {
    it('should return true for Err results', () => {
      expect(isErr(err('fail'))).toBe(true);
    });

    it('should return false for Ok results', () => {
      expect(isErr(ok(1))).toBe(false);
    });
  });

  describe('unwrap()', () => {
    it('should return the value for Ok results', () => {
      expect(unwrap(ok(42))).toBe(42);
    });

    it('should throw for Err results', () => {
      expect(() => unwrap(err('fail'))).toThrow('Called unwrap() on an Err Result: fail');
    });
  });

  describe('unwrapOr()', () => {
    it('should return the value for Ok results', () => {
      expect(unwrapOr(ok(42), 0)).toBe(42);
    });

    it('should return the default for Err results', () => {
      expect(unwrapOr(err('fail'), 0)).toBe(0);
    });
  });

  describe('map()', () => {
    it('should transform the Ok value', () => {
      const result = map(ok(2), (x) => x * 3);
      expect(isOk(result)).toBe(true);
      expect(unwrap(result)).toBe(6);
    });

    it('should leave Err unchanged', () => {
      const errResult: ReturnType<typeof err<string>> = err('fail');
      const result = map(errResult, (_x: number) => _x * 3);
      expect(isErr(result)).toBe(true);
      expect(result).toHaveProperty('error', 'fail');
    });
  });

  describe('mapErr()', () => {
    it('should transform the Err value', () => {
      const result = mapErr(err('fail'), (e) => `wrapped: ${e}`);
      expect(isErr(result)).toBe(true);
      expect(result).toHaveProperty('error', 'wrapped: fail');
    });

    it('should leave Ok unchanged', () => {
      const okResult: ReturnType<typeof ok<number>> = ok(42);
      const result = mapErr(okResult, (e: string) => `wrapped: ${e}`);
      expect(isOk(result)).toBe(true);
      expect(unwrap(result)).toBe(42);
    });
  });
});
