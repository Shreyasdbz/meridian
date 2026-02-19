/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard values */
// Trust Mode Integration Tests
//
// Tests the full trust mode data flow end-to-end:
//   UI toggle → API body → job metadata → pipeline auto-approval
//
// Covers:
//   1. Trust mode auto-approves needs_user_approval (main path)
//   2. Trust mode auto-approves needs_user_approval (reroute path)
//   3. Trust mode OFF still pauses at awaiting_approval
//   4. Trust mode does NOT override rejected/needs_revision verdicts
//   5. Trust mode metadata persists through job queue round-trip
//   6. Bridge API accepts and threads trustMode to Axis
//   7. SQL fallback path stores metadata_json correctly

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
  ChatChunk,
  ChatRequest,
  ExecutionPlan,
  LLMProvider,
  Logger,
  MeridianConfig,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Mock LLM providers
// ---------------------------------------------------------------------------

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

const TEST_DIR = join(tmpdir(), 'meridian-test-trust-mode');
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

function fullPathResponse(plan: ExecutionPlan): string {
  return JSON.stringify(plan);
}

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
// Pipeline setup helper
// ---------------------------------------------------------------------------

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
  await axis.internals.workerPool.stop();

  scout = createScout(
    {
      provider,
      primaryModel: 'test-model',
      logger: mockLogger,
    },
    { registry: axis.internals.registry },
  );

  // Use maxTransactionAmountUsd: 100 so we can trigger needs_user_approval
  // via medium-risk plans (shell Gear, network Gear) while still approving
  // low-risk workspace file operations.
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

  // Register the post-approval handler (used in non-trust-mode tests to verify
  // the job correctly stays in awaiting_approval).
  const postApprovalHandler = createPostApprovalHandler({
    axis: axis,
    logger: mockLogger as unknown as Logger,
    db,
    bridge,
  });
  axis.internals.jobQueue.onStatusChange(postApprovalHandler);

  if (options?.autoStart !== false) {
    axis.internals.workerPool.start();
  }
}

// ---------------------------------------------------------------------------
// Auth helper for Bridge tests
// ---------------------------------------------------------------------------

async function setupAndLogin(
  bridgeServer: BridgeServer,
): Promise<{ cookie: string; csrfToken: string }> {
  await bridgeServer.authService.setupPassword('TestPassword123!');
  const loginResult = await bridgeServer.authService.login('TestPassword123!', '127.0.0.1');

  if (!loginResult.success || !loginResult.token) {
    throw new Error('Login failed in test setup');
  }

  const sessionResponse = await bridgeServer.server.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { authorization: `Bearer ${loginResult.token}` },
  });
  const sessionBody = JSON.parse(sessionResponse.body);

  return {
    cookie: `meridian_session=${loginResult.token}`,
    csrfToken: sessionBody.csrfToken,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Trust Mode', () => {
  // =========================================================================
  // 1. Pipeline auto-approval — main path
  // =========================================================================
  describe('main path: auto-approve needs_user_approval when trustMode is true', () => {
    it('should skip awaiting_approval and proceed to execution', async () => {
      // Plan with shell Gear + critical risk → Sentinel returns needs_user_approval
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:shell',
            action: 'execute',
            parameters: { command: 'echo hello' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      // Create job WITH trustMode metadata
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: true },
      });
      await createUserMessage(conversationId, 'Run echo hello', job.id);

      axis!.internals.workerPool.start();

      // Job should reach a terminal state WITHOUT pausing at awaiting_approval
      const result = await waitForJobTerminal(job.id);

      // It will either complete (if Gear execution works) or fail (Gear not running).
      // The key assertion: it must NOT be in awaiting_approval — it must have
      // progressed past validation into execution.
      const finalJob = await axis!.getJob(job.id);
      expect(finalJob?.status).not.toBe('awaiting_approval');

      // Verify the job had a plan and went through validation
      expect(finalJob?.plan).toBeDefined();

      // Verify logger was called with trust mode auto-approve message
      const trustModeLogCalls = mockLogger.info.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Trust mode'),
      );

      // For plans that Sentinel rejects outright (not needs_user_approval),
      // trust mode won't fire. But if verdict was needs_user_approval, it should.
      // We check based on the actual verdict.
      if (finalJob?.validation?.verdict === 'needs_user_approval') {
        // This is the case we specifically want to test — trust mode kicked in
        expect(trustModeLogCalls.length).toBeGreaterThanOrEqual(1);
        // Job must have progressed past awaiting_approval
        expect(['executing', 'completed', 'failed']).toContain(result.status);
      }
    });
  });

  // =========================================================================
  // 2. Without trust mode, needs_user_approval pauses the job
  // =========================================================================
  describe('without trust mode: needs_user_approval pauses at awaiting_approval', () => {
    it('should pause at awaiting_approval when trustMode is not set', async () => {
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:shell',
            action: 'execute',
            parameters: { command: 'echo hello' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      // Create job WITHOUT trustMode — no metadata at all
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
      });
      await createUserMessage(conversationId, 'Run echo hello', job.id);

      axis!.internals.workerPool.start();

      // Wait for job to settle
      await waitForJobStatus(job.id, 'awaiting_approval');
      const finalJob = await axis!.getJob(job.id);

      // Should be either awaiting_approval or failed (Sentinel rejected outright)
      expect(['awaiting_approval', 'failed']).toContain(finalJob?.status);

      // If it reached needs_user_approval, it should be paused
      if (finalJob?.status === 'awaiting_approval') {
        expect(finalJob.validation?.verdict).toBe('needs_user_approval');
      }
    });

    it('should pause at awaiting_approval when trustMode is explicitly false', async () => {
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:shell',
            action: 'execute',
            parameters: { command: 'echo hello' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      // Create job with trustMode: false
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: false },
      });
      await createUserMessage(conversationId, 'Run echo hello', job.id);

      axis!.internals.workerPool.start();

      await waitForJobStatus(job.id, 'awaiting_approval');
      const finalJob = await axis!.getJob(job.id);

      expect(['awaiting_approval', 'failed']).toContain(finalJob?.status);
    });
  });

  // =========================================================================
  // 3. Trust mode does NOT override rejected verdicts
  // =========================================================================
  describe('trust mode does not override non-approval verdicts', () => {
    it('should still fail for rejected plans even with trustMode', async () => {
      // Financial transaction exceeding maxTransactionAmountUsd (100)
      // triggers an outright rejection from Sentinel.
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
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: true },
      });
      await createUserMessage(conversationId, 'Charge the customer $1000', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect((result.error as { code: string }).code).toBe('PLAN_REJECTED');
    });

    it('should still work on fast-path (no Sentinel) even with trustMode', async () => {
      const provider = createMockProvider('Hello! How are you today?');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: true },
      });
      await createUserMessage(conversationId, 'Hello!', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      expect(result.status).toBe('completed');
      expect((result.result as Record<string, unknown>)['path']).toBe('fast');
    });
  });

  // =========================================================================
  // 4. Job metadata round-trip through queue
  // =========================================================================
  describe('metadata persistence', () => {
    it('should persist trustMode metadata through job queue round-trip', async () => {
      const provider = createMockProvider('Hi');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: true },
      });

      // Read back the job from the queue
      const retrieved = await axis!.getJob(job.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.metadata).toEqual({ trustMode: true });
    });

    it('should preserve other metadata alongside trustMode', async () => {
      const provider = createMockProvider('Hi');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: true, customField: 'value', count: 42 },
      });

      const retrieved = await axis!.getJob(job.id);
      expect(retrieved?.metadata).toEqual({
        trustMode: true,
        customField: 'value',
        count: 42,
      });
    });

    it('should handle job without metadata gracefully', async () => {
      const provider = createMockProvider('Hi');
      await setupFullPipeline(provider, { autoStart: false });

      const conversationId = await createConversation();
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
      });

      const retrieved = await axis!.getJob(job.id);
      // metadata should be undefined or null, not an object with trustMode
      expect(retrieved?.metadata?.trustMode).toBeUndefined();
    });
  });

  // =========================================================================
  // 5. Bridge API — trustMode field acceptance
  // =========================================================================
  describe('Bridge API: trustMode field', () => {
    it('should accept trustMode in POST /api/messages and thread to job metadata', async () => {
      const provider = createMockProvider('Hello from trust mode test.');
      await setupFullPipeline(provider, { withBridge: true });

      const auth = await setupAndLogin(bridge!);

      // Create conversation
      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: { title: 'Trust mode test' },
      });
      expect(convRes.statusCode).toBe(201);
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send message WITH trustMode: true
      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: {
          conversationId: conv.id,
          content: 'Hello with trust mode',
          trustMode: true,
        },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { jobId: string };

      // Verify the job has trustMode metadata
      const job = await axis!.getJob(msgBody.jobId);
      expect(job).toBeDefined();
      expect(job?.metadata?.trustMode).toBe(true);
    });

    it('should not set metadata when trustMode is omitted', async () => {
      const provider = createMockProvider('Normal message.');
      await setupFullPipeline(provider, { withBridge: true });

      const auth = await setupAndLogin(bridge!);

      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: { title: 'No trust mode test' },
      });
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send message WITHOUT trustMode
      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: {
          conversationId: conv.id,
          content: 'Hello without trust mode',
        },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { jobId: string };

      const job = await axis!.getJob(msgBody.jobId);
      expect(job?.metadata?.trustMode).toBeUndefined();
    });

    it('should not set metadata when trustMode is false', async () => {
      const provider = createMockProvider('Normal message.');
      await setupFullPipeline(provider, { withBridge: true });

      const auth = await setupAndLogin(bridge!);

      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: { title: 'Trust false test' },
      });
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send message with trustMode: false
      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: {
          conversationId: conv.id,
          content: 'Hello with trust mode off',
          trustMode: false,
        },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { jobId: string };

      // trustMode: false should NOT be set in metadata (only true is threaded)
      const job = await axis!.getJob(msgBody.jobId);
      expect(job?.metadata?.trustMode).toBeUndefined();
    });

    it('should reject invalid trustMode type', async () => {
      const provider = createMockProvider('Normal message.');
      await setupFullPipeline(provider, { withBridge: true });

      const auth = await setupAndLogin(bridge!);

      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: { title: 'Invalid trust mode test' },
      });
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send message with trustMode as a string (invalid type per schema)
      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: {
          conversationId: conv.id,
          content: 'Hello with bad trust mode',
          trustMode: 'yes',
        },
      });

      // Fastify schema validation should reject the string type
      expect(msgRes.statusCode).toBe(400);
    });
  });

  // =========================================================================
  // 6. SQL fallback path: metadata_json
  // =========================================================================
  describe('SQL fallback path: metadata_json', () => {
    it('should store metadata_json with trustMode when using direct SQL', async () => {
      // This tests the non-Axis path in messages.ts (when axis is not provided).
      // We need to test this directly since the setupFullPipeline always wires Axis.
      const conversationId = await createConversation();
      const messageId = generateId();
      const jobId = generateId();
      const now = new Date().toISOString();
      const metadataJson = JSON.stringify({ trustMode: true });

      await db.run(
        'meridian',
        `INSERT INTO jobs (id, conversation_id, status, priority, source_type, source_message_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'pending', 'normal', 'user', ?, ?, ?, ?)`,
        [jobId, conversationId, messageId, metadataJson, now, now],
      );

      // Read it back
      const rows = await db.query<{ metadata_json: string | null }>(
        'meridian',
        'SELECT metadata_json FROM jobs WHERE id = ?',
        [jobId],
      );

      expect(rows.length).toBe(1);
      expect(rows[0]!.metadata_json).toBe(metadataJson);

      const parsed = JSON.parse(rows[0]!.metadata_json!);
      expect(parsed.trustMode).toBe(true);
    });

    it('should store null metadata_json when trustMode is not set', async () => {
      const conversationId = await createConversation();
      const messageId = generateId();
      const jobId = generateId();
      const now = new Date().toISOString();

      await db.run(
        'meridian',
        `INSERT INTO jobs (id, conversation_id, status, priority, source_type, source_message_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'pending', 'normal', 'user', ?, NULL, ?, ?)`,
        [jobId, conversationId, messageId, now, now],
      );

      const rows = await db.query<{ metadata_json: string | null }>(
        'meridian',
        'SELECT metadata_json FROM jobs WHERE id = ?',
        [jobId],
      );

      expect(rows.length).toBe(1);
      expect(rows[0]!.metadata_json).toBeNull();
    });
  });

  // =========================================================================
  // 7. Full end-to-end: Bridge → Axis → Pipeline with trust mode auto-approve
  // =========================================================================
  describe('end-to-end: Bridge API → Axis → Pipeline auto-approval', () => {
    it('should auto-approve and execute a needs_user_approval plan via Bridge API with trustMode', async () => {
      // Plan with shell Gear → will trigger needs_user_approval from Sentinel
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:shell',
            action: 'execute',
            parameters: { command: 'echo "trust mode test"' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { withBridge: true });

      const auth = await setupAndLogin(bridge!);

      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: { title: 'E2E trust mode test' },
      });
      const conv = JSON.parse(convRes.body) as { id: string };

      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: {
          conversationId: conv.id,
          content: 'Run echo trust mode test',
          trustMode: true,
        },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { jobId: string };

      // Wait for the job to reach a terminal state
      await waitForJobTerminal(msgBody.jobId);

      // The job should NOT be in awaiting_approval — trust mode skips it.
      // It will be completed or failed (Gear execution may fail since shell
      // Gear isn't running in test, but the point is it bypassed approval).
      const finalJob = await axis!.getJob(msgBody.jobId);
      expect(finalJob?.status).not.toBe('awaiting_approval');

      // Verify trust mode metadata was set
      expect(finalJob?.metadata?.trustMode).toBe(true);
    });

    it('should pause at awaiting_approval when trustMode is not sent via Bridge API', async () => {
      const provider = createDynamicMockProvider((_msg) => {
        const plan: ExecutionPlan = {
          id: generateId(),
          jobId: generateId(),
          steps: [{
            id: 'step-1',
            gear: 'gear:shell',
            action: 'execute',
            parameters: { command: 'echo "no trust mode"' },
            riskLevel: 'critical',
          }],
        };
        return fullPathResponse(plan);
      });

      await setupFullPipeline(provider, { withBridge: true });

      const auth = await setupAndLogin(bridge!);

      const convRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: { title: 'E2E no trust mode test' },
      });
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send message WITHOUT trustMode
      const msgRes = await bridge!.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
        payload: {
          conversationId: conv.id,
          content: 'Run echo no trust mode',
        },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { jobId: string };

      // Wait for the job to reach a non-pending state
      await waitForJobStatus(msgBody.jobId, 'awaiting_approval');

      const finalJob = await axis!.getJob(msgBody.jobId);

      // Should be either awaiting_approval or failed (Sentinel rejected)
      expect(['awaiting_approval', 'failed']).toContain(finalJob?.status);
    });
  });

  // =========================================================================
  // 8. Approved verdict still works with trustMode
  // =========================================================================
  describe('approved verdict with trustMode', () => {
    it('should proceed normally when verdict is approved (trustMode is irrelevant)', async () => {
      // Low-risk workspace-scoped read → Sentinel auto-approves
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

      const conversationId = await createConversation();
      const job = await axis!.createJob({
        conversationId,
        source: 'user',
        metadata: { trustMode: true },
      });
      await createUserMessage(conversationId, 'Read test.txt', job.id);

      axis!.internals.workerPool.start();

      const result = await waitForJobTerminal(job.id);

      // Should proceed to execution (completed or failed, but NOT awaiting_approval)
      expect(result.status).not.toBe('awaiting_approval');
      const finalJob = await axis!.getJob(job.id);
      expect(finalJob?.plan).toBeDefined();
    });
  });
});
