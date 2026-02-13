// Phase 6.4 Integration Test — Bridge ↔ Axis
//
// Tests the wiring between Bridge API and Axis runtime:
// - Message submission creates jobs via Axis (not direct SQL)
// - Job status updates are broadcast via WebSocket
// - Approval flow end-to-end through Axis state machine

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';

import type { Axis, JobProcessor } from '@meridian/axis';
import { createAxis } from '@meridian/axis';
import { createBridgeServer } from '@meridian/bridge';
import type { BridgeServer } from '@meridian/bridge';
import {
  DatabaseClient,
  getDefaultConfig,
  migrate,
} from '@meridian/shared';
import type { Logger, MeridianConfig, WSMessage } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-bridge-axis');
const PROJECT_ROOT = process.cwd();

let db: DatabaseClient;
let dataDir: string;
let axis: Axis | undefined;
let bridge: BridgeServer | undefined;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  close: vi.fn(),
};

function makeConfig(overrides?: Partial<MeridianConfig['axis']>): MeridianConfig {
  const config = getDefaultConfig('desktop');
  return {
    ...config,
    axis: {
      ...config.axis,
      workers: 1,
      ...overrides,
    },
    bridge: {
      ...config.bridge,
      port: 40000 + Math.floor(Math.random() * 10000),
    },
  };
}

/**
 * No-op processor that does nothing (jobs stay in 'planning').
 * Tests manually drive state transitions.
 */
const noopProcessor: JobProcessor = async () => {
  // Intentionally empty — tests control transitions directly
};

/** Wait for a WebSocket message matching a predicate. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: WSMessage) => boolean,
  timeoutMs = 3000,
): Promise<WSMessage> {
  return new Promise<WSMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(event: { data: unknown }): void {
      try {
        const data = typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString('utf-8')
            : String(event.data);
        const msg = JSON.parse(data) as WSMessage;
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
      } catch {
        // Ignore parse errors, keep waiting
      }
    }

    ws.addEventListener('message', handler);
  });
}

/** Collect all messages within a time window. */
function collectMessages(ws: WebSocket, durationMs: number): Promise<WSMessage[]> {
  return new Promise<WSMessage[]>((resolve) => {
    const messages: WSMessage[] = [];

    function handler(event: { data: unknown }): void {
      try {
        const data = typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString('utf-8')
            : String(event.data);
        messages.push(JSON.parse(data) as WSMessage);
      } catch {
        // Ignore
      }
    }

    ws.addEventListener('message', handler);

    setTimeout(() => {
      ws.removeEventListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

/** Setup password, login, and return auth credentials. */
async function setupAndLogin(
  bridgeServer: BridgeServer,
): Promise<{
  sessionToken: string;
  csrfToken: string;
  sessionId: string;
  cookie: string;
}> {
  await bridgeServer.authService.setupPassword('TestPassword123!');
  const loginResult = await bridgeServer.authService.login('TestPassword123!', '127.0.0.1');

  if (!loginResult.success || !loginResult.session || !loginResult.token) {
    throw new Error('Login failed in test setup');
  }

  const sessionResponse = await bridgeServer.server.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: {
      authorization: `Bearer ${loginResult.token}`,
    },
  });
  const sessionBody = JSON.parse(sessionResponse.body);

  return {
    sessionToken: loginResult.token,
    csrfToken: sessionBody.csrfToken,
    sessionId: loginResult.session.id,
    cookie: `meridian_session=${loginResult.token}`,
  };
}

/** Get a WS connection token via the REST endpoint. */
async function getWsToken(
  bridgeServer: BridgeServer,
  auth: { cookie: string; csrfToken: string },
): Promise<string> {
  const response = await bridgeServer.server.inject({
    method: 'POST',
    url: '/api/ws/token',
    headers: {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrfToken,
    },
  });

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body) as { token: string };
  return body.token;
}

/** Open an authenticated WebSocket connection. */
async function openAuthenticatedWs(
  bridgeServer: BridgeServer,
  auth: { cookie: string; csrfToken: string },
): Promise<{ ws: WebSocket; connectedMsg: WSMessage }> {
  const wsToken = await getWsToken(bridgeServer, auth);

  const ws = await bridgeServer.server.injectWS('/api/ws', {
    headers: {
      cookie: auth.cookie,
    },
  });

  // Send connection token
  ws.send(JSON.stringify({ token: wsToken }));

  // Wait for connected message
  const connectedMsg = await waitForMessage(ws, (msg) => msg.type === 'connected');

  return { ws, connectedMsg };
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

  vi.clearAllMocks();
});

afterEach(async () => {
  if (bridge) {
    try {
      await bridge.stop();
    } catch {
      // Best-effort
    }
    bridge = undefined;
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

  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bridge ↔ Axis integration', () => {
  describe('message submission creates job via Axis', () => {
    it('should create a job through Axis when POST /api/messages is called', async () => {
      const config = makeConfig();

      axis = createAxis({
        db,
        config,
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      // Stop worker pool so it doesn't claim jobs during the test
      await axis.internals.workerPool.stop();

      bridge = await createBridgeServer(config.bridge, axis, {
        db,
        logger: mockLogger as unknown as Logger,
        disableRateLimit: true,
      });

      const auth = await setupAndLogin(bridge);

      // Create a conversation first
      const convRes = await bridge.server.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: {
          cookie: auth.cookie,
          'x-csrf-token': auth.csrfToken,
        },
        payload: { title: 'Test conversation' },
      });
      expect(convRes.statusCode).toBe(201);
      const conv = JSON.parse(convRes.body) as { id: string };

      // Send a message — this should create a job via Axis
      const msgRes = await bridge.server.inject({
        method: 'POST',
        url: '/api/messages',
        headers: {
          cookie: auth.cookie,
          'x-csrf-token': auth.csrfToken,
        },
        payload: {
          conversationId: conv.id,
          content: 'Hello Meridian!',
        },
      });
      expect(msgRes.statusCode).toBe(201);
      const msgBody = JSON.parse(msgRes.body) as { id: string; jobId: string };
      expect(msgBody.jobId).toBeDefined();

      // Verify the job exists in Axis's job queue
      const job = await axis.getJob(msgBody.jobId);
      expect(job).toBeDefined();
      expect(job?.status).toBe('pending');
      expect(job?.source).toBe('user');
      expect(job?.conversationId).toBe(conv.id);
    });
  });

  describe('job status updates via WebSocket', () => {
    it('should broadcast status messages on job transitions', async () => {
      const config = makeConfig();

      axis = createAxis({
        db,
        config,
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();
      await axis.internals.workerPool.stop();

      bridge = await createBridgeServer(config.bridge, axis, {
        db,
        logger: mockLogger as unknown as Logger,
        disableRateLimit: true,
      });

      const auth = await setupAndLogin(bridge);
      const { ws } = await openAuthenticatedWs(bridge, auth);

      try {
        // Create a job via Axis
        const job = await axis.createJob({ source: 'user' });

        // Start collecting messages, then drive transitions
        const collectPromise = collectMessages(ws, 500);

        // Transition: pending → planning
        await axis.internals.jobQueue.transition(job.id, 'pending', 'planning');
        // Transition: planning → validating
        await axis.internals.jobQueue.transition(job.id, 'planning', 'validating');
        // Transition: validating → executing
        await axis.internals.jobQueue.transition(job.id, 'validating', 'executing');

        const messages = await collectPromise;

        // Filter to status messages for this job
        const statusMessages = messages.filter(
          (m) => m.type === 'status' && (m as { jobId: string }).jobId === job.id,
        );

        // Should have at least the transitions we triggered
        expect(statusMessages.length).toBeGreaterThanOrEqual(3);

        const statuses = statusMessages.map(
          (m) => (m as { status: string }).status,
        );
        expect(statuses).toContain('planning');
        expect(statuses).toContain('validating');
        expect(statuses).toContain('executing');
      } finally {
        ws.close();
      }
    });
  });

  describe('approval flow end-to-end', () => {
    it('should broadcast approval_required and approve via API', async () => {
      const config = makeConfig();

      axis = createAxis({
        db,
        config,
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();
      await axis.internals.workerPool.stop();

      bridge = await createBridgeServer(config.bridge, axis, {
        db,
        logger: mockLogger as unknown as Logger,
        disableRateLimit: true,
      });

      const auth = await setupAndLogin(bridge);
      const { ws } = await openAuthenticatedWs(bridge, auth);

      try {
        // Create a job and add a plan + validation
        const job = await axis.createJob({ source: 'user' });

        const testPlan = {
          id: 'plan-1',
          jobId: job.id,
          steps: [{
            id: 'step-1',
            gear: 'gear:web-fetch',
            action: 'fetch_url',
            parameters: { url: 'https://example.com' },
            riskLevel: 'low' as const,
          }],
        };

        const testValidation = {
          id: 'val-1',
          planId: 'plan-1',
          verdict: 'needs_user_approval' as const,
          stepResults: [{
            stepId: 'step-1',
            verdict: 'needs_user_approval' as const,
            riskLevel: 'medium' as const,
            reasoning: 'Network access requires approval',
          }],
          overallRisk: 'medium' as const,
        };

        // Drive job through to awaiting_approval with plan + validation
        await axis.internals.jobQueue.transition(job.id, 'pending', 'planning');
        await axis.internals.jobQueue.transition(job.id, 'planning', 'validating', {
          plan: testPlan,
        });

        // Start listening for the approval_required message
        const approvalPromise = waitForMessage(
          ws,
          (msg) => msg.type === 'approval_required',
          3000,
        );

        // Transition to awaiting_approval (this should trigger WS broadcast)
        await axis.internals.jobQueue.transition(
          job.id,
          'validating',
          'awaiting_approval',
          { validation: testValidation },
        );

        // Wait for the approval_required message
        const approvalMsg = await approvalPromise;
        expect(approvalMsg.type).toBe('approval_required');
        const approvalData = approvalMsg as {
          type: string;
          jobId: string;
          plan: unknown;
          risks: unknown[];
          metadata?: { nonce?: string };
        };
        expect(approvalData.jobId).toBe(job.id);
        expect(approvalData.plan).toBeDefined();
        expect(approvalData.risks).toBeDefined();

        // Extract the nonce from the approval message
        const nonce = approvalData.metadata?.nonce;
        expect(nonce).toBeDefined();

        // Listen for the executing status update
        const executingPromise = waitForMessage(
          ws,
          (msg) => msg.type === 'status' && (msg as { status: string }).status === 'executing',
          3000,
        );

        // Approve the job via the API using the nonce
        const approveRes = await bridge.server.inject({
          method: 'POST',
          url: `/api/jobs/${job.id}/approve`,
          headers: {
            cookie: auth.cookie,
            'x-csrf-token': auth.csrfToken,
          },
          payload: { nonce },
        });
        expect(approveRes.statusCode).toBe(200);

        const approveBody = JSON.parse(approveRes.body) as { status: string };
        expect(approveBody.status).toBe('executing');

        // Verify WebSocket received the status update
        const executingMsg = await executingPromise;
        expect(executingMsg.type).toBe('status');
        expect((executingMsg as { jobId: string }).jobId).toBe(job.id);

        // Verify the job is now executing in Axis
        const updatedJob = await axis.getJob(job.id);
        expect(updatedJob?.status).toBe('executing');
      } finally {
        ws.close();
      }
    });
  });

  describe('cancel via Axis', () => {
    it('should cancel a job through Axis and broadcast via WebSocket', async () => {
      const config = makeConfig();

      axis = createAxis({
        db,
        config,
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();
      await axis.internals.workerPool.stop();

      bridge = await createBridgeServer(config.bridge, axis, {
        db,
        logger: mockLogger as unknown as Logger,
        disableRateLimit: true,
      });

      const auth = await setupAndLogin(bridge);
      const { ws } = await openAuthenticatedWs(bridge, auth);

      try {
        // Create a job
        const job = await axis.createJob({ source: 'user' });

        // Listen for cancelled status
        const cancelPromise = waitForMessage(
          ws,
          (msg) => msg.type === 'status' && (msg as { status: string }).status === 'cancelled',
          3000,
        );

        // Cancel via the API
        const cancelRes = await bridge.server.inject({
          method: 'POST',
          url: `/api/jobs/${job.id}/cancel`,
          headers: {
            cookie: auth.cookie,
            'x-csrf-token': auth.csrfToken,
          },
        });
        expect(cancelRes.statusCode).toBe(200);

        const cancelBody = JSON.parse(cancelRes.body) as { status: string };
        expect(cancelBody.status).toBe('cancelled');

        // Verify WebSocket received the cancelled status
        const cancelMsg = await cancelPromise;
        expect(cancelMsg.type).toBe('status');
        expect((cancelMsg as { jobId: string }).jobId).toBe(job.id);

        // Verify in Axis
        const updatedJob = await axis.getJob(job.id);
        expect(updatedJob?.status).toBe('cancelled');
      } finally {
        ws.close();
      }
    });
  });

  describe('BridgeServer lifecycle', () => {
    it('should expose server, wsManager, and authService', async () => {
      const config = makeConfig();

      axis = createAxis({
        db,
        config,
        dataDir,
        projectRoot: PROJECT_ROOT,
        processor: noopProcessor,
      });
      await axis.start();

      bridge = await createBridgeServer(config.bridge, axis, {
        db,
        logger: mockLogger as unknown as Logger,
        disableRateLimit: true,
      });

      expect(bridge.server).toBeDefined();
      expect(bridge.wsManager).toBeDefined();
      expect(bridge.authService).toBeDefined();
      expect(typeof bridge.start).toBe('function');
      expect(typeof bridge.stop).toBe('function');
    });
  });
});
