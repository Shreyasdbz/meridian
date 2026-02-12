// @meridian/shared — SQLite worker thread (Section 11.1)
//
// This file runs in a dedicated worker_threads worker. It owns ALL SQLite
// database connections via the DatabaseEngine. The main thread never touches
// SQLite directly.
//
// Communication: receives WorkerRequest via parentPort, returns WorkerResponse.

import { parentPort } from 'node:worker_threads';

import { DatabaseEngine } from './engine.js';
import type { WorkerRequest, WorkerResponse } from './types.js';

if (!parentPort) {
  throw new Error('worker.ts must be run as a worker_threads worker');
}

// Store in a const so TypeScript knows it's non-null for the rest of the file
const port = parentPort;
const engine = new DatabaseEngine();

function handleMessage(msg: WorkerRequest): WorkerResponse {
  const { id } = msg;

  try {
    switch (msg.type) {
      case 'init': {
        engine.open(msg.dbName, msg.dbPath, msg.tier);
        return { type: 'result', id, data: null };
      }

      case 'query': {
        const rows = engine.query(msg.dbName, msg.sql, msg.params, msg.useWriteConnection);
        return { type: 'result', id, data: rows };
      }

      case 'run': {
        const result = engine.run(msg.dbName, msg.sql, msg.params);
        return { type: 'result', id, data: result };
      }

      case 'exec': {
        engine.exec(msg.dbName, msg.sql);
        return { type: 'result', id, data: null };
      }

      case 'begin': {
        engine.begin(msg.dbName);
        return { type: 'result', id, data: null };
      }

      case 'commit': {
        engine.commit(msg.dbName);
        return { type: 'result', id, data: null };
      }

      case 'rollback': {
        engine.rollback(msg.dbName);
        return { type: 'result', id, data: null };
      }

      case 'backup': {
        engine.backup(msg.dbName, msg.destPath);
        return { type: 'result', id, data: null };
      }

      case 'close': {
        engine.close(msg.dbName);
        return { type: 'result', id, data: null };
      }

      default: {
        return {
          type: 'error',
          id,
          error: `Unknown message type: ${(msg as { type: string }).type}`,
          code: 'ERR_UNKNOWN_TYPE',
        };
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode =
      error instanceof Error && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return { type: 'error', id, error: errMsg, code: errCode };
  }
}

port.on('message', (msg: WorkerRequest) => {
  const response = handleMessage(msg);
  port.postMessage(response);
});

// Signal readiness
port.postMessage({ type: 'result', id: '__ready__', data: null });
