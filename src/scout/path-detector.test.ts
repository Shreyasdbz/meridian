// @meridian/scout — path-detector tests (Phase 3.3)

import { describe, it, expect } from 'vitest';

import {
  detectPath,
  detectAndVerifyPath,
  verifyFastPath,
  tryParseExecutionPlan,
} from './path-detector.js';
import type { FastPathVerificationContext } from './path-detector.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validPlanJson = JSON.stringify({
  id: 'plan-001',
  jobId: 'job-001',
  steps: [
    {
      id: 'step-001',
      gear: 'file-manager',
      action: 'read',
      parameters: { path: '/tmp/test.txt' },
      riskLevel: 'low',
    },
  ],
  reasoning: 'Reading a file as requested',
});

const validPlanWithMultipleSteps = JSON.stringify({
  id: 'plan-002',
  jobId: 'job-002',
  steps: [
    {
      id: 'step-001',
      gear: 'web-search',
      action: 'search',
      parameters: { query: 'TypeScript best practices' },
      riskLevel: 'low',
    },
    {
      id: 'step-002',
      gear: 'file-manager',
      action: 'write',
      parameters: { path: '/tmp/output.txt', content: 'results' },
      riskLevel: 'medium',
      dependsOn: ['step-001'],
    },
  ],
  journalSkip: true,
});

const defaultVerificationContext: FastPathVerificationContext = {
  registeredGearNames: ['file-manager', 'web-search', 'shell-executor'],
  registeredActionNames: ['read', 'write', 'search', 'execute'],
};

// ---------------------------------------------------------------------------
// tryParseExecutionPlan
// ---------------------------------------------------------------------------

describe('tryParseExecutionPlan', () => {
  it('should parse a valid ExecutionPlan JSON', () => {
    const plan = tryParseExecutionPlan(validPlanJson);
    expect(plan).toBeDefined();
    expect(plan?.id).toBe('plan-001');
    expect(plan?.jobId).toBe('job-001');
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]?.gear).toBe('file-manager');
  });

  it('should parse a plan with multiple steps', () => {
    const plan = tryParseExecutionPlan(validPlanWithMultipleSteps);
    expect(plan).toBeDefined();
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.journalSkip).toBe(true);
  });

  it('should return undefined for plain text', () => {
    expect(tryParseExecutionPlan('Hello, how can I help you?')).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(tryParseExecutionPlan('')).toBeUndefined();
  });

  it('should return undefined for JSON missing required fields', () => {
    const missingSteps = JSON.stringify({ id: 'plan-001', jobId: 'job-001' });
    expect(tryParseExecutionPlan(missingSteps)).toBeUndefined();
  });

  it('should return undefined for JSON with invalid step fields', () => {
    const badStep = JSON.stringify({
      id: 'plan-001',
      jobId: 'job-001',
      steps: [{ id: 'step-001' }], // missing gear, action, parameters, riskLevel
    });
    expect(tryParseExecutionPlan(badStep)).toBeUndefined();
  });

  it('should return undefined for an array', () => {
    expect(tryParseExecutionPlan('[1, 2, 3]')).toBeUndefined();
  });

  it('should return undefined for invalid JSON', () => {
    expect(tryParseExecutionPlan('{ invalid json')).toBeUndefined();
  });

  it('should handle whitespace around valid JSON', () => {
    const padded = `  \n  ${validPlanJson}  \n  `;
    const plan = tryParseExecutionPlan(padded);
    expect(plan).toBeDefined();
    expect(plan?.id).toBe('plan-001');
  });

  it('should return undefined for JSON with null steps', () => {
    const nullSteps = JSON.stringify({ id: 'p', jobId: 'j', steps: null });
    expect(tryParseExecutionPlan(nullSteps)).toBeUndefined();
  });

  it('should return undefined for JSON with non-object parameters', () => {
    const badParams = JSON.stringify({
      id: 'p',
      jobId: 'j',
      steps: [
        { id: 's', gear: 'g', action: 'a', parameters: 'not-an-object', riskLevel: 'low' },
      ],
    });
    expect(tryParseExecutionPlan(badParams)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectPath
// ---------------------------------------------------------------------------

describe('detectPath', () => {
  it('should classify valid plan JSON as full path', () => {
    const result = detectPath(validPlanJson);
    expect(result.path).toBe('full');
    expect(result.plan).toBeDefined();
    expect(result.plan?.id).toBe('plan-001');
    expect(result.text).toBeUndefined();
  });

  it('should classify plain text as fast path', () => {
    const result = detectPath('The weather is 72°F and sunny today.');
    expect(result.path).toBe('fast');
    expect(result.text).toBe('The weather is 72°F and sunny today.');
    expect(result.plan).toBeUndefined();
  });

  it('should classify empty string as fast path', () => {
    const result = detectPath('');
    expect(result.path).toBe('fast');
  });

  it('should classify malformed JSON as fast path', () => {
    const result = detectPath('{ this is not valid json }');
    expect(result.path).toBe('fast');
  });
});

// ---------------------------------------------------------------------------
// verifyFastPath
// ---------------------------------------------------------------------------

describe('verifyFastPath', () => {
  it('should pass for normal conversational text', () => {
    const result = verifyFastPath(
      'Quantum computing uses quantum bits (qubits) which can be in superposition states.',
      defaultVerificationContext,
    );
    expect(result).toBeNull();
  });

  it('should fail when response contains JSON resembling a plan', () => {
    const text = 'Here is what I found: {"id": "plan-1", "steps": []}';
    const result = verifyFastPath(text, defaultVerificationContext);
    expect(result).toContain('JSON structures resembling an execution plan');
  });

  it('should fail when response contains step-like JSON', () => {
    const text = 'I structured it as: {"gear": "file-manager", "action": "read"}';
    const result = verifyFastPath(text, defaultVerificationContext);
    expect(result).toContain('JSON structures resembling an execution plan');
  });

  it('should fail when response references registered Gear names', () => {
    const text = 'I used the file-manager to read the file for you.';
    const result = verifyFastPath(text, defaultVerificationContext);
    expect(result).toContain('registered Gear name: "file-manager"');
  });

  it('should fail when response references registered action names', () => {
    const text = 'I will execute the command right away.';
    const result = verifyFastPath(text, defaultVerificationContext);
    expect(result).toContain('registered action: "execute"');
  });

  it('should fail for deferred-action language: "I\'ve gone ahead and"', () => {
    const result = verifyFastPath(
      "I've gone ahead and created the project for you.",
      defaultVerificationContext,
    );
    expect(result).toContain('deferred-action language');
  });

  it('should fail for deferred-action language: "Done! I created"', () => {
    const result = verifyFastPath(
      'Done! I created the configuration file.',
      defaultVerificationContext,
    );
    expect(result).toContain('deferred-action language');
  });

  it('should fail for deferred-action language: "I\'ve already set up"', () => {
    const result = verifyFastPath(
      "I've already set up the database for you.",
      defaultVerificationContext,
    );
    expect(result).toContain('deferred-action language');
  });

  it('should fail for deferred-action language: "Successfully created"', () => {
    const result = verifyFastPath(
      'Successfully created the new repository.',
      defaultVerificationContext,
    );
    expect(result).toContain('deferred-action language');
  });

  it('should fail for "The file has been created"', () => {
    const result = verifyFastPath(
      'The file has been created at /tmp/output.txt.',
      defaultVerificationContext,
    );
    expect(result).toContain('deferred-action language');
  });

  it('should pass for text that discusses actions hypothetically', () => {
    const result = verifyFastPath(
      'To create a file, you would need to use a file management tool.',
      { registeredGearNames: [], registeredActionNames: [] },
    );
    expect(result).toBeNull();
  });

  it('should not flag partial matches of Gear names', () => {
    const context: FastPathVerificationContext = {
      registeredGearNames: ['file-manager'],
      registeredActionNames: [],
    };
    // "filed" contains "file" but shouldn't match "file-manager"
    const result = verifyFastPath('I filed the report yesterday.', context);
    expect(result).toBeNull();
  });

  it('should handle empty verification context', () => {
    const context: FastPathVerificationContext = {
      registeredGearNames: [],
      registeredActionNames: [],
    };
    const result = verifyFastPath(
      'This is a normal response without any issues.',
      context,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectAndVerifyPath
// ---------------------------------------------------------------------------

describe('detectAndVerifyPath', () => {
  it('should return full path for valid plan JSON', () => {
    const result = detectAndVerifyPath(validPlanJson, defaultVerificationContext);
    expect(result.path).toBe('full');
    expect(result.plan).toBeDefined();
    expect(result.verificationFailure).toBeUndefined();
  });

  it('should return fast path for clean conversational text', () => {
    const result = detectAndVerifyPath(
      'The capital of France is Paris.',
      { registeredGearNames: [], registeredActionNames: [] },
    );
    expect(result.path).toBe('fast');
    expect(result.text).toBe('The capital of France is Paris.');
    expect(result.verificationFailure).toBeUndefined();
  });

  it('should flag fast-path verification failure for action-like text', () => {
    const result = detectAndVerifyPath(
      "I've gone ahead and configured everything for you.",
      defaultVerificationContext,
    );
    expect(result.path).toBe('fast');
    expect(result.verificationFailure).toBeDefined();
    expect(result.verificationFailure).toContain('deferred-action language');
  });

  it('should extract embedded plan JSON from text response as full path', () => {
    const text = 'Here is the plan: {"id": "p1", "jobId": "j1", "steps": []}';
    const result = detectAndVerifyPath(text, defaultVerificationContext);
    // tryParseExecutionPlan now extracts embedded JSON and classifies as full path
    expect(result.path).toBe('full');
    expect(result.plan).toBeDefined();
    expect(result.plan?.id).toBe('p1');
  });
});
