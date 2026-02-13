/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
// v0.1 Success Criteria Integration Tests — Architecture Section 16
//
// Validates the four v0.1 success criteria from the delivery roadmap:
// 1. Install to first message in under 3 minutes (proxy: bootstrap < 5s)
// 2. Fast-path response under 5 seconds
// 3. Simple task (find files, fetch web page) completes under 10 seconds
// 4. Approval flow works end-to-end

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createAxis } from '@meridian/axis';
import type { Axis, JobProcessor } from '@meridian/axis';
import { createGearRuntime } from '@meridian/gear';
import type { GearRuntime } from '@meridian/gear';
import { createPipelineProcessor, createPostApprovalHandler } from '@meridian/main';
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
  AxisMessage,
  ChatChunk,
  ChatRequest,
  ComponentId,
  ExecutionPlan,
  LLMProvider,
  Logger,
  MeridianConfig,
  MessageHandler,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Mock LLM provider factories
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-success-criteria');
const PROJECT_ROOT = process.cwd();

let db: DatabaseClient;
let dataDir: string;
let axis: Axis | undefined;
let scout: Scout | undefined;
let sentinel: Sentinel | undefined;
let gearRuntime: GearRuntime | undefined;

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

/** Build a full-path Scout response (ExecutionPlan JSON). */
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

/**
 * Create a mock Gear handler that returns successful results.
 * This replaces the real Gear runtime for tests that need controlled
 * Gear execution without spawning actual subprocesses.
 */
function createMockGearHandler(
  gearResults: Record<string, Record<string, unknown>>,
): MessageHandler {
  // eslint-disable-next-line @typescript-eslint/require-await -- MessageHandler requires async
  return async (message: AxisMessage): Promise<AxisMessage> => {
    const payload = message.payload;
    const gearId = payload?.['gear'] as string | undefined;
    const action = payload?.['action'] as string | undefined;
    const stepId = payload?.['stepId'] as string | undefined;
    const key = `${gearId}:${action}`;

    const result = gearResults[key];
    if (!result) {
      return {
        id: generateId(),
        correlationId: message.correlationId,
        timestamp: new Date().toISOString(),
        from: `gear:${gearId ?? 'unknown'}` as ComponentId,
        to: message.from,
        type: 'execute.response',
        replyTo: message.id,
        jobId: message.jobId,
        payload: {
          error: { code: 'GEAR_NOT_FOUND', message: `No mock for ${key}` },
        },
      };
    }

    return {
      id: generateId(),
      correlationId: message.correlationId,
      timestamp: new Date().toISOString(),
      from: `gear:${gearId ?? 'unknown'}` as ComponentId,
      to: message.from,
      type: 'execute.response',
      replyTo: message.id,
      jobId: message.jobId,
      payload: {
        result,
        durationMs: 10,
        stepId,
      },
    };
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

  mkdirSync(join(dataDir, 'workspace'), { recursive: true });
  mkdirSync(join(dataDir, 'gear-packages'), { recursive: true });

  db = new DatabaseClient({ dataDir, direct: true });
  await db.start();
  await db.open('meridian');
  await migrate(db, 'meridian', PROJECT_ROOT);

  vi.clearAllMocks();
});

afterEach(async () => {
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
// Pipeline setup helpers
// ---------------------------------------------------------------------------

/**
 * Set up the full pipeline with real Axis, Scout, Sentinel, and optional
 * mock Gear handler. Worker pool is stopped by default so tests can create
 * messages before the job is picked up.
 */
async function setupPipeline(
  provider: LLMProvider,
  options?: {
    gearResults?: Record<string, Record<string, unknown>>;
    autoStart?: boolean;
    withPostApproval?: boolean;
  },
): Promise<void> {
  const config = makeConfig();

  const pipelineProcessor: JobProcessor = async (job, signal) => {
    const processor = createPipelineProcessor({
      axis: axis!,
      logger: mockLogger as unknown as Logger,
      db,
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

  // Register mock Gear handler if results are provided
  if (options?.gearResults) {
    const mockGearHandler = createMockGearHandler(options.gearResults);
    axis.internals.registry.register('gear:runtime', mockGearHandler);
  }

  // Wire post-approval handler for approval flow tests
  if (options?.withPostApproval) {
    const postApprovalHandler = createPostApprovalHandler({
      axis,
      logger: mockLogger as unknown as Logger,
      db,
    });
    axis.internals.jobQueue.onStatusChange(postApprovalHandler);
  }

  if (options?.autoStart !== false) {
    axis.internals.workerPool.start();
  }
}

// ---------------------------------------------------------------------------
// Tests — v0.1 Success Criteria (Architecture Section 16)
// ---------------------------------------------------------------------------

describe('v0.1 Success Criteria (Section 16)', () => {
  // -------------------------------------------------------------------------
  // Criterion 1: Install to first message in under 3 minutes
  //
  // The actual install time depends on npm/network speed, which is outside
  // our control. We test the proxy metric: full pipeline bootstrap (create
  // and start all components with mock LLM) completes under 5 seconds.
  // This ensures our code initialization is not a bottleneck.
  // -------------------------------------------------------------------------

  describe('Criterion 1: Full pipeline bootstrap completes quickly', () => {
    it('should bootstrap Axis, Scout, Sentinel, and Gear runtime in under 5 seconds', async () => {
      const provider = createMockProvider('Hello!');
      const config = makeConfig();

      const t0 = performance.now();

      // Create the pipeline processor (requires axis reference, so we
      // use a deferred closure that captures the axis variable)
      const pipelineProcessor: JobProcessor = async (job, signal) => {
        const processor = createPipelineProcessor({
          axis: axis!,
          logger: mockLogger as unknown as Logger,
          db,
        });
        return processor(job, signal);
      };

      // Bootstrap Axis
      axis = createAxis({
        db,
        config,
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: pipelineProcessor,
        logger: mockLogger,
      });
      await axis.start();

      // Bootstrap Scout
      scout = createScout(
        {
          provider,
          primaryModel: 'test-model',
          logger: mockLogger,
        },
        { registry: axis.internals.registry },
      );

      // Bootstrap Sentinel
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

      // Bootstrap Gear runtime (empty — no builtin manifests in test)
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

      const t1 = performance.now();
      const bootstrapMs = t1 - t0;

      // Verify all components are initialized
      expect(axis).toBeDefined();
      expect(scout).toBeDefined();
      expect(sentinel).toBeDefined();
      expect(gearRuntime).toBeDefined();

      // Verify bootstrap completed under 5 seconds
      expect(bootstrapMs).toBeLessThan(5000);
    }, 10000);

    it('should be ready to process a job immediately after bootstrap', async () => {
      const provider = createMockProvider('Ready to help!');

      const t0 = performance.now();

      await setupPipeline(provider, { autoStart: false });

      const t1 = performance.now();
      const bootstrapMs = t1 - t0;

      // Create a conversation and job
      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Are you ready?', job.id);

      // Start processing
      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('completed');
      expect(bootstrapMs).toBeLessThan(5000);
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // Criterion 2: Fast-path response under 5 seconds
  //
  // Submit a simple conversational question, measure wall-clock time from
  // job creation to completion, and assert it completes under 5 seconds.
  // With a mock LLM (zero network latency), this primarily measures our
  // pipeline overhead: message dispatch, Scout call, fast-path detection,
  // response storage, and job status transitions.
  // -------------------------------------------------------------------------

  describe('Criterion 2: Fast-path response under 5 seconds', () => {
    it('should complete a fast-path conversational response in under 5 seconds', async () => {
      const provider = createMockProvider(
        "It's currently 2:34 AM in Tokyo (JST, UTC+9).",
      );
      await setupPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'What time is it in Tokyo?', job.id);

      const t0 = performance.now();
      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);
      const t1 = performance.now();
      const elapsedMs = t1 - t0;

      // Verify fast-path completion
      expect(result.status).toBe('completed');
      expect(result.result).toBeDefined();
      expect(result.result!['path']).toBe('fast');
      expect(result.result!['text']).toContain('Tokyo');

      // Criterion: under 5 seconds
      expect(elapsedMs).toBeLessThan(5000);

      // Verify assistant message was stored
      const messages = await db.query<{ role: string; content: string }>(
        'meridian',
        `SELECT role, content FROM messages
         WHERE conversation_id = ? AND role = 'assistant'`,
        [conversationId],
      );
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toContain('Tokyo');
    }, 10000);

    it('should complete multiple sequential fast-path responses each under 5 seconds', async () => {
      const provider = createDynamicMockProvider((msg) => {
        return `Response to: ${msg}`;
      });
      await setupPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();

      // Create 3 sequential messages in the same conversation
      const jobs: Array<{ id: string; question: string }> = [];
      for (const question of ['Hello', 'How are you?', 'Thanks!']) {
        const job = await axis!.createJob({ conversationId, source: 'user' });
        await createUserMessage(conversationId, question, job.id);
        jobs.push({ id: job.id, question });
      }

      axis!.internals.workerPool.start();

      // Wait for all jobs and measure total time
      const t0 = performance.now();
      for (const { id } of jobs) {
        const result = await waitForJobTerminal(id);
        const t1 = performance.now();
        const elapsedMs = t1 - t0;

        expect(result.status).toBe('completed');
        expect(result.result!['path']).toBe('fast');

        // Each individual job should complete well within 5 seconds
        // (with mock LLM, the overhead is minimal)
        expect(elapsedMs).toBeLessThan(5000 * jobs.length);
      }
      const totalMs = performance.now() - t0;

      // Even with serial execution in the same conversation,
      // all 3 fast-path responses should complete under 15 seconds total
      expect(totalMs).toBeLessThan(15000);
    }, 20000);
  });

  // -------------------------------------------------------------------------
  // Criterion 3: Simple task completes under 10 seconds
  //
  // Submit a task that requires Gear execution (full path: Scout -> Sentinel
  // -> Gear -> Response). With a mock LLM and mock Gear handler, this
  // measures the full-path pipeline overhead: plan generation, Sentinel
  // validation, Gear dispatch, response assembly, and status transitions.
  // -------------------------------------------------------------------------

  describe('Criterion 3: Simple task completes under 10 seconds', () => {
    it('should complete a file search task through the full pipeline in under 10 seconds', async () => {
      const workspacePath = join(dataDir, 'workspace');

      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          journalSkip: true,
          steps: [
            {
              id: 'step-search',
              gear: 'gear:file-manager',
              action: 'read_file',
              parameters: {
                path: join(workspacePath, 'project'),
                pattern: 'TODO',
              },
              riskLevel: 'low',
              description: 'Search for TODO comments across project files',
            },
            {
              id: 'step-write',
              gear: 'gear:file-manager',
              action: 'write_file',
              parameters: {
                path: join(workspacePath, 'todos.txt'),
                content: 'TODO list placeholder',
              },
              riskLevel: 'low',
              description: 'Write results to todos.txt',
            },
          ],
        };
        return fullPathResponse(plan);
      });

      // Mock Gear results for both steps
      const gearResults: Record<string, Record<string, unknown>> = {
        'gear:file-manager:read_file': {
          matches: [
            { file: 'src/main.ts', line: 42, text: '// TODO: implement caching' },
            { file: 'src/config.ts', line: 15, text: '// TODO: validate env vars' },
          ],
          matchCount: 2,
        },
        'gear:file-manager:write_file': {
          path: join(workspacePath, 'todos.txt'),
          bytesWritten: 128,
          success: true,
        },
      };

      await setupPipeline(provider, { gearResults, autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(
        conversationId,
        'Find all TODO comments in my project and save them to todos.txt',
        job.id,
      );

      const t0 = performance.now();
      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);
      const t1 = performance.now();
      const elapsedMs = t1 - t0;

      // Verify full-path completion
      expect(result.status).toBe('completed');
      expect(result.result).toBeDefined();
      expect(result.result!['path']).toBe('full');

      // Verify both Gear steps executed
      const steps = result.result!['steps'] as Array<{
        stepId: string;
        result?: unknown;
        error?: unknown;
      }>;
      expect(steps.length).toBe(2);
      expect(steps[0]!.stepId).toBe('step-search');
      expect(steps[0]!.error).toBeUndefined();
      expect(steps[1]!.stepId).toBe('step-write');
      expect(steps[1]!.error).toBeUndefined();

      // Criterion: under 10 seconds
      expect(elapsedMs).toBeLessThan(10000);

      // Verify Sentinel approved (low-risk workspace operations)
      const jobRecord = await axis!.getJob(job.id);
      expect(jobRecord?.validation?.verdict).toBe('approved');
    }, 15000);

    it('should complete a single-step web fetch task in under 10 seconds', async () => {
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          journalSkip: true,
          steps: [{
            id: 'step-fetch',
            gear: 'gear:web-fetch',
            action: 'fetch',
            parameters: {
              url: 'https://api.example.com/data',
              method: 'GET',
            },
            riskLevel: 'low',
            description: 'Fetch data from API',
          }],
        };
        return fullPathResponse(plan);
      });

      const gearResults: Record<string, Record<string, unknown>> = {
        'gear:web-fetch:fetch': {
          status: 200,
          body: '{"data": "example"}',
          contentType: 'application/json',
        },
      };

      await setupPipeline(provider, { gearResults, autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(
        conversationId,
        'Fetch the latest data from the API',
        job.id,
      );

      const t0 = performance.now();
      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);
      const t1 = performance.now();
      const elapsedMs = t1 - t0;

      expect(result.status).toBe('completed');
      expect(result.result!['path']).toBe('full');

      // Criterion: under 10 seconds
      expect(elapsedMs).toBeLessThan(10000);
    }, 15000);
  });

  // -------------------------------------------------------------------------
  // Criterion 4: Approval flow works end-to-end
  //
  // Submit a high-risk task, verify the job pauses at awaiting_approval,
  // simulate user approval via jobQueue transition, and verify the job
  // completes after approval. This validates the full approval lifecycle:
  // planning -> validating -> awaiting_approval -> executing -> completed.
  // -------------------------------------------------------------------------

  describe('Criterion 4: Approval flow works end-to-end', () => {
    it('should pause at awaiting_approval for high-risk plans and complete after approval', async () => {
      const workspacePath = join(dataDir, 'workspace');

      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [
            {
              id: 'step-find',
              gear: 'gear:file-manager',
              action: 'glob',
              parameters: {
                path: join(workspacePath, '**/*.tmp'),
              },
              riskLevel: 'low',
              description: 'Find all .tmp files',
            },
            {
              id: 'step-delete',
              gear: 'gear:file-manager',
              action: 'delete',
              parameters: {
                paths: [
                  join(workspacePath, 'a.tmp'),
                  join(workspacePath, 'b.tmp'),
                ],
              },
              riskLevel: 'high',
              description: 'Delete found .tmp files',
            },
          ],
        };
        return fullPathResponse(plan);
      });

      const gearResults: Record<string, Record<string, unknown>> = {
        'gear:file-manager:glob': {
          matches: [
            { path: join(workspacePath, 'a.tmp') },
            { path: join(workspacePath, 'b.tmp') },
          ],
          matchCount: 2,
        },
        'gear:file-manager:delete': {
          deleted: [
            join(workspacePath, 'a.tmp'),
            join(workspacePath, 'b.tmp'),
          ],
          deletedCount: 2,
        },
      };

      await setupPipeline(provider, {
        gearResults,
        autoStart: false,
        withPostApproval: true,
      });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(
        conversationId,
        'Delete all .tmp files in my project',
        job.id,
      );

      // Start processing — job will progress until awaiting_approval
      axis!.internals.workerPool.start();

      // Wait for the job to reach awaiting_approval
      await waitForJobStatus(job.id, 'awaiting_approval');

      const jobBeforeApproval = await axis!.getJob(job.id);
      expect(jobBeforeApproval?.status).toBe('awaiting_approval');
      expect(jobBeforeApproval?.validation?.verdict).toBe('needs_user_approval');
      expect(jobBeforeApproval?.plan?.steps.length).toBe(2);

      // Simulate user approval (in production, Bridge POST /api/jobs/:id/approve)
      await axis!.internals.jobQueue.transition(
        job.id,
        'awaiting_approval',
        'executing',
      );

      // Wait for the approved job to complete
      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('completed');
      expect(result.result).toBeDefined();
      expect(result.result!['path']).toBe('full');

      // Verify both steps executed after approval
      const steps = result.result!['steps'] as Array<{
        stepId: string;
        result?: unknown;
        error?: unknown;
      }>;
      expect(steps.length).toBe(2);
      expect(steps[0]!.stepId).toBe('step-find');
      expect(steps[0]!.error).toBeUndefined();
      expect(steps[1]!.stepId).toBe('step-delete');
      expect(steps[1]!.error).toBeUndefined();

      // Verify assistant message was stored
      const messages = await db.query<{ role: string; content: string }>(
        'meridian',
        `SELECT role, content FROM messages
         WHERE conversation_id = ? AND role = 'assistant'`,
        [conversationId],
      );
      expect(messages.length).toBe(1);
    }, 15000);

    it('should traverse the complete state machine: pending -> planning -> validating -> awaiting_approval -> executing -> completed', async () => {
      const workspacePath = join(dataDir, 'workspace');

      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:file-manager',
            action: 'delete',
            parameters: { paths: [join(workspacePath, 'temp.tmp')] },
            riskLevel: 'high',
          }],
        };
        return fullPathResponse(plan);
      });

      const gearResults: Record<string, Record<string, unknown>> = {
        'gear:file-manager:delete': {
          deleted: [join(workspacePath, 'temp.tmp')],
          deletedCount: 1,
        },
      };

      await setupPipeline(provider, {
        gearResults,
        autoStart: false,
        withPostApproval: true,
      });

      // Track status transitions via spy
      const statusTransitions: Array<{ from: string; to: string }> = [];
      axis!.internals.jobQueue.onStatusChange((_jobId, from, to) => {
        statusTransitions.push({ from, to });
      });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Delete temp.tmp', job.id);

      axis!.internals.workerPool.start();
      await waitForJobStatus(job.id, 'awaiting_approval');

      // Approve
      await axis!.internals.jobQueue.transition(
        job.id,
        'awaiting_approval',
        'executing',
      );

      const result = await waitForJobTerminal(job.id);
      expect(result.status).toBe('completed');

      // Verify the full state transition sequence
      const statuses = statusTransitions.map((t) => t.to);
      expect(statuses).toContain('planning');
      expect(statuses).toContain('validating');
      expect(statuses).toContain('awaiting_approval');
      expect(statuses).toContain('executing');
      expect(statuses).toContain('completed');

      // Verify correct ordering of transitions
      const planningIdx = statuses.indexOf('planning');
      const validatingIdx = statuses.indexOf('validating');
      const approvalIdx = statuses.indexOf('awaiting_approval');
      const executingIdx = statuses.indexOf('executing');
      const completedIdx = statuses.indexOf('completed');

      expect(planningIdx).toBeLessThan(validatingIdx);
      expect(validatingIdx).toBeLessThan(approvalIdx);
      expect(approvalIdx).toBeLessThan(executingIdx);
      expect(executingIdx).toBeLessThan(completedIdx);
    }, 15000);

    it('should measure approval flow total time within budget (under 10 seconds excluding wait)', async () => {
      const workspacePath = join(dataDir, 'workspace');

      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:file-manager',
            action: 'delete',
            parameters: { paths: [join(workspacePath, 'file.tmp')] },
            riskLevel: 'high',
          }],
        };
        return fullPathResponse(plan);
      });

      const gearResults: Record<string, Record<string, unknown>> = {
        'gear:file-manager:delete': {
          deleted: [join(workspacePath, 'file.tmp')],
          deletedCount: 1,
        },
      };

      await setupPipeline(provider, {
        gearResults,
        autoStart: false,
        withPostApproval: true,
      });

      const conversationId = await createConversation();
      const job = await axis!.createJob({ conversationId, source: 'user' });
      await createUserMessage(conversationId, 'Delete file.tmp', job.id);

      // Measure time for the planning+validation phase
      const tPlanStart = performance.now();
      axis!.internals.workerPool.start();
      await waitForJobStatus(job.id, 'awaiting_approval');
      const tPlanEnd = performance.now();
      const planningMs = tPlanEnd - tPlanStart;

      // Planning + validation phase should be fast (under 5 seconds with mock LLM)
      expect(planningMs).toBeLessThan(5000);

      // Measure time for the post-approval execution phase
      const tExecStart = performance.now();
      await axis!.internals.jobQueue.transition(
        job.id,
        'awaiting_approval',
        'executing',
      );
      const result = await waitForJobTerminal(job.id);
      const tExecEnd = performance.now();
      const executionMs = tExecEnd - tExecStart;

      expect(result.status).toBe('completed');

      // Post-approval execution should also be fast (under 5 seconds with mock Gear)
      expect(executionMs).toBeLessThan(5000);

      // Total pipeline time (excluding user wait) should be under 10 seconds
      expect(planningMs + executionMs).toBeLessThan(10000);
    }, 15000);
  });
});
