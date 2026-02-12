import { describe, it, expect } from 'vitest';

import type { ExecutionPlan, GearManifest } from '@meridian/shared';
import { isOk, isErr } from '@meridian/shared';

import type { GearLookup, PlanValidationIssue } from './plan-validator.js';
import { validatePlan } from './plan-validator.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test gear',
    author: 'test',
    license: 'Apache-2.0',
    actions: [
      {
        name: 'do_thing',
        description: 'Does a thing',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
          required: ['input'],
          additionalProperties: false,
        },
        returns: { type: 'object' },
        riskLevel: 'low',
      },
    ],
    permissions: {},
    origin: 'builtin',
    checksum: 'abc123',
    ...overrides,
  };
}

function createTestPlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-001',
    jobId: 'job-001',
    steps: [
      {
        id: 'step-1',
        gear: 'test-gear',
        action: 'do_thing',
        parameters: { input: 'hello' },
        riskLevel: 'low',
      },
    ],
    ...overrides,
  };
}

function createMockRegistry(
  manifests: Record<string, GearManifest>,
): GearLookup {
  return {
    getManifest(gearId: string): GearManifest | undefined {
      return manifests[gearId];
    },
  };
}

function getIssueTypes(issues: PlanValidationIssue[]): string[] {
  return issues.map((i) => i.type);
}

function findIssue(
  issues: PlanValidationIssue[],
  type: string,
): PlanValidationIssue {
  const found = issues.find((i) => i.type === type);
  expect(found).toBeDefined();
  return found as PlanValidationIssue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validatePlan', () => {
  const defaultManifest = createTestManifest();
  const defaultRegistry = createMockRegistry({ 'test-gear': defaultManifest });

  describe('valid plan', () => {
    it('should accept a structurally valid plan with known Gear and actions', () => {
      const plan = createTestPlan();
      const result = validatePlan(plan, defaultRegistry);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe(plan);
      }
    });

    it('should accept a plan with valid dependsOn references', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'first' },
            riskLevel: 'low',
          },
          {
            id: 'step-2',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'second' },
            riskLevel: 'low',
            dependsOn: ['step-1'],
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);
      expect(isOk(result)).toBe(true);
    });

    it('should accept parameters that match the JSON Schema', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'valid string' },
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);
      expect(isOk(result)).toBe(true);
    });
  });

  describe('empty plan rejection', () => {
    it('should reject a plan with no steps', () => {
      const plan = createTestPlan({ steps: [] });
      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toHaveLength(1);
        const issue = findIssue(result.error, 'empty_plan');
        expect(issue.type).toBe('empty_plan');
        expect(issue.message).toContain('at least one step');
      }
    });
  });

  describe('missing Gear detection', () => {
    it('should detect a reference to a non-existent Gear', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'nonexistent-gear',
            action: 'do_thing',
            parameters: { input: 'hello' },
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('missing_gear');
        const issue = findIssue(result.error, 'missing_gear');
        expect(issue.stepId).toBe('step-1');
        expect(issue.message).toContain('nonexistent-gear');
      }
    });

    it('should detect multiple missing Gear references', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'ghost-a',
            action: 'act',
            parameters: {},
            riskLevel: 'low',
          },
          {
            id: 'step-2',
            gear: 'ghost-b',
            action: 'act',
            parameters: {},
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, createMockRegistry({}));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        const missingGearIssues = result.error.filter(
          (i) => i.type === 'missing_gear',
        );
        expect(missingGearIssues).toHaveLength(2);
      }
    });
  });

  describe('unknown action detection', () => {
    it('should detect an action not defined in the Gear manifest', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'nonexistent_action',
            parameters: {},
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('unknown_action');
        const issue = findIssue(result.error, 'unknown_action');
        expect(issue.stepId).toBe('step-1');
        expect(issue.message).toContain('nonexistent_action');
        expect(issue.message).toContain('test-gear');
      }
    });
  });

  describe('invalid parameter schema detection', () => {
    it('should detect parameters that violate the JSON Schema', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 42 }, // should be string
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('invalid_parameters');
        const issue = findIssue(result.error, 'invalid_parameters');
        expect(issue.stepId).toBe('step-1');
        expect(issue.details).toBeDefined();
        expect(issue.details?.schemaErrors).toBeDefined();
      }
    });

    it('should detect missing required parameters', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: {}, // missing required 'input'
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('invalid_parameters');
      }
    });

    it('should detect additional properties when not allowed', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'hello', extra: 'not allowed' },
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('invalid_parameters');
      }
    });
  });

  describe('duplicate step ID detection', () => {
    it('should detect duplicate step IDs', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'first' },
            riskLevel: 'low',
          },
          {
            id: 'step-1', // duplicate
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'second' },
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('duplicate_step_id');
        const issue = findIssue(result.error, 'duplicate_step_id');
        expect(issue.stepId).toBe('step-1');
      }
    });
  });

  describe('invalid dependsOn reference detection', () => {
    it('should detect dependsOn referencing a non-existent step ID', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'hello' },
            riskLevel: 'low',
            dependsOn: ['step-999'],
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(getIssueTypes(result.error)).toContain('invalid_dependency');
        const issue = findIssue(result.error, 'invalid_dependency');
        expect(issue.stepId).toBe('step-1');
        expect(issue.message).toContain('step-999');
      }
    });

    it('should detect multiple invalid dependsOn references in one step', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'do_thing',
            parameters: { input: 'hello' },
            riskLevel: 'low',
            dependsOn: ['ghost-a', 'ghost-b'],
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        const depIssues = result.error.filter(
          (i) => i.type === 'invalid_dependency',
        );
        expect(depIssues).toHaveLength(2);
      }
    });
  });

  describe('multiple errors in a single plan', () => {
    it('should collect all errors instead of short-circuiting', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'nonexistent-gear',
            action: 'act',
            parameters: {},
            riskLevel: 'low',
          },
          {
            id: 'step-1', // duplicate ID
            gear: 'test-gear',
            action: 'unknown_action',
            parameters: {},
            riskLevel: 'low',
            dependsOn: ['step-999'], // invalid dependency
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        const types = getIssueTypes(result.error);
        expect(types).toContain('duplicate_step_id');
        expect(types).toContain('invalid_dependency');
        expect(types).toContain('missing_gear');
        expect(types).toContain('unknown_action');
        expect(result.error.length).toBeGreaterThanOrEqual(4);
      }
    });
  });

  describe('edge cases', () => {
    it('should accept a Gear action with an empty parameter schema', () => {
      const manifest = createTestManifest({
        actions: [
          {
            name: 'no_params',
            description: 'An action with no parameters',
            parameters: {},
            returns: { type: 'object' },
            riskLevel: 'low',
          },
        ],
      });
      const registry = createMockRegistry({ 'test-gear': manifest });

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'no_params',
            parameters: {},
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, registry);
      expect(isOk(result)).toBe(true);
    });

    it('should skip action/parameter checks when Gear is missing', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'missing-gear',
            action: 'any_action',
            parameters: { anything: true },
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, createMockRegistry({}));

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        // Only missing_gear — no unknown_action or invalid_parameters
        expect(result.error).toHaveLength(1);
        expect(result.error[0]?.type).toBe('missing_gear');
      }
    });

    it('should skip parameter checks when action is unknown', () => {
      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'test-gear',
            action: 'nonexistent',
            parameters: { whatever: true },
            riskLevel: 'low',
          },
        ],
      });

      const result = validatePlan(plan, defaultRegistry);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        // Only unknown_action — no invalid_parameters
        expect(result.error).toHaveLength(1);
        expect(result.error[0]?.type).toBe('unknown_action');
      }
    });

    it('should validate plans with multiple Gear from different registries', () => {
      const emailManifest = createTestManifest({
        id: 'email-gmail',
        actions: [
          {
            name: 'send_email',
            description: 'Send an email',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                subject: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['to', 'subject', 'body'],
            },
            returns: { type: 'object' },
            riskLevel: 'medium',
          },
        ],
      });

      const fileManifest = createTestManifest({
        id: 'file-manager',
        actions: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            },
            returns: { type: 'object' },
            riskLevel: 'low',
          },
        ],
      });

      const registry = createMockRegistry({
        'email-gmail': emailManifest,
        'file-manager': fileManifest,
      });

      const plan = createTestPlan({
        steps: [
          {
            id: 'step-1',
            gear: 'file-manager',
            action: 'read_file',
            parameters: { path: '/tmp/data.txt' },
            riskLevel: 'low',
          },
          {
            id: 'step-2',
            gear: 'email-gmail',
            action: 'send_email',
            parameters: {
              to: 'user@example.com',
              subject: 'Data',
              body: 'See attached',
            },
            riskLevel: 'medium',
            dependsOn: ['step-1'],
          },
        ],
      });

      const result = validatePlan(plan, registry);
      expect(isOk(result)).toBe(true);
    });
  });
});
