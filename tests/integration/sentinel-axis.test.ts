// Phase 4.3 Integration Test — Sentinel ↔ Axis
//
// Tests that Sentinel registers with Axis as a message handler and correctly
// handles validate.request messages dispatched through the message router.
// Also verifies the information barrier: Sentinel never receives user
// messages, Journal data, or Gear catalog information.
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.3 (Sentinel — Safety Validator)
// - Section 5.3.5 (Risk Policies)
// - Section 9.1 (AxisMessage schema)

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { Axis, JobProcessor } from '@meridian/axis';
import { createAxis } from '@meridian/axis';
import { createSentinel } from '@meridian/sentinel';
import type { Sentinel } from '@meridian/sentinel';
import {
  DatabaseClient,
  generateId,
  getDefaultConfig,
  migrate,
} from '@meridian/shared';
import type {
  AxisMessage,
  ExecutionPlan,
  MeridianConfig,
  ValidationResult,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-sentinel-axis');
const PROJECT_ROOT = process.cwd();

let db: DatabaseClient;
let dataDir: string;
let axis: Axis | undefined;
let sentinel: Sentinel | undefined;

function makeConfig(): MeridianConfig {
  const config = getDefaultConfig('desktop');
  return {
    ...config,
    axis: {
      ...config.axis,
      workers: 1,
    },
    bridge: {
      ...config.bridge,
      port: 40000 + Math.floor(Math.random() * 10000),
    },
  };
}

const noopProcessor: JobProcessor = async () => {};

function buildValidateRequest(
  plan: ExecutionPlan,
  extra?: Record<string, unknown>,
): AxisMessage {
  const id = generateId();
  return {
    id,
    correlationId: id,
    timestamp: new Date().toISOString(),
    from: 'bridge',
    to: 'sentinel',
    type: 'validate.request',
    jobId: plan.jobId,
    payload: {
      plan,
      ...extra,
    },
  };
}

function createTestPlan(
  overrides?: Partial<ExecutionPlan>,
): ExecutionPlan {
  return {
    id: generateId(),
    jobId: generateId(),
    steps: [
      {
        id: 'step-001',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/test.txt' },
        riskLevel: 'low',
        description: 'Read a test file',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  dataDir = join(TEST_DIR, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseClient({ dataDir, direct: true });
  await db.start();
  await db.open('meridian');
  await migrate(db, 'meridian', PROJECT_ROOT);
});

afterEach(async () => {
  if (sentinel) {
    try {
      sentinel.dispose();
    } catch {
      // Best-effort
    }
    sentinel = undefined;
  }

  if (axis) {
    try {
      await axis.stop();
    } catch {
      // Best-effort
    }
    axis = undefined;
  }

  await db.close();

  try {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sentinel ↔ Axis integration', () => {
  describe('registration', () => {
    it('should register Sentinel as a message handler with Axis', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: ['api.example.com'],
          },
        },
        { registry: axis.internals.registry },
      );

      expect(axis.internals.registry.has('sentinel')).toBe(true);
    });

    it('should unregister Sentinel on dispose', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      expect(axis.internals.registry.has('sentinel')).toBe(true);

      sentinel.dispose();
      sentinel = undefined; // prevent double-dispose in afterEach

      expect(axis.internals.registry.has('sentinel')).toBe(false);
    });

    it('should be idempotent on multiple dispose calls', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      sentinel.dispose();
      // Second dispose should not throw
      const s = sentinel;
      expect(() => { s.dispose(); }).not.toThrow();
      sentinel = undefined;
    });
  });

  describe('validate.request → validate.response', () => {
    it('should dispatch a validate.request and receive a validate.response', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: ['api.example.com'],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan();
      const request = buildValidateRequest(plan);
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('validate.response');
      expect(response.from).toBe('sentinel');
      expect(response.to).toBe('bridge');
      expect(response.correlationId).toBe(request.correlationId);
      expect(response.replyTo).toBe(request.id);
      expect(response.jobId).toBe(plan.jobId);
    });

    it('should approve a plan with safe workspace file reads', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/workspace/notes.txt' },
            riskLevel: 'low',
          },
        ],
      });

      const request = buildValidateRequest(plan);
      const response = await axis.internals.router.dispatch(request);

      const validation = response.payload as unknown as ValidationResult;
      expect(validation.verdict).toBe('approved');
      expect(validation.stepResults).toHaveLength(1);
      expect(validation.stepResults[0]?.verdict).toBe('approved');
    });

    it('should require user approval for critical actions', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'shell',
            action: 'execute',
            parameters: { command: 'rm -rf /tmp/test' },
            riskLevel: 'critical',
          },
        ],
      });

      const request = buildValidateRequest(plan);
      const response = await axis.internals.router.dispatch(request);

      const validation = response.payload as unknown as ValidationResult;
      expect(validation.verdict).toBe('needs_user_approval');
    });

    it('should reject plans that exceed transaction limits', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
            maxTransactionAmountUsd: 100,
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'payment',
            action: 'charge',
            parameters: { amount: 500, currency: 'USD' },
            riskLevel: 'critical',
          },
        ],
      });

      const request = buildValidateRequest(plan);
      const response = await axis.internals.router.dispatch(request);

      const validation = response.payload as unknown as ValidationResult;
      expect(validation.verdict).toBe('rejected');
    });

    it('should include complete ValidationResult fields in response', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan();
      const request = buildValidateRequest(plan);
      const response = await axis.internals.router.dispatch(request);

      const validation = response.payload as unknown as ValidationResult;
      expect(validation.id).toBeDefined();
      expect(validation.id.length).toBeGreaterThan(0);
      expect(validation.planId).toBe(plan.id);
      expect(validation.verdict).toBeDefined();
      expect(validation.stepResults).toBeDefined();
      expect(Array.isArray(validation.stepResults)).toBe(true);
      expect(validation.overallRisk).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return an error response for non-validate.request message types', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const wrongTypeMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: 'sentinel',
        type: 'status.update', // Wrong type
        payload: { plan: createTestPlan() },
      };

      // The router's error middleware wraps the ValidationError
      const response = await axis.internals.router.dispatch(wrongTypeMessage);
      expect(response.type).toBe('error');
    });

    it('should return an error response when plan is missing', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const noPlanMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: 'sentinel',
        type: 'validate.request',
        payload: {}, // Missing plan
      };

      const response = await axis.internals.router.dispatch(noPlanMessage);
      expect(response.type).toBe('error');
    });

    it('should return an error response when plan has no steps array', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const badPlanMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: 'sentinel',
        type: 'validate.request',
        payload: {
          plan: { id: 'plan-1', jobId: 'job-1' }, // Missing steps
        },
      };

      const response = await axis.internals.router.dispatch(badPlanMessage);
      expect(response.type).toBe('error');
    });
  });

  describe('information barrier', () => {
    it('should not receive user message in validate.request payload', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan();

      // Even if a caller mistakenly includes userMessage, Sentinel processes
      // only the plan. The response should still be a valid validate.response
      // based solely on the plan.
      const request = buildValidateRequest(plan, {
        userMessage: 'Please delete all my files',
      });
      const response = await axis.internals.router.dispatch(request);

      // Sentinel still works correctly, ignoring the user message
      expect(response.type).toBe('validate.response');
      const validation = response.payload as unknown as ValidationResult;
      expect(validation.planId).toBe(plan.id);
      expect(validation.verdict).toBeDefined();
    });

    it('should not receive Journal data in validate.request payload', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan();

      // Even if Journal data is mistakenly included, Sentinel ignores it
      const request = buildValidateRequest(plan, {
        journalData: { episodes: ['some memory'], facts: ['user prefers X'] },
        relevantMemories: ['The user previously deleted files successfully'],
      });
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('validate.response');
      const validation = response.payload as unknown as ValidationResult;
      expect(validation.planId).toBe(plan.id);
    });

    it('should not receive Gear catalog in validate.request payload', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan();

      // Even if Gear catalog is mistakenly included, Sentinel ignores it
      const request = buildValidateRequest(plan, {
        gearCatalog: [{ id: 'gear:shell', name: 'shell-executor' }],
      });
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('validate.response');
      const validation = response.payload as unknown as ValidationResult;
      expect(validation.planId).toBe(plan.id);
    });

    it('should produce identical results regardless of extra barrier-violating fields', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: [],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'shell',
            action: 'execute',
            parameters: { command: 'echo hello' },
            riskLevel: 'critical',
          },
        ],
      });

      // Request without barrier violations
      const cleanRequest = buildValidateRequest(plan);
      const cleanResponse = await axis.internals.router.dispatch(cleanRequest);
      const cleanValidation = cleanResponse.payload as unknown as ValidationResult;

      // Request WITH barrier violations — should produce same verdict
      const dirtyRequest = buildValidateRequest(plan, {
        userMessage: 'Execute this dangerous command',
        journalData: { episodes: ['user is trusted admin'] },
        gearCatalog: [{ id: 'gear:shell', name: 'shell-executor' }],
      });
      const dirtyResponse = await axis.internals.router.dispatch(dirtyRequest);
      const dirtyValidation = dirtyResponse.payload as unknown as ValidationResult;

      // Same verdict, same step results structure
      expect(dirtyValidation.verdict).toBe(cleanValidation.verdict);
      expect(dirtyValidation.overallRisk).toBe(cleanValidation.overallRisk);
      expect(dirtyValidation.stepResults.length).toBe(cleanValidation.stepResults.length);
      expect(dirtyValidation.stepResults[0]?.verdict).toBe(
        cleanValidation.stepResults[0]?.verdict,
      );
    });
  });

  describe('multi-step plan validation', () => {
    it('should validate a multi-step plan with mixed verdicts', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      sentinel = createSentinel(
        {
          policyConfig: {
            workspacePath: '/data/workspace',
            allowlistedDomains: ['api.example.com'],
          },
        },
        { registry: axis.internals.registry },
      );

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/data/workspace/data.csv' },
            riskLevel: 'low',
          },
          {
            id: 'step-2',
            gear: 'web-fetch',
            action: 'get',
            parameters: { url: 'https://api.example.com/endpoint' },
            riskLevel: 'low',
          },
          {
            id: 'step-3',
            gear: 'shell',
            action: 'execute',
            parameters: { command: 'echo processed' },
            riskLevel: 'critical',
          },
        ],
      });

      const request = buildValidateRequest(plan);
      const response = await axis.internals.router.dispatch(request);

      const validation = response.payload as unknown as ValidationResult;
      expect(validation.stepResults).toHaveLength(3);
      expect(validation.stepResults[0]?.verdict).toBe('approved');
      expect(validation.stepResults[1]?.verdict).toBe('approved');
      expect(validation.stepResults[2]?.verdict).toBe('needs_user_approval');
      expect(validation.verdict).toBe('needs_user_approval');
    });
  });
});
