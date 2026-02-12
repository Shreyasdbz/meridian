// Phase 3.5 Integration Test — Scout ↔ Axis
//
// Tests that Scout registers with Axis as a message handler and correctly
// handles plan.request messages dispatched through the message router.
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.2 (Scout — Planner LLM)
// - Section 4.3 (Fast-Path vs Full-Path)

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { Axis, JobProcessor } from '@meridian/axis';
import { createAxis } from '@meridian/axis';
import { createScout } from '@meridian/scout';
import type { Scout } from '@meridian/scout';
import {
  DatabaseClient,
  generateId,
  getDefaultConfig,
  migrate,
} from '@meridian/shared';
import type {
  AxisMessage,
  ChatChunk,
  ChatRequest,
  ExecutionPlan,
  LLMProvider,
  MeridianConfig,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Mock LLM provider
// ---------------------------------------------------------------------------

function createMockProvider(response: string): LLMProvider {
  return {
    id: 'mock:test-model',
    name: 'mock',
    maxContextTokens: 100_000,
    // eslint-disable-next-line @typescript-eslint/require-await
    chat: async function* (_request: ChatRequest): AsyncIterable<ChatChunk> {
      yield { content: response, done: false };
      yield { content: '', done: true, usage: { inputTokens: 100, outputTokens: 50 } };
    },
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-scout-axis');
const PROJECT_ROOT = process.cwd();

let db: DatabaseClient;
let dataDir: string;
let axis: Axis | undefined;
let scout: Scout | undefined;

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

function buildPlanRequest(
  userMessage: string,
  jobId?: string,
  extra?: Record<string, unknown>,
): AxisMessage {
  const id = generateId();
  const jid = jobId ?? generateId();
  return {
    id,
    correlationId: id,
    timestamp: new Date().toISOString(),
    from: 'bridge',
    to: 'scout',
    type: 'plan.request',
    jobId: jid,
    payload: {
      userMessage,
      jobId: jid,
      ...extra,
    },
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
  if (scout) {
    try {
      scout.dispose();
    } catch {
      // Best-effort
    }
    scout = undefined;
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

describe('Scout ↔ Axis integration', () => {
  describe('registration', () => {
    it('should register Scout as a message handler with Axis', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Hello!');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      expect(axis.internals.registry.has('scout')).toBe(true);
    });

    it('should unregister Scout on dispose', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Hello!');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      expect(axis.internals.registry.has('scout')).toBe(true);

      scout.dispose();
      scout = undefined; // prevent double-dispose in afterEach

      expect(axis.internals.registry.has('scout')).toBe(false);
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

      const provider = createMockProvider('Hello!');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      scout.dispose();
      // Second dispose should not throw
      const s = scout;
      expect(() => { s.dispose(); }).not.toThrow();
      scout = undefined;
    });
  });

  describe('plan.request → plan.response (fast path)', () => {
    it('should dispatch a plan.request and receive a fast-path plan.response', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const textResponse = 'The capital of France is Paris.';
      const provider = createMockProvider(textResponse);
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      const request = buildPlanRequest('What is the capital of France?');
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('plan.response');
      expect(response.from).toBe('scout');
      expect(response.to).toBe('bridge');
      expect(response.correlationId).toBe(request.correlationId);
      expect(response.replyTo).toBe(request.id);
      expect(response.jobId).toBe(request.jobId);

      const payload = response.payload as Record<string, unknown>;
      expect(payload['path']).toBe('fast');
      expect(payload['text']).toBe(textResponse);
    });
  });

  describe('plan.request → plan.response (full path)', () => {
    it('should dispatch a plan.request and receive a full-path plan.response', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const plan: ExecutionPlan = {
        id: 'plan-001',
        jobId: 'job-001',
        steps: [
          {
            id: 'step-001',
            gear: 'file-manager',
            action: 'read',
            parameters: { path: '/tmp/test.txt' },
            riskLevel: 'low',
            description: 'Read the test file',
          },
        ],
        reasoning: 'Reading the requested file',
      };

      const provider = createMockProvider(JSON.stringify(plan));
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      const request = buildPlanRequest('Read /tmp/test.txt');
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('plan.response');

      const payload = response.payload as Record<string, unknown>;
      expect(payload['path']).toBe('full');

      const resultPlan = payload['plan'] as ExecutionPlan;
      expect(resultPlan).toBeDefined();
      expect(resultPlan.steps).toHaveLength(1);
      expect(resultPlan.steps[0]?.gear).toBe('file-manager');
    });
  });

  describe('fast-path verification failure', () => {
    it('should set requiresReroute when fast-path verification detects deferred-action language', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const deferredText = "I've gone ahead and created the file for you.";
      const provider = createMockProvider(deferredText);
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      const request = buildPlanRequest('Create a file');
      const response = await axis.internals.router.dispatch(request);

      expect(response.type).toBe('plan.response');

      const payload = response.payload as Record<string, unknown>;
      expect(payload['path']).toBe('fast');
      expect(payload['requiresReroute']).toBe(true);
      expect(payload['rerouteReason']).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return an error response for non-plan.request message types', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Response');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      const wrongTypeMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: 'scout',
        type: 'status.update', // Wrong type
        payload: { userMessage: 'Hello' },
      };

      // The router's error middleware wraps the ValidationError
      const response = await axis.internals.router.dispatch(wrongTypeMessage);
      expect(response.type).toBe('error');
    });

    it('should return an error response when userMessage is missing', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Response');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      const noUserMessage: AxisMessage = {
        id: generateId(),
        correlationId: generateId(),
        timestamp: new Date().toISOString(),
        from: 'bridge',
        to: 'scout',
        type: 'plan.request',
        payload: {}, // Missing userMessage
      };

      const response = await axis.internals.router.dispatch(noUserMessage);
      expect(response.type).toBe('error');
    });

    it('should return error type for budget exceeded', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Response');
      scout = createScout(
        { provider, primaryModel: 'test-model', jobTokenBudget: 1000 },
        { registry: axis.internals.registry },
      );

      const request = buildPlanRequest('Do something', undefined, {
        cumulativeTokens: 2000,
      });

      const response = await axis.internals.router.dispatch(request);
      expect(response.type).toBe('error');

      const payload = response.payload as Record<string, unknown>;
      expect(payload['type']).toBe('budget_exceeded');
    });
  });

  describe('model configuration', () => {
    it('should expose the primary model', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Hello!');
      scout = createScout(
        {
          provider,
          primaryModel: 'claude-sonnet-4-5-20250929',
          secondaryModel: 'claude-haiku-4-5-20251001',
        },
        { registry: axis.internals.registry },
      );

      expect(scout.getPrimaryModel()).toBe('claude-sonnet-4-5-20250929');
    });

    it('should expose the secondary model (reserved for v0.4)', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Hello!');
      scout = createScout(
        {
          provider,
          primaryModel: 'claude-sonnet-4-5-20250929',
          secondaryModel: 'claude-haiku-4-5-20251001',
        },
        { registry: axis.internals.registry },
      );

      expect(scout.getSecondaryModel()).toBe('claude-haiku-4-5-20251001');
    });

    it('should return undefined for secondary model when not configured', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Hello!');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      expect(scout.getSecondaryModel()).toBeUndefined();
    });

    it('should expose the prompt template version', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      const provider = createMockProvider('Hello!');
      scout = createScout(
        { provider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      expect(scout.getPromptVersion()).toBe('1.0.0');
    });
  });

  describe('message flow with conversation context', () => {
    it('should pass conversation history through to the planner', async () => {
      axis = createAxis({
        db,
        config: makeConfig(),
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      let capturedMessages: Array<{ role: string; content: string }> = [];
      const capturingProvider: LLMProvider = {
        id: 'mock:capture',
        name: 'mock',
        maxContextTokens: 100_000,
        // eslint-disable-next-line @typescript-eslint/require-await
        chat: async function* (request: ChatRequest): AsyncIterable<ChatChunk> {
          capturedMessages = request.messages;
          yield { content: 'Response text', done: false };
          yield { content: '', done: true, usage: { inputTokens: 50, outputTokens: 20 } };
        },
        estimateTokens: (text: string) => Math.ceil(text.length / 4),
      };

      scout = createScout(
        { provider: capturingProvider, primaryModel: 'test-model' },
        { registry: axis.internals.registry },
      );

      const request = buildPlanRequest('Follow up question', undefined, {
        conversationHistory: [
          { id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'First message' },
          { id: 'msg-2', conversationId: 'conv-1', role: 'assistant', content: 'First response' },
        ],
      });

      await axis.internals.router.dispatch(request);

      // Verify conversation history was passed to the LLM
      const contents = capturedMessages.map((m) => m.content);
      expect(contents).toContain('First message');
      expect(contents).toContain('First response');
      expect(contents).toContain('Follow up question');
    });
  });
});
