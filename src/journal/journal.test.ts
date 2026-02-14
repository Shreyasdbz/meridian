/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  AxisMessage,
  ComponentId,
  ComponentRegistry,
  MessageHandler,
} from '@meridian/shared';
import { generateId } from '@meridian/shared';

import type { GearSuggester, SavedGearBrief } from './gear-suggester.js';
import { Journal, createJournal } from './journal.js';
import type { MemoryWriter, WriteResult } from './memory-writer.js';
import type { Reflector, ReflectionResult } from './reflector.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockRegistry(): ComponentRegistry & { handlers: Map<string, MessageHandler> } {
  const handlers = new Map<string, MessageHandler>();
  return {
    handlers,
    register: vi.fn((id: ComponentId, handler: MessageHandler) => {
      handlers.set(id, handler);
    }),
    unregister: vi.fn((id: ComponentId) => {
      handlers.delete(id);
    }),
    has: vi.fn((id: ComponentId) => handlers.has(id)),
  };
}

function createMockReflectionResult(
  overrides: Partial<ReflectionResult> = {},
): ReflectionResult {
  return {
    episode: { summary: 'Completed file read', outcome: 'success' },
    facts: [
      { category: 'user_preference', content: 'Prefers JSON output', confidence: 0.8 },
    ],
    procedures: [
      { category: 'strategy', content: 'Use streaming for large files' },
    ],
    contradictions: [],
    gearSuggestion: null,
    ...overrides,
  };
}

function createMockReflector(
  result?: ReflectionResult,
): Reflector {
  return {
    reflect: vi.fn().mockResolvedValue(result ?? createMockReflectionResult()),
  } as unknown as Reflector;
}

function createMockMemoryWriter(
  result?: WriteResult,
): MemoryWriter {
  return {
    write: vi.fn().mockResolvedValue(result ?? {
      episodeId: 'ep-001',
      stagedFacts: 1,
      stagedProcedures: 1,
      contradictionsFound: 0,
      embeddingCreated: false,
    }),
  } as unknown as MemoryWriter;
}

function createMockGearSuggester(
  savedBrief?: SavedGearBrief | null,
): GearSuggester {
  return {
    processSuggestion: vi.fn().mockReturnValue(savedBrief ?? null),
  } as unknown as GearSuggester;
}

function createReflectRequest(overrides: Partial<AxisMessage> = {}): AxisMessage {
  return {
    id: generateId(),
    correlationId: generateId(),
    timestamp: new Date().toISOString(),
    from: 'bridge' as ComponentId,
    to: 'journal' as ComponentId,
    type: 'reflect.request',
    jobId: 'job-001',
    payload: {
      plan: {
        id: 'plan-001',
        steps: [{ id: 'step-1', gear: 'file-manager', action: 'read_file', parameters: {} }],
      },
      status: 'completed',
      userMessage: 'Read the config file',
      assistantResponse: 'Here is the file content...',
      stepResults: [
        { stepId: 'step-1', status: 'completed', result: { data: 'content' } },
      ],
    },
    ...overrides,
  };
}

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Journal', () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let reflector: ReturnType<typeof createMockReflector>;
  let memoryWriter: ReturnType<typeof createMockMemoryWriter>;
  let gearSuggester: ReturnType<typeof createMockGearSuggester>;
  let journal: Journal;

  beforeEach(() => {
    registry = createMockRegistry();
    reflector = createMockReflector();
    memoryWriter = createMockMemoryWriter();
    gearSuggester = createMockGearSuggester();

    journal = new Journal(
      { reflector, memoryWriter, gearSuggester, logger: noopLogger },
      { registry },
    );
  });

  describe('registration', () => {
    it('should register with Axis as "journal" component', () => {
      expect(registry.register).toHaveBeenCalledWith('journal', expect.any(Function));
      expect(registry.handlers.has('journal')).toBe(true);
    });

    it('should unregister on dispose', () => {
      journal.dispose();
      expect(registry.unregister).toHaveBeenCalledWith('journal');
    });

    it('should be idempotent on multiple dispose calls', () => {
      journal.dispose();
      journal.dispose();
      expect(registry.unregister).toHaveBeenCalledTimes(1);
    });
  });

  describe('message handling', () => {
    it('should reject non-reflect.request messages', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest({ type: 'plan.request' });

      await expect(handler(message, new AbortController().signal)).rejects.toThrow(
        /unexpected message type.*plan\.request.*Expected 'reflect\.request'/,
      );
    });

    it('should reject messages without plan in payload', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();
      message.payload = { status: 'completed' };

      await expect(handler(message, new AbortController().signal)).rejects.toThrow(
        /must contain an "plan" field/,
      );
    });

    it('should reject messages without status in payload', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();
      message.payload = { plan: { id: 'p', steps: [] } };

      await expect(handler(message, new AbortController().signal)).rejects.toThrow(
        /must contain a string "status" field/,
      );
    });

    it('should process reflect.request and return reflect.response', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      expect(response.type).toBe('reflect.response');
      expect(response.from).toBe('journal');
      expect(response.to).toBe('bridge');
      expect(response.correlationId).toBe(message.correlationId);
      expect(response.replyTo).toBe(message.id);
      expect(response.jobId).toBe('job-001');
    });

    it('should call Reflector with correct input', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      await handler(message, new AbortController().signal);

      expect(reflector.reflect).toHaveBeenCalledWith({
        plan: message.payload!['plan'],
        status: 'completed',
        userMessage: 'Read the config file',
        assistantResponse: 'Here is the file content...',
        stepResults: message.payload!['stepResults'],
      });
    });

    it('should call MemoryWriter with reflection result', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      await handler(message, new AbortController().signal);

      expect(memoryWriter.write).toHaveBeenCalledWith(
        expect.objectContaining({
          episode: { summary: 'Completed file read', outcome: 'success' },
        }),
        'job-001',
      );
    });

    it('should call GearSuggester with reflection result', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      await handler(message, new AbortController().signal);

      expect(gearSuggester.processSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          gearSuggestion: null,
        }),
      );
    });

    it('should include memory write result in response', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      expect(response.payload).toMatchObject({
        memory: {
          episodeId: 'ep-001',
          stagedFacts: 1,
          stagedProcedures: 1,
          contradictionsFound: 0,
          embeddingCreated: false,
        },
      });
    });

    it('should include reflection summary in response', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      expect(response.payload).toMatchObject({
        reflection: {
          episode: { summary: 'Completed file read', outcome: 'success' },
          factsCount: 1,
          proceduresCount: 1,
          contradictionsCount: 0,
        },
      });
    });
  });

  describe('Gear suggestion flow', () => {
    it('should include gear suggestion in response when present', async () => {
      const savedBrief: SavedGearBrief = {
        brief: {
          problem: 'Frequent CSV parsing tasks',
          proposedSolution: 'Create a CSV parser Gear',
          exampleInput: '{"file": "data.csv"}',
          exampleOutput: '{"rows": [...]}',
        },
        filePath: '/workspace/gear/brief-test.json',
        savedAt: new Date().toISOString(),
      };

      const reflectionWithSuggestion = createMockReflectionResult({
        gearSuggestion: savedBrief.brief,
      });

      const customReflector = createMockReflector(reflectionWithSuggestion);
      const customGearSuggester = createMockGearSuggester(savedBrief);

      const customRegistry = createMockRegistry();
      const customJournal = new Journal(
        {
          reflector: customReflector,
          memoryWriter: createMockMemoryWriter(),
          gearSuggester: customGearSuggester,
          logger: noopLogger,
        },
        { registry: customRegistry },
      );

      const handler = customRegistry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      expect(response.payload).toMatchObject({
        gearSuggestion: {
          problem: 'Frequent CSV parsing tasks',
          proposedSolution: 'Create a CSV parser Gear',
        },
        briefId: '/workspace/gear/brief-test.json',
      });

      customJournal.dispose();
    });

    it('should not include gear suggestion when none present', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      expect(response.payload).not.toHaveProperty('gearSuggestion');
      expect(response.payload).not.toHaveProperty('briefId');
    });
  });

  describe('error handling', () => {
    it('should return error response when Reflector fails', async () => {
      const failingReflector = {
        reflect: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      } as unknown as Reflector;

      const failRegistry = createMockRegistry();
      const failJournal = new Journal(
        {
          reflector: failingReflector,
          memoryWriter: createMockMemoryWriter(),
          gearSuggester: createMockGearSuggester(),
          logger: noopLogger,
        },
        { registry: failRegistry },
      );

      const handler = failRegistry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      expect(response.type).toBe('error');
      expect(response.payload).toMatchObject({
        code: 'REFLECTION_FAILED',
        message: 'LLM unavailable',
      });

      failJournal.dispose();
    });

    it('should continue when MemoryWriter fails (non-blocking)', async () => {
      const failingWriter = {
        write: vi.fn().mockRejectedValue(new Error('DB write failed')),
      } as unknown as MemoryWriter;

      const failRegistry = createMockRegistry();
      const failJournal = new Journal(
        {
          reflector: createMockReflector(),
          memoryWriter: failingWriter,
          gearSuggester: createMockGearSuggester(),
          logger: noopLogger,
        },
        { registry: failRegistry },
      );

      const handler = failRegistry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      // Should still return success — memory write is non-blocking
      expect(response.type).toBe('reflect.response');
      expect(response.payload).not.toHaveProperty('memory');

      failJournal.dispose();
    });

    it('should continue when GearSuggester fails (non-blocking)', async () => {
      const failingSuggester = {
        processSuggestion: vi.fn().mockImplementation(() => {
          throw new Error('File write failed');
        }),
      } as unknown as GearSuggester;

      const failRegistry = createMockRegistry();
      const failJournal = new Journal(
        {
          reflector: createMockReflector(),
          memoryWriter: createMockMemoryWriter(),
          gearSuggester: failingSuggester,
          logger: noopLogger,
        },
        { registry: failRegistry },
      );

      const handler = failRegistry.handlers.get('journal')!;
      const message = createReflectRequest();

      const response = await handler(message, new AbortController().signal);

      // Should still return success — gear suggestion is non-blocking
      expect(response.type).toBe('reflect.response');
      expect(response.payload).not.toHaveProperty('gearSuggestion');

      failJournal.dispose();
    });
  });

  describe('payload edge cases', () => {
    it('should handle missing optional fields in payload', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest();
      message.payload = {
        plan: { id: 'p', steps: [] },
        status: 'completed',
      };

      const response = await handler(message, new AbortController().signal);

      expect(response.type).toBe('reflect.response');
      expect(reflector.reflect).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessage: '',
          assistantResponse: '',
          stepResults: undefined,
        }),
      );
    });

    it('should use jobId from message when present', async () => {
      const handler = registry.handlers.get('journal')!;
      const message = createReflectRequest({ jobId: 'custom-job-id' });

      const response = await handler(message, new AbortController().signal);

      expect(response.jobId).toBe('custom-job-id');
      expect(memoryWriter.write).toHaveBeenCalledWith(expect.anything(), 'custom-job-id');
    });
  });
});

describe('createJournal', () => {
  it('should create a Journal instance and register with Axis', () => {
    const reg = createMockRegistry();
    const j = createJournal(
      {
        reflector: createMockReflector(),
        memoryWriter: createMockMemoryWriter(),
        gearSuggester: createMockGearSuggester(),
      },
      { registry: reg },
    );

    expect(reg.handlers.has('journal')).toBe(true);
    j.dispose();
    expect(reg.handlers.has('journal')).toBe(false);
  });
});
