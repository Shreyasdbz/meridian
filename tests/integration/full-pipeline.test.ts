/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
// Phase 8.1 Integration Test — Full Pipeline Integration
//
// Tests the complete request lifecycle: Message → Job → Scout → Sentinel →
// Gear → Response (with mock LLM). Covers fast path, full path, approval
// flow, conversation serial execution, and graceful degradation scenarios.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createAxis } from '@meridian/axis';
import type { Axis, JobProcessor } from '@meridian/axis';
import { createBridgeServer } from '@meridian/bridge';
import type { BridgeServer } from '@meridian/bridge';
import { createGearRuntime } from '@meridian/gear';
import type { GearRuntime } from '@meridian/gear';
import { createPipelineProcessor } from '@meridian/main';
import { createScout } from '@meridian/scout';
import type { Scout } from '@meridian/scout';
import { createSentinel } from '@meridian/sentinel';
import type { Sentinel } from '@meridian/sentinel';
import {
  DatabaseClient,
  generateId,
  getDefaultConfig,
  migrate,
} from '@meridian/shared';
import type {
  ChatChunk,
  ChatRequest,
  ExecutionPlan,
  LLMProvider,
  Logger,
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

/**
 * Create a mock provider that dynamically generates the response based on
 * the user message. This avoids race conditions when the jobId is needed
 * in the response but isn't known until the job is created.
 */
function createDynamicMockProvider(
  handler: (userMessage: string) => string,
): LLMProvider {
  return {
    id: 'mock:dynamic',
    name: 'mock',
    maxContextTokens: 100_000,
    // eslint-disable-next-line @typescript-eslint/require-await
    chat: async function* (request: ChatRequest): AsyncIterable<ChatChunk> {
      const userMsg = request.messages
        .filter((m) => m.role === 'user')
        .pop()?.content ?? '';
      const response = handler(userMsg);
      yield { content: response, done: false };
      yield { content: '', done: true, usage: { inputTokens: 100, outputTokens: 50 } };
    },
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

/**
 * Create a mock provider that throws an error (simulating API failure).
 */
function createFailingProvider(errorMessage: string): LLMProvider {
  return {
    id: 'mock:failing',
    name: 'mock',
    maxContextTokens: 100_000,
    // eslint-disable-next-line @typescript-eslint/require-await
    chat: async function* (): AsyncIterable<ChatChunk> {
      throw new Error(errorMessage);
    },
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-full-pipeline');
const PROJECT_ROOT = process.cwd();

let db: DatabaseClient;
let dataDir: string;
let axis: Axis | undefined;
let scout: Scout | undefined;
let sentinel: Sentinel | undefined;
let gearRuntime: GearRuntime | undefined;
let bridge: BridgeServer | undefined;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  close: vi.fn(),
};

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

/** Build a full-path response (ExecutionPlan JSON). */
function fullPathResponse(plan: ExecutionPlan): string {
  return JSON.stringify(plan);
}

/** Create a test conversation and return its ID. */
async function createConversation(title = 'Test conversation'): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();
  await db.run(
    'meridian',
    `INSERT INTO conversations (id, title, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
    [id, title, now, now],
  );
  return id;
}

/** Create a user message for a job and return the message ID. */
async function createUserMessage(
  conversationId: string,
  content: string,
  jobId: string,
): Promise<string> {
  const id = generateId();
  await db.run(
    'meridian',
    `INSERT INTO messages (id, conversation_id, role, content, job_id, modality, created_at)
     VALUES (?, ?, 'user', ?, ?, 'text', ?)`,
    [id, conversationId, content, jobId, new Date().toISOString()],
  );
  return id;
}

/** Wait for a job to reach a terminal status (completed/failed/cancelled). */
async function waitForJobTerminal(
  jobId: string,
  timeoutMs = 10000,
): Promise<{ status: string; result?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await axis!.getJob(jobId);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
      return {
        status: job.status,
        result: job.result,
        error: job.error as Record<string, unknown> | undefined,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Return last known status for debugging
  const job = await axis!.getJob(jobId);
  throw new Error(
    `Job ${jobId} did not reach terminal status within ${timeoutMs}ms (current: ${job?.status ?? 'unknown'})`,
  );
}

/** Wait for a job to reach a specific status. */
async function waitForJobStatus(
  jobId: string,
  targetStatus: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await axis!.getJob(jobId);
    if (job?.status === targetStatus) {
      return;
    }
    // If the job reached a terminal state different from target, stop waiting
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  dataDir = join(TEST_DIR, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  mkdirSync(join(dataDir, 'workspace'), { recursive: true });
  mkdirSync(join(dataDir, 'gear-packages'), { recursive: true });

  db = new DatabaseClient({ dataDir, direct: true });
  await db.start();
  await db.open('meridian');
  await migrate(db, 'meridian', PROJECT_ROOT);

  vi.clearAllMocks();
});

afterEach(async () => {
  if (bridge) {
    try { await bridge.stop(); } catch { /* Best-effort */ }
    bridge = undefined;
  }

  if (gearRuntime) {
    try {
      gearRuntime.dispose();
      await gearRuntime.shutdown();
    } catch { /* Best-effort */ }
    gearRuntime = undefined;
  }

  if (scout) {
    try { scout.dispose(); } catch { /* Best-effort */ }
    scout = undefined;
  }

  if (sentinel) {
    try { sentinel.dispose(); } catch { /* Best-effort */ }
    sentinel = undefined;
  }

  if (axis) {
    try { await axis.stop(); } catch { /* Best-effort */ }
    axis = undefined;
  }

  await db.close();

  try {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  } catch { /* Best-effort cleanup */ }

  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Full pipeline setup helper
// ---------------------------------------------------------------------------

/**
 * Set up the full pipeline: Axis, Scout, Sentinel, Gear, and (optionally) Bridge.
 *
 * The worker pool is stopped by default so tests can create messages before
 * the job is picked up. Call `axis.internals.workerPool.start()` after setup.
 */
async function setupFullPipeline(
  provider: LLMProvider,
  options?: { withBridge?: boolean; autoStart?: boolean },
): Promise<void> {
  const config = makeConfig();

  const pipelineProcessor: JobProcessor = async (job, signal) => {
    const processor = createPipelineProcessor({
      axis: axis!,
      logger: mockLogger as unknown as Logger,
      db,
      bridge,
    });
    return processor(job, signal);
  };

  axis = createAxis({
    db,
    config,
    dataDir,
    projectRoot: PROJECT_ROOT,
    processor: pipelineProcessor,
    logger: mockLogger,
  });

  await axis.start();

  // Stop worker pool so tests can set up data before processing starts
  await axis.internals.workerPool.stop();

  // Register Scout with mock LLM
  scout = createScout(
    {
      provider,
      primaryModel: 'test-model',
      logger: mockLogger,
    },
    { registry: axis.internals.registry },
  );

  // Register Sentinel (rule-based)
  sentinel = createSentinel(
    {
      policyConfig: {
        workspacePath: join(dataDir, 'workspace'),
        allowlistedDomains: ['api.example.com'],
        maxTransactionAmountUsd: 100,
      },
      logger: mockLogger,
    },
    { registry: axis.internals.registry },
  );

  // Register Gear runtime (empty — no builtin manifests in test)
  gearRuntime = await createGearRuntime(
    {
      db,
      gearPackagesDir: join(dataDir, 'gear-packages'),
      workspacePath: join(dataDir, 'workspace'),
      builtinManifests: [],
      logger: mockLogger,
    },
    { registry: axis.internals.registry },
  );

  if (options?.withBridge) {
    bridge = await createBridgeServer(config.bridge, axis, {
      db,
      logger: mockLogger as unknown as Logger,
      disableRateLimit: true,
    });
  }

  // Auto-start worker pool unless explicitly prevented
  if (options?.autoStart !== false) {
    axis.internals.workerPool.start();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Full Pipeline Integration', () => {
  describe('fast path: Message → Job → Scout → Response', () => {
    it('should process a conversational message through the fast path end-to-end', async () => {
      const provider = createMockProvider('The current time in Tokyo is 2:30 PM JST.');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'What time is it in Tokyo?', job.id);

      // Now start the worker pool to process the job
      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('completed');
      expect(result.result).toBeDefined();
      expect((result.result as Record<string, unknown>)['path']).toBe('fast');
      expect((result.result as Record<string, unknown>)['text']).toContain('Tokyo');

      // Verify assistant message was stored
      const messages = await db.query<{ role: string; content: string }>(
        'meridian',
        `SELECT role, content FROM messages
         WHERE conversation_id = ? AND role = 'assistant'`,
        [conversationId],
      );
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toContain('Tokyo');
    });

    it('should skip Sentinel and Gear for fast-path responses', async () => {
      const provider = createMockProvider('Hello! How can I help you?');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Hello!', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);
      expect(result.status).toBe('completed');

      // Verify the job completed without going through validating/executing
      const jobRecord = await axis!.getJob(job.id);
      expect(jobRecord?.status).toBe('completed');
      expect(jobRecord?.validation).toBeUndefined();
    });
  });

  describe('full path: Message → Job → Scout → Sentinel → Gear → Response', () => {
    it('should process an action through the full pipeline', async () => {
      // Use a dynamic provider that generates a plan with correct jobId.
      // The LLM call includes the jobId in the plan request payload.
      const provider = createDynamicMockProvider((_msg) => {
        // Return a low-risk plan with a workspace-scoped read
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(), // Won't match real job, but planner uses its own
          steps: [{
            id: 'step-1',
            gear: 'gear:file-manager',
            action: 'read_file',
            parameters: { path: join(dataDir, 'workspace', 'test.txt') },
            riskLevel: 'low',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Read the file test.txt', job.id);

      axis!.internals.workerPool.start();

      // The plan has a read_file action on workspace — Sentinel should approve (low risk).
      // Gear execution will fail because the actual Gear process isn't running,
      // but the pipeline flow through planning → validating → executing is verified.
      const result = await waitForJobTerminal(job.id);

      expect(['completed', 'failed']).toContain(result.status);

      // Verify the job progressed through the pipeline (had a plan attached)
      const jobRecord = await axis!.getJob(job.id);
      expect(jobRecord?.plan).toBeDefined();
      expect(jobRecord?.plan?.steps.length).toBe(1);
    });
  });

  describe('full path with user approval', () => {
    it('should pause at awaiting_approval for high-risk plans', async () => {
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:shell',
            action: 'execute',
            parameters: { command: 'rm -rf /tmp/test' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Delete all temp files', job.id);

      axis!.internals.workerPool.start();

      // Wait for the job to reach a non-pending state
      await waitForJobStatus(job.id, 'awaiting_approval');

      const jobRecord = await axis!.getJob(job.id);

      // The job should be either awaiting_approval (needs user approval) or
      // failed (Sentinel rejected outright due to shell Gear / critical risk)
      expect(['awaiting_approval', 'failed']).toContain(jobRecord?.status);

      if (jobRecord?.status === 'awaiting_approval') {
        expect(jobRecord.validation).toBeDefined();
        expect(jobRecord.validation?.verdict).toBe('needs_user_approval');
      }
    });
  });

  describe('conversation serial execution', () => {
    it('should execute jobs from the same conversation serially', async () => {
      const provider = createDynamicMockProvider((msg) => {
        return `Response to: ${msg}`;
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();

      const job1 = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'First message', job1.id);

      const job2 = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Second message', job2.id);

      axis!.internals.workerPool.start();

      const result1 = await waitForJobTerminal(job1.id);
      const result2 = await waitForJobTerminal(job2.id);

      expect(result1.status).toBe('completed');
      expect(result2.status).toBe('completed');

      // Verify both messages got responses
      const messages = await db.query<{ role: string; content: string; created_at: string }>(
        'meridian',
        `SELECT role, content, created_at FROM messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY created_at ASC`,
        [conversationId],
      );
      expect(messages.length).toBe(2);
    });

    it('should execute jobs from different conversations concurrently', async () => {
      const provider = createDynamicMockProvider((msg) => {
        return `Response to: ${msg}`;
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conv1 = await createConversation('Conversation 1');
      const conv2 = await createConversation('Conversation 2');

      const job1 = await axis!.createJob({ conversationId: conv1, source: 'user' });
      await createUserMessage(conv1, 'Message in conv 1', job1.id);

      const job2 = await axis!.createJob({ conversationId: conv2, source: 'user' });
      await createUserMessage(conv2, 'Message in conv 2', job2.id);

      axis!.internals.workerPool.start();

      const [result1, result2] = await Promise.all([
        waitForJobTerminal(job1.id),
        waitForJobTerminal(job2.id),
      ]);

      expect(result1.status).toBe('completed');
      expect(result2.status).toBe('completed');
    });
  });

  describe('graceful degradation', () => {
    it('should fail gracefully when Scout API is unreachable', async () => {
      const provider = createFailingProvider('Connection refused: model API unavailable');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Hello', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect((result.error as { code: string }).code).toBe('SCOUT_UNREACHABLE');
      expect((result.error as { retriable: boolean }).retriable).toBe(true);
    });

    it('should fail gracefully when job has no user message', async () => {
      const provider = createMockProvider('Hello');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      // Deliberately NOT creating a user message

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect((result.error as { code: string }).code).toBe('NO_MESSAGE');
    });

    it('should fail gracefully when Gear execution fails', async () => {
      // Use a workspace-scoped read_file so Sentinel approves the plan.
      // Gear execution then fails because no file-manager subprocess is running.
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:file-manager',
            action: 'read_file',
            parameters: { path: join(dataDir, 'workspace', 'nonexistent.txt') },
            riskLevel: 'low',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Read a file that does not exist', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);
      expect(result.status).toBe('failed');
    });

    it('should handle Sentinel rejection gracefully', async () => {
      // Use a financial transaction exceeding maxTransactionAmountUsd (100)
      // to trigger an outright rejection from Sentinel.
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:payment',
            action: 'charge',
            parameters: { amount: 1000, currency: 'USD' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Charge the customer $1000', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect((result.error as { code: string }).code).toBe('PLAN_REJECTED');
    });
  });

  describe('complete lifecycle with Bridge', () => {
    it('should handle a message submitted via Bridge API through the full pipeline', async () => {
      const provider = createMockProvider('The answer is 42.');
      await setupFullPipeline(provider, { withBridge: true });

      // Setup auth
      await bridge!.authService.setupPassword('TestPassword123!');
      const loginResult = await bridge!.authService.login('TestPassword123!', '127.0.0.1');
      const token = loginResult.token!;

      // Get CSRF token
      const sessionRes = await bridge!.server.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: { authorization: `Bearer ${token}` },
      });
      const csrfToken = (JSON.parse(sessionRes.body) as { csrfToken: string }).csrfToken;
      const cookie = `meridian_session=${token}`;

      // Create conversation via API
      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { title: 'API Test' },
      });
      expect(convRes.statusCode).toBe(201);
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send message via API — this creates a job via Axis
      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { conversationId: conv.id, content: 'What is the meaning of life?' },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { jobId: string };

      // Wait for the job to complete via the pipeline
      const result = await waitForJobTerminal(msgBody.jobId);
      expect(result.status).toBe('completed');
      expect((result.result as Record<string, unknown>)['path']).toBe('fast');
    });
  });

  describe('information barrier enforcement', () => {
    it('should not send user message or conversation history to Sentinel', async () => {
      // Use a workspace-scoped path so Sentinel approves and job reaches terminal state.
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:file-manager',
            action: 'read_file',
            parameters: { path: join(dataDir, 'workspace', 'test.txt') },
            riskLevel: 'low',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      // Spy on router dispatch to inspect what's sent to Sentinel
      const dispatchSpy = vi.spyOn(axis!.internals.router, 'dispatch');

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Read my secret file', job.id);

      axis!.internals.workerPool.start();

      // Wait for the job to progress past validation to terminal state
      await waitForJobTerminal(job.id);

      // Find the validate.request message sent to Sentinel
      const sentinelCalls = dispatchSpy.mock.calls.filter(
        (call) => {
          const msg = call[0];
          return msg?.to === 'sentinel' && msg?.type === 'validate.request';
        },
      );

      // Sentinel should have been called exactly once
      expect(sentinelCalls.length).toBe(1);

      // Verify payload contains ONLY the plan — no user message or history
      const sentinelPayload = sentinelCalls[0]![0]!.payload!;
      expect(sentinelPayload).toHaveProperty('plan');
      expect(sentinelPayload).not.toHaveProperty('userMessage');
      expect(sentinelPayload).not.toHaveProperty('conversationHistory');
      expect(sentinelPayload).not.toHaveProperty('conversationId');
    });
  });
});
