// @meridian/axis — Circuit breaker for Gear execution
// Architecture Reference: Section 5.1.11 (fault tolerance)

import {
  CIRCUIT_BREAKER_FAILURES,
  CIRCUIT_BREAKER_WINDOW_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Circuit breaker states. */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
  /** Number of failures within the window before the circuit opens. */
  failureThreshold: number;
  /** Time window (ms) for counting failures. */
  windowMs: number;
  /** How long (ms) the circuit stays open before transitioning to half_open. */
  cooldownMs: number;
}

/** Internal per-Gear circuit state. */
interface GearCircuitState {
  state: CircuitBreakerState;
  failures: Array<number>; // timestamps
  lastStateChange: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

/**
 * In-memory circuit breaker that tracks failures per Gear ID.
 *
 * States:
 * - `closed`: Normal operation. Requests are allowed.
 * - `open`: Failures exceeded threshold. Requests are rejected.
 * - `half_open`: Cooldown expired. One probe request is allowed.
 *
 * Transitions:
 * - `closed` -> `open`: When failures within the window reach the threshold.
 * - `open` -> `half_open`: When the cooldown period expires.
 * - `half_open` -> `closed`: On a successful probe.
 * - `half_open` -> `open`: On a failed probe.
 */
export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly circuits: Map<string, GearCircuitState> = new Map();
  private readonly now: () => number;

  constructor(
    config?: Partial<CircuitBreakerConfig>,
    clock?: () => number,
  ) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? CIRCUIT_BREAKER_FAILURES,
      windowMs: config?.windowMs ?? CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: config?.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    };
    this.now = clock ?? Date.now;
  }

  /**
   * Record a successful execution for a Gear. Resets the circuit to closed.
   */
  recordSuccess(gearId: string): void {
    const circuit = this.circuits.get(gearId);
    if (!circuit) {
      return;
    }

    circuit.state = 'closed';
    circuit.failures = [];
    circuit.lastStateChange = this.now();
  }

  /**
   * Record a failed execution for a Gear. If the failure count within the
   * window reaches the threshold, the circuit opens.
   */
  recordFailure(gearId: string): void {
    const now = this.now();
    const circuit = this.getOrCreateCircuit(gearId, now);

    // If circuit is half_open, a failure sends it back to open
    if (circuit.state === 'half_open') {
      circuit.state = 'open';
      circuit.lastStateChange = now;
      circuit.failures = [now];
      return;
    }

    // Add the failure timestamp
    circuit.failures.push(now);

    // Prune failures outside the window
    this.pruneFailures(circuit, now);

    // Check threshold
    if (circuit.failures.length >= this.config.failureThreshold) {
      circuit.state = 'open';
      circuit.lastStateChange = now;
    }
  }

  /**
   * Check whether the circuit is open (rejecting requests) for a Gear.
   *
   * Returns `false` for unknown Gear IDs (no circuit = closed).
   * Respects the cooldown: an open circuit whose cooldown has expired
   * transitions to half_open and returns `false` (allowing a probe).
   */
  isOpen(gearId: string): boolean {
    const state = this.getState(gearId);
    return state === 'open';
  }

  /**
   * Get the current circuit breaker state for a Gear.
   *
   * Returns `'closed'` for unknown Gear IDs.
   * Handles the open -> half_open transition when the cooldown expires.
   */
  getState(gearId: string): CircuitBreakerState {
    const circuit = this.circuits.get(gearId);
    if (!circuit) {
      return 'closed';
    }

    // Check for open -> half_open transition
    if (circuit.state === 'open') {
      const elapsed = this.now() - circuit.lastStateChange;
      if (elapsed >= this.config.cooldownMs) {
        circuit.state = 'half_open';
        circuit.lastStateChange = this.now();
      }
    }

    return circuit.state;
  }

  /**
   * Force reset a Gear's circuit to closed.
   */
  reset(gearId: string): void {
    const circuit = this.circuits.get(gearId);
    if (!circuit) {
      return;
    }

    circuit.state = 'closed';
    circuit.failures = [];
    circuit.lastStateChange = this.now();
  }

  /**
   * List all Gear IDs whose circuits are currently open.
   *
   * Note: This evaluates cooldowns, so circuits that have cooled down
   * will transition to half_open and not be included.
   */
  getOpenCircuits(): string[] {
    const openIds: string[] = [];
    for (const [gearId] of this.circuits) {
      if (this.getState(gearId) === 'open') {
        openIds.push(gearId);
      }
    }
    return openIds;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateCircuit(gearId: string, now: number): GearCircuitState {
    let circuit = this.circuits.get(gearId);
    if (!circuit) {
      circuit = {
        state: 'closed',
        failures: [],
        lastStateChange: now,
      };
      this.circuits.set(gearId, circuit);
    }
    return circuit;
  }

  private pruneFailures(circuit: GearCircuitState, now: number): void {
    const windowStart = now - this.config.windowMs;
    circuit.failures = circuit.failures.filter((ts) => ts > windowStart);
  }
}
