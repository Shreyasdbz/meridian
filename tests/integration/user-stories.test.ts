/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
// Phase 8.2 — End-to-End User Story Validation
//
// Tests the 3 user story traces from architecture Section 4.7 as acceptance
// tests. These validate the core architecture is working end-to-end.
//
// Story 1: Simple Question (Fast Path) — "What time is it in Tokyo?"
// Story 2: File Task (Full Path) — "Find all TODO comments..."
// Story 3: High-Risk Task with Approval — "Delete all .tmp files..."

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createAxis } from '@meridian/axis';
import type { Axis, JobProcessor } from '@meridian/axis';
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

const TEST_DIR = join(tmpdir(), 'meridian-test-user-stories');
const PROJECT_ROOT = process.cwd();

let db: DatabaseClient;
let dataDir: string;
let axis: Axis | undefined;
let scout: Scout | undefined;
let sentinel: Sentinel | undefined;

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
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Create a mock Gear handler that returns successful results.
 * This replaces the real Gear runtime for user story tests.
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
// Pipeline setup
// ---------------------------------------------------------------------------

/**
 * Set up the pipeline with mock components for user story testing.
 *
 * Unlike the Phase 8.1 test, this:
 * - Registers a mock Gear handler (instead of real GearRuntime)
 * - Wires up the post-approval handler for Story 3
 * - Keeps worker pool stopped so tests control processing timing
 */
async function setupPipeline(
  provider: LLMProvider,
  options?: {
    gearResults?: Record<string, Record<string, unknown>>;
    autoStart?: boolean;
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

  // Register mock Gear handler
  if (options?.gearResults) {
    const mockGearHandler = createMockGearHandler(options.gearResults);
    axis.internals.registry.register('gear:runtime', mockGearHandler);
  }

  // Wire post-approval handler for Story 3
  const postApprovalHandler = createPostApprovalHandler({
    axis,
    logger: mockLogger as unknown as Logger,
    db,
  });
  axis.internals.jobQueue.onStatusChange(postApprovalHandler);

  if (options?.autoStart !== false) {
    axis.internals.workerPool.start();
  }
}

// ---------------------------------------------------------------------------
// User Story 1: Simple Question (Fast Path) — Section 4.7
// ---------------------------------------------------------------------------

describe('User Story 1: Simple Question (Fast Path)', () => {
  // User: "What time is it in Tokyo?"
  //
  // Expected flow:
  // 1. Bridge receives message
  // 2. Axis creates Job (pending → planning), dispatches to Scout
  // 3. Scout returns plain text (not an ExecutionPlan)
  // 4. Axis runs fast-path verification — no JSON plan, no Gear refs
  // 5. Bridge delivers response
  //
  // No Sentinel, no Gear, no Journal. Minimal cost (one LLM call).

  it('should complete a simple question through the fast path end-to-end', async () => {
    const provider = createMockProvider(
      "It's currently 2:34 AM in Tokyo (JST, UTC+9).",
    );
    await setupPipeline(provider, { autoStart: false });

    const conversationId = await createConversation();
    const job = await axis!.createJob({ conversationId, source: 'user' });
    await createUserMessage(conversationId, 'What time is it in Tokyo?', job.id);

    const startTime = Date.now();
    axis!.internals.workerPool.start();

    const result = await waitForJobTerminal(job.id);
    const elapsedMs = Date.now() - startTime;

    // Verify fast path completion
    expect(result.status).toBe('completed');
    expect(result.result).toBeDefined();
    expect(result.result!['path']).toBe('fast');
    expect(result.result!['text']).toContain('Tokyo');
    expect(result.result!['text']).toContain('2:34 AM');

    // Verify latency budget: fast path under 5 seconds with mock LLM
    expect(elapsedMs).toBeLessThan(5000);

    // Verify assistant message was stored in the database
    const messages = await db.query<{ role: string; content: string }>(
      'meridian',
      `SELECT role, content FROM messages
       WHERE conversation_id = ? AND role = 'assistant'`,
      [conversationId],
    );
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toContain('Tokyo');
  });

  it('should NOT invoke Sentinel, Gear, or Journal', async () => {
    const provider = createMockProvider(
      "It's currently 2:34 AM in Tokyo (JST, UTC+9).",
    );
    await setupPipeline(provider, { autoStart: false });

    // Spy on router dispatch to verify no Sentinel or Gear calls
    const dispatchSpy = vi.spyOn(axis!.internals.router, 'dispatch');

    const conversationId = await createConversation();
    const job = await axis!.createJob({ conversationId, source: 'user' });
    await createUserMessage(conversationId, 'What time is it in Tokyo?', job.id);

    axis!.internals.workerPool.start();
    await waitForJobTerminal(job.id);

    // Examine all dispatched messages
    const dispatchedTypes = dispatchSpy.mock.calls.map(
      (call) => ({ to: call[0].to, type: call[0].type }),
    );

    // Should have ONE Scout call (plan.request)
    const scoutCalls = dispatchedTypes.filter((d) => d.to === 'scout');
    expect(scoutCalls.length).toBe(1);
    expect(scoutCalls[0]!.type).toBe('plan.request');

    // Should have NO Sentinel, Gear, or Journal calls
    const sentinelCalls = dispatchedTypes.filter((d) => d.to === 'sentinel');
    expect(sentinelCalls.length).toBe(0);

    const gearCalls = dispatchedTypes.filter((d) => d.to === 'gear:runtime');
    expect(gearCalls.length).toBe(0);

    const journalCalls = dispatchedTypes.filter((d) => d.to === 'journal');
    expect(journalCalls.length).toBe(0);

    // Verify job never transitioned through validating or executing
    const jobRecord = await axis!.getJob(job.id);
    expect(jobRecord?.validation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// User Story 2: File Task (Full Path) — Section 4.7
// ---------------------------------------------------------------------------

describe('User Story 2: File Task (Full Path)', () => {
  // User: "Find all TODO comments in my project and save them to todos.txt"
  //
  // Expected flow:
  // 1. Bridge receives message
  // 2. Axis creates Job, dispatches to Scout with conversation context
  // 3. Scout produces ExecutionPlan with 2 steps:
  //    (a) gear:file-search — search for TODO pattern
  //    (b) gear:file-write — write results to todos.txt
  //    Sets journalSkip: true (simple retrieval task)
  // 4. Axis detects ExecutionPlan JSON → full path. Strips user message.
  // 5. Sentinel evaluates: file search = read-only (low), file write = workspace (low). APPROVED.
  // 6. Gear executes both steps
  // 7. Journal reflection skipped (journalSkip: true)
  // 8. Bridge delivers response

  it('should process a file task through the full pipeline with 2 Gear steps', async () => {
    const workspacePath = join(dataDir, 'workspace');

    // Mock LLM: return a 2-step plan for file operations.
    // Uses action names that the risk classifier recognizes (read_file, write_file)
    // so Sentinel correctly classifies them as read_files/write_files.
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

    axis!.internals.workerPool.start();
    const result = await waitForJobTerminal(job.id);

    // Verify full path completion
    expect(result.status).toBe('completed');
    expect(result.result).toBeDefined();
    expect(result.result!['path']).toBe('full');

    // Verify both steps executed
    const steps = result.result!['steps'] as Array<{
      stepId: string;
      result?: unknown;
      error?: unknown;
    }>;
    expect(steps.length).toBe(2);
    expect(steps[0]!.stepId).toBe('step-search');
    expect(steps[0]!.result).toBeDefined();
    expect(steps[0]!.error).toBeUndefined();
    expect(steps[1]!.stepId).toBe('step-write');
    expect(steps[1]!.result).toBeDefined();
    expect(steps[1]!.error).toBeUndefined();

    // Verify the plan had 2 steps and journalSkip: true
    const jobRecord = await axis!.getJob(job.id);
    expect(jobRecord?.plan?.steps.length).toBe(2);
    expect(jobRecord?.plan?.journalSkip).toBe(true);

    // Verify Sentinel approved (not needs_user_approval)
    expect(jobRecord?.validation?.verdict).toBe('approved');

    // Verify assistant message was stored
    const messages = await db.query<{ role: string; content: string }>(
      'meridian',
      `SELECT role, content FROM messages
       WHERE conversation_id = ? AND role = 'assistant'`,
      [conversationId],
    );
    expect(messages.length).toBe(1);
  });

  it('should enforce the information barrier — Sentinel receives only the plan', async () => {
    const workspacePath = join(dataDir, 'workspace');

    const provider = createDynamicMockProvider((_msg) => {
      const plan: ExecutionPlan = {
        id: generateId(),
        jobId: generateId(),
        journalSkip: true,
        steps: [{
          id: 'step-1',
          gear: 'gear:file-manager',
          action: 'read_file',
          parameters: { path: join(workspacePath, 'project') },
          riskLevel: 'low',
        }],
      };
      return fullPathResponse(plan);
    });

    const gearResults: Record<string, Record<string, unknown>> = {
      'gear:file-manager:read_file': { matches: [], matchCount: 0 },
    };

    await setupPipeline(provider, { gearResults, autoStart: false });

    const dispatchSpy = vi.spyOn(axis!.internals.router, 'dispatch');

    const conversationId = await createConversation();
    const job = await axis!.createJob({ conversationId, source: 'user' });
    await createUserMessage(
      conversationId,
      'Find all TODO comments in my project and save them to todos.txt',
      job.id,
    );

    axis!.internals.workerPool.start();
    await waitForJobTerminal(job.id);

    // Find the validate.request sent to Sentinel
    const sentinelCalls = dispatchSpy.mock.calls.filter(
      (call) => call[0].to === 'sentinel' && call[0].type === 'validate.request',
    );
    expect(sentinelCalls.length).toBe(1);

    // Verify Sentinel payload contains ONLY the plan
    const sentinelPayload = sentinelCalls[0]![0].payload!;
    expect(sentinelPayload).toHaveProperty('plan');
    expect(sentinelPayload).not.toHaveProperty('userMessage');
    expect(sentinelPayload).not.toHaveProperty('conversationHistory');
    expect(sentinelPayload).not.toHaveProperty('conversationId');
  });

  it('should skip Journal reflection when journalSkip is true', async () => {
    const workspacePath = join(dataDir, 'workspace');

    const provider = createDynamicMockProvider((_msg) => {
      const plan: ExecutionPlan = {
        id: generateId(),
        jobId: generateId(),
        journalSkip: true,
        steps: [{
          id: 'step-1',
          gear: 'gear:file-manager',
          action: 'read_file',
          parameters: { path: join(workspacePath, 'project') },
          riskLevel: 'low',
        }],
      };
      return fullPathResponse(plan);
    });

    const gearResults: Record<string, Record<string, unknown>> = {
      'gear:file-manager:read_file': { matches: [], matchCount: 0 },
    };

    await setupPipeline(provider, { gearResults, autoStart: false });

    const dispatchSpy = vi.spyOn(axis!.internals.router, 'dispatch');

    const conversationId = await createConversation();
    const job = await axis!.createJob({ conversationId, source: 'user' });
    await createUserMessage(conversationId, 'Find TODOs and save them', job.id);

    axis!.internals.workerPool.start();
    await waitForJobTerminal(job.id);

    // Verify NO Journal reflect.request was dispatched
    const journalCalls = dispatchSpy.mock.calls.filter(
      (call) => call[0].to === 'journal',
    );
    expect(journalCalls.length).toBe(0);

    // Verify the reflection stub logged (journalSkip: true means NO reflection log)
    const reflectionLogs = mockLogger.info.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Reflection stub'),
    );
    expect(reflectionLogs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// User Story 3: High-Risk Task with Approval — Section 4.7
// ---------------------------------------------------------------------------

describe('User Story 3: High-Risk Task with Approval', () => {
  // User: "Delete all .tmp files in my project"
  //
  // Expected flow:
  // 1. Bridge receives message
  // 2. Axis creates Job, dispatches to Scout
  // 3. Scout produces ExecutionPlan with 2 steps:
  //    (a) gear:file-search — find all .tmp files
  //    (b) gear:file-delete — delete found files
  //    riskLevel: 'high' (destructive file operation)
  // 4. Sentinel: file deletion is destructive/irreversible. NEEDS_USER_APPROVAL.
  // 5. Axis: Job → awaiting_approval. Bridge displays approval dialog.
  // 6. User approves.
  // 7. Axis resumes execution. Gear runs both steps.
  // 8. Journal reflection triggered (journalSkip not set).
  // 9. Bridge delivers response.

  it('should complete a high-risk task after user approval', async () => {
    const workspacePath = join(dataDir, 'workspace');

    // Mock LLM: return a high-risk plan with glob (find files) + delete.
    // Uses action names the risk classifier recognizes: 'glob' → read_files,
    // 'delete' → delete_files. The delete step triggers needs_user_approval.
    const provider = createDynamicMockProvider((_msg) => {
      const plan: ExecutionPlan = {
        id: generateId(),
        jobId: generateId(),
        // journalSkip NOT set — reflection should be triggered
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
              paths: [join(workspacePath, 'a.tmp'), join(workspacePath, 'b.tmp')],
            },
            riskLevel: 'high',
            description: 'Delete found .tmp files',
          },
        ],
      };
      return fullPathResponse(plan);
    });

    // Mock Gear results
    const gearResults: Record<string, Record<string, unknown>> = {
      'gear:file-manager:glob': {
        matches: [
          { path: join(workspacePath, 'a.tmp') },
          { path: join(workspacePath, 'b.tmp') },
        ],
        matchCount: 2,
      },
      'gear:file-manager:delete': {
        deleted: [join(workspacePath, 'a.tmp'), join(workspacePath, 'b.tmp')],
        deletedCount: 2,
      },
    };

    await setupPipeline(provider, { gearResults, autoStart: false });

    const conversationId = await createConversation();
    const job = await axis!.createJob({ conversationId, source: 'user' });
    await createUserMessage(
      conversationId,
      'Delete all .tmp files in my project',
      job.id,
    );

    // Start worker pool — job will process until awaiting_approval
    axis!.internals.workerPool.start();

    // Wait for the job to reach awaiting_approval
    await waitForJobStatus(job.id, 'awaiting_approval');

    const jobBeforeApproval = await axis!.getJob(job.id);
    expect(jobBeforeApproval?.status).toBe('awaiting_approval');
    expect(jobBeforeApproval?.validation?.verdict).toBe('needs_user_approval');
    expect(jobBeforeApproval?.plan?.steps.length).toBe(2);

    // Simulate user approval — transition from awaiting_approval to executing.
    // In production, Bridge's POST /api/jobs/:id/approve does this.
    // The post-approval handler (registered in setupPipeline) will pick up
    // the transition and resume Gear execution.
    await axis!.internals.jobQueue.transition(job.id, 'awaiting_approval', 'executing');

    // Wait for the approved job to complete
    const result = await waitForJobTerminal(job.id);

    expect(result.status).toBe('completed');
    expect(result.result).toBeDefined();
    expect(result.result!['path']).toBe('full');

    // Verify both steps executed successfully
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
  });

  it('should invoke the reflection stub when journalSkip is not set', async () => {
    const workspacePath = join(dataDir, 'workspace');

    const provider = createDynamicMockProvider((_msg) => {
      const plan: ExecutionPlan = {
        id: generateId(),
        jobId: generateId(),
        // journalSkip NOT set — reflection should fire
        steps: [{
          id: 'step-1',
          gear: 'gear:file-manager',
          action: 'delete',
          parameters: { paths: [join(workspacePath, 'test.tmp')] },
          riskLevel: 'high',
        }],
      };
      return fullPathResponse(plan);
    });

    const gearResults: Record<string, Record<string, unknown>> = {
      'gear:file-manager:delete': { deleted: [join(workspacePath, 'test.tmp')], deletedCount: 1 },
    };

    await setupPipeline(provider, { gearResults, autoStart: false });

    const conversationId = await createConversation();
    const job = await axis!.createJob({ conversationId, source: 'user' });
    await createUserMessage(conversationId, 'Delete test.tmp', job.id);

    axis!.internals.workerPool.start();
    await waitForJobStatus(job.id, 'awaiting_approval');

    // Approve the job
    await axis!.internals.jobQueue.transition(job.id, 'awaiting_approval', 'executing');

    await waitForJobTerminal(job.id);

    // Verify reflection was attempted (journalSkip is false/undefined).
    // Since Journal is not registered in this test, the dispatch returns an
    // error and the pipeline logs at debug level.
    const reflectionLogs = mockLogger.debug.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('Journal reflection skipped'),
    );
    expect(reflectionLogs.length).toBe(1);
  });

  it('should handle the full approval lifecycle: awaiting → approve → execute → complete', async () => {
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
      'gear:file-manager:delete': { deleted: [join(workspacePath, 'temp.tmp')], deletedCount: 1 },
    };

    await setupPipeline(provider, { gearResults, autoStart: false });

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
    await axis!.internals.jobQueue.transition(job.id, 'awaiting_approval', 'executing');

    const result = await waitForJobTerminal(job.id);
    expect(result.status).toBe('completed');

    // Verify the full state transition sequence
    const statuses = statusTransitions.map((t) => t.to);
    expect(statuses).toContain('planning');
    expect(statuses).toContain('validating');
    expect(statuses).toContain('awaiting_approval');
    expect(statuses).toContain('executing');
    expect(statuses).toContain('completed');

    // Verify ordering: planning before validating before awaiting_approval
    const planningIdx = statuses.indexOf('planning');
    const validatingIdx = statuses.indexOf('validating');
    const approvalIdx = statuses.indexOf('awaiting_approval');
    const executingIdx = statuses.indexOf('executing');
    const completedIdx = statuses.indexOf('completed');

    expect(planningIdx).toBeLessThan(validatingIdx);
    expect(validatingIdx).toBeLessThan(approvalIdx);
    expect(approvalIdx).toBeLessThan(executingIdx);
    expect(executingIdx).toBeLessThan(completedIdx);
  });
});
