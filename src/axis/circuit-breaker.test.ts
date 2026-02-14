import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CircuitBreaker } from './circuit-breaker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THRESHOLD = 3;
const WINDOW_MS = 300_000; // 5 minutes
const COOLDOWN_MS = 60_000; // 1 minute

function createBreaker(): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: THRESHOLD,
    windowMs: WINDOW_MS,
    cooldownMs: COOLDOWN_MS,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // State transitions: closed -> open
  // -------------------------------------------------------------------------

  describe('closed -> open after threshold failures', () => {
    it('should stay closed below the failure threshold', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('closed');
      expect(cb.isOpen('gear:http')).toBe(false);
    });

    it('should open after reaching the failure threshold', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('open');
      expect(cb.isOpen('gear:http')).toBe(true);
    });

    it('should open after exceeding the failure threshold', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('open');
      expect(cb.isOpen('gear:http')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Window expiry
  // -------------------------------------------------------------------------

  describe('window expiry', () => {
    it('should not count failures outside the time window', () => {
      const cb = createBreaker();

      // Two failures at t=0
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      // Advance past the window
      vi.advanceTimersByTime(WINDOW_MS + 1);

      // One more failure — old ones should be pruned
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('closed');
      expect(cb.isOpen('gear:http')).toBe(false);
    });

    it('should open when failures within window reach threshold', () => {
      const cb = createBreaker();

      // One failure at t=0
      cb.recordFailure('gear:http');

      // Advance to near-end of window
      vi.advanceTimersByTime(WINDOW_MS - 1000);

      // Two more failures within the window
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('open');
    });

    it('should stay closed when failures are spread across windows', () => {
      const cb = createBreaker();

      // One failure per window — never reaching threshold in a single window
      cb.recordFailure('gear:http');
      vi.advanceTimersByTime(WINDOW_MS + 1);

      cb.recordFailure('gear:http');
      vi.advanceTimersByTime(WINDOW_MS + 1);

      cb.recordFailure('gear:http');

      // Each failure is in a different window, so only 1 counts
      expect(cb.getState('gear:http')).toBe('closed');
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown: open -> half_open
  // -------------------------------------------------------------------------

  describe('cooldown transition', () => {
    it('should transition to half_open after cooldown expires', () => {
      const cb = createBreaker();

      // Open the circuit
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      expect(cb.getState('gear:http')).toBe('open');

      // Advance past cooldown
      vi.advanceTimersByTime(COOLDOWN_MS);

      expect(cb.getState('gear:http')).toBe('half_open');
      expect(cb.isOpen('gear:http')).toBe(false);
    });

    it('should stay open before cooldown expires', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      // Advance to just before cooldown
      vi.advanceTimersByTime(COOLDOWN_MS - 1);

      expect(cb.getState('gear:http')).toBe('open');
      expect(cb.isOpen('gear:http')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // half_open -> closed (success)
  // -------------------------------------------------------------------------

  describe('half_open -> closed on success', () => {
    it('should close the circuit when a probe succeeds in half_open', () => {
      const cb = createBreaker();

      // Open the circuit
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      // Transition to half_open
      vi.advanceTimersByTime(COOLDOWN_MS);
      expect(cb.getState('gear:http')).toBe('half_open');

      // Probe succeeds
      cb.recordSuccess('gear:http');

      expect(cb.getState('gear:http')).toBe('closed');
      expect(cb.isOpen('gear:http')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // half_open -> open (failure)
  // -------------------------------------------------------------------------

  describe('half_open -> open on failure', () => {
    it('should reopen the circuit when a probe fails in half_open', () => {
      const cb = createBreaker();

      // Open the circuit
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      // Transition to half_open
      vi.advanceTimersByTime(COOLDOWN_MS);
      expect(cb.getState('gear:http')).toBe('half_open');

      // Probe fails
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('open');
      expect(cb.isOpen('gear:http')).toBe(true);
    });

    it('should require another cooldown after reopening from half_open', () => {
      const cb = createBreaker();

      // Open -> half_open -> open cycle
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      vi.advanceTimersByTime(COOLDOWN_MS);
      expect(cb.getState('gear:http')).toBe('half_open');
      cb.recordFailure('gear:http');
      expect(cb.getState('gear:http')).toBe('open');

      // Should need another full cooldown
      vi.advanceTimersByTime(COOLDOWN_MS - 1);
      expect(cb.getState('gear:http')).toBe('open');

      vi.advanceTimersByTime(1);
      expect(cb.getState('gear:http')).toBe('half_open');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-Gear tracking (independent circuits)
  // -------------------------------------------------------------------------

  describe('multi-Gear tracking', () => {
    it('should track circuits independently per Gear ID', () => {
      const cb = createBreaker();

      // Open gear:http
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      // gear:email has only one failure
      cb.recordFailure('gear:email');

      expect(cb.getState('gear:http')).toBe('open');
      expect(cb.isOpen('gear:http')).toBe(true);

      expect(cb.getState('gear:email')).toBe('closed');
      expect(cb.isOpen('gear:email')).toBe(false);
    });

    it('should not affect other Gear when one is reset', () => {
      const cb = createBreaker();

      // Open both
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      cb.recordFailure('gear:email');
      cb.recordFailure('gear:email');
      cb.recordFailure('gear:email');

      expect(cb.getState('gear:http')).toBe('open');
      expect(cb.getState('gear:email')).toBe('open');

      // Reset only one
      cb.reset('gear:http');

      expect(cb.getState('gear:http')).toBe('closed');
      expect(cb.getState('gear:email')).toBe('open');
    });
  });

  // -------------------------------------------------------------------------
  // Manual reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('should reset an open circuit to closed', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      expect(cb.getState('gear:http')).toBe('open');

      cb.reset('gear:http');

      expect(cb.getState('gear:http')).toBe('closed');
      expect(cb.isOpen('gear:http')).toBe(false);
    });

    it('should clear failure history on reset', () => {
      const cb = createBreaker();

      // Get to 2 failures (just below threshold)
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      cb.reset('gear:http');

      // One more failure should not open the circuit
      cb.recordFailure('gear:http');

      expect(cb.getState('gear:http')).toBe('closed');
    });

    it('should be a no-op for unknown Gear IDs', () => {
      const cb = createBreaker();

      // Should not throw
      cb.reset('gear:unknown');

      expect(cb.getState('gear:unknown')).toBe('closed');
    });
  });

  // -------------------------------------------------------------------------
  // getOpenCircuits
  // -------------------------------------------------------------------------

  describe('getOpenCircuits', () => {
    it('should return all currently open Gear IDs', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      cb.recordFailure('gear:email');
      cb.recordFailure('gear:email');
      cb.recordFailure('gear:email');

      const open = cb.getOpenCircuits();
      expect(open).toContain('gear:http');
      expect(open).toContain('gear:email');
      expect(open).toHaveLength(2);
    });

    it('should not include closed circuits', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      cb.recordFailure('gear:email');

      const open = cb.getOpenCircuits();
      expect(open).toContain('gear:http');
      expect(open).not.toContain('gear:email');
      expect(open).toHaveLength(1);
    });

    it('should not include half_open circuits', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');

      vi.advanceTimersByTime(COOLDOWN_MS);

      const open = cb.getOpenCircuits();
      expect(open).not.toContain('gear:http');
      expect(open).toHaveLength(0);
    });

    it('should return an empty array when no circuits exist', () => {
      const cb = createBreaker();
      expect(cb.getOpenCircuits()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // isOpen for unknown Gear
  // -------------------------------------------------------------------------

  describe('unknown Gear IDs', () => {
    it('should return false from isOpen for unknown Gear', () => {
      const cb = createBreaker();
      expect(cb.isOpen('gear:never-seen')).toBe(false);
    });

    it('should return closed from getState for unknown Gear', () => {
      const cb = createBreaker();
      expect(cb.getState('gear:never-seen')).toBe('closed');
    });
  });

  // -------------------------------------------------------------------------
  // recordSuccess for closed circuit
  // -------------------------------------------------------------------------

  describe('recordSuccess', () => {
    it('should be a no-op for unknown Gear IDs', () => {
      const cb = createBreaker();

      // Should not throw
      cb.recordSuccess('gear:unknown');

      expect(cb.getState('gear:unknown')).toBe('closed');
    });

    it('should reset a closed circuit with accumulated failures', () => {
      const cb = createBreaker();

      cb.recordFailure('gear:http');
      cb.recordFailure('gear:http');
      expect(cb.getState('gear:http')).toBe('closed');

      cb.recordSuccess('gear:http');

      // Failures should be cleared — one more should not open
      cb.recordFailure('gear:http');
      expect(cb.getState('gear:http')).toBe('closed');
    });
  });

  // -------------------------------------------------------------------------
  // Default config
  // -------------------------------------------------------------------------

  describe('default configuration', () => {
    it('should use default constants when no config is provided', () => {
      const cb = new CircuitBreaker();

      // Default threshold is CIRCUIT_BREAKER_FAILURES (3)
      cb.recordFailure('gear:test');
      cb.recordFailure('gear:test');
      expect(cb.getState('gear:test')).toBe('closed');

      cb.recordFailure('gear:test');
      expect(cb.getState('gear:test')).toBe('open');
    });
  });
});
