import { describe, it, expect, vi } from 'vitest';

import type {
  ChatChunk,
  ChatRequest,
  ExecutionPlan,
  LLMProvider,
} from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import type { LLMValidatorConfig, LLMValidatorLogger } from './llm-validator.js';
import {
  buildSystemPrompt,
  buildValidationMessage,
  checkSameProvider,
  parseValidationResponse,
  validatePlanWithLLM,
} from './llm-validator.js';
import { stripPlan } from './plan-stripper.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-001',
    jobId: 'job-001',
    steps: [
      {
        id: 'step-1',
        gear: 'file-manager',
        action: 'read',
        parameters: { path: '/data/workspace/test.txt' },
        riskLevel: 'low',
        description: 'Read a test file',
        metadata: { context: 'user wants to read a file' },
      },
    ],
    reasoning: 'User wants to read a file',
    metadata: { scoutModel: 'test-model' },
    ...overrides,
  };
}

function createValidLLMResponse(): string {
  return JSON.stringify({
    verdict: 'approved',
    overallRisk: 'low',
    reasoning: 'All steps are safe file operations within the workspace.',
    stepResults: [
      {
        stepId: 'step-1',
        verdict: 'approved',
        category: 'security',
        riskLevel: 'low',
        reasoning: 'File read within workspace is safe.',
      },
    ],
  });
}

function makeAsyncIterable(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i < chunks.length) {
            return Promise.resolve({ value: chunks[i++] as ChatChunk, done: false });
          }
          return Promise.resolve({ value: undefined as unknown as ChatChunk, done: true as const });
        },
      };
    },
  };
}

interface MockLLMProvider extends LLMProvider {
  chatFn: ReturnType<typeof vi.fn>;
}

function createMockProvider(responseText: string): MockLLMProvider {
  const chatFn = vi.fn().mockReturnValue(
    makeAsyncIterable([{ content: responseText, done: true }]),
  );

  return {
    id: 'test-provider',
    name: 'Test Provider',
    chat: chatFn,
    chatFn,
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
    maxContextTokens: 100_000,
  };
}

function createMockLogger(): LLMValidatorLogger & {
  _infoFn: ReturnType<typeof vi.fn>;
  _warnFn: ReturnType<typeof vi.fn>;
  _errorFn: ReturnType<typeof vi.fn>;
  _debugFn: ReturnType<typeof vi.fn>;
} {
  const infoFn = vi.fn();
  const warnFn = vi.fn();
  const errorFn = vi.fn();
  const debugFn = vi.fn();
  return {
    info: infoFn,
    warn: warnFn,
    error: errorFn,
    debug: debugFn,
    _infoFn: infoFn,
    _warnFn: warnFn,
    _errorFn: errorFn,
    _debugFn: debugFn,
  };
}

function createConfig(
  overrides?: Partial<LLMValidatorConfig>,
): LLMValidatorConfig {
  return {
    provider: createMockProvider(createValidLLMResponse()),
    model: 'test-model',
    logger: createMockLogger(),
    ...overrides,
  };
}

/** Safely get mock call arg at index. */
function getMockCallArg(
  fn: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
): unknown {
  const call = fn.mock.calls[callIndex];
  expect(call).toBeDefined();
  return (call as unknown[])[argIndex];
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('should return a non-empty string', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should mention Sentinel role', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Sentinel');
    expect(prompt).toContain('safety validator');
  });

  it('should describe the information barrier', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Information Barrier');
    expect(prompt).toContain('do NOT have access');
  });

  it('should list all validation categories', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Security');
    expect(prompt).toContain('Privacy');
    expect(prompt).toContain('Financial');
    expect(prompt).toContain('Policy Compliance');
    expect(prompt).toContain('Composite Risk');
    expect(prompt).toContain('Ethical');
    expect(prompt).toContain('Legal');
  });

  it('should describe hard floor policies', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('File deletion');
    expect(prompt).toContain('Shell command');
    expect(prompt).toContain('Financial transactions');
    expect(prompt).toContain('System configuration');
  });

  it('should describe the response format', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Response Format');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"stepResults"');
  });

  it('should NOT contain user message references in system prompt', () => {
    const prompt = buildSystemPrompt();
    // Verify no user-specific content leaks
    expect(prompt).not.toContain('user says');
    expect(prompt).not.toContain('user wants');
    expect(prompt).not.toContain('journal');
    expect(prompt).not.toContain('gear catalog');
  });
});

// ---------------------------------------------------------------------------
// buildValidationMessage
// ---------------------------------------------------------------------------

describe('buildValidationMessage', () => {
  it('should include the stripped plan as JSON', () => {
    const plan = createTestPlan();
    const stripped = stripPlan(plan);
    const message = buildValidationMessage(stripped);

    expect(message).toContain('plan-001');
    expect(message).toContain('job-001');
    expect(message).toContain('file-manager');
    expect(message).toContain('step-1');
  });

  it('should NOT include stripped fields', () => {
    const plan = createTestPlan();
    const stripped = stripPlan(plan);
    const message = buildValidationMessage(stripped);

    // These were in the original plan but should be stripped
    expect(message).not.toContain('User wants to read a file');
    expect(message).not.toContain('scoutModel');
    expect(message).not.toContain('Read a test file');
    expect(message).not.toContain('user wants to read');
  });
});

// ---------------------------------------------------------------------------
// parseValidationResponse
// ---------------------------------------------------------------------------

describe('parseValidationResponse', () => {
  it('should parse a valid JSON response', () => {
    const result = parseValidationResponse(createValidLLMResponse());

    expect(result.verdict).toBe('approved');
    expect(result.overallRisk).toBe('low');
    expect(result.reasoning).toBe(
      'All steps are safe file operations within the workspace.',
    );
    expect(result.stepResults).toHaveLength(1);

    const step0 = result.stepResults[0];
    expect(step0).toBeDefined();
    expect(step0?.stepId).toBe('step-1');
    expect(step0?.verdict).toBe('approved');
    expect(step0?.category).toBe('security');
    expect(step0?.riskLevel).toBe('low');
  });

  it('should parse response with needs_user_approval verdict', () => {
    const response = JSON.stringify({
      verdict: 'needs_user_approval',
      overallRisk: 'high',
      reasoning: 'Shell command requires user approval.',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'needs_user_approval',
          category: 'security',
          riskLevel: 'critical',
          reasoning: 'Shell execution always requires user approval.',
        },
      ],
    });

    const result = parseValidationResponse(response);
    expect(result.verdict).toBe('needs_user_approval');
    expect(result.overallRisk).toBe('high');
  });

  it('should parse response with rejected verdict', () => {
    const response = JSON.stringify({
      verdict: 'rejected',
      overallRisk: 'critical',
      reasoning: 'Plan attempts to exfiltrate credentials.',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'rejected',
          category: 'security',
          riskLevel: 'critical',
          reasoning: 'Credential access combined with network request.',
        },
      ],
    });

    const result = parseValidationResponse(response);
    expect(result.verdict).toBe('rejected');
  });

  it('should parse response with needs_revision verdict', () => {
    const response = JSON.stringify({
      verdict: 'needs_revision',
      overallRisk: 'medium',
      reasoning: 'Plan structure has issues.',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'approved',
          category: 'policy_compliance',
          riskLevel: 'low',
          reasoning: 'Step is fine.',
        },
      ],
      suggestedRevisions: 'Add error handling for the file read step.',
    });

    const result = parseValidationResponse(response);
    expect(result.verdict).toBe('needs_revision');
    expect(result.suggestedRevisions).toBe(
      'Add error handling for the file read step.',
    );
  });

  it('should parse response wrapped in markdown code fences', () => {
    const wrapped =
      '```json\n' + createValidLLMResponse() + '\n```';

    const result = parseValidationResponse(wrapped);
    expect(result.verdict).toBe('approved');
    expect(result.stepResults).toHaveLength(1);
  });

  it('should parse response wrapped in plain code fences', () => {
    const wrapped =
      '```\n' + createValidLLMResponse() + '\n```';

    const result = parseValidationResponse(wrapped);
    expect(result.verdict).toBe('approved');
  });

  it('should parse response with surrounding text', () => {
    const withText =
      'Here is my analysis:\n' +
      createValidLLMResponse() +
      '\nThis plan looks safe.';

    const result = parseValidationResponse(withText);
    expect(result.verdict).toBe('approved');
  });

  it('should throw on non-JSON response', () => {
    expect(() => parseValidationResponse('This is not JSON')).toThrow(
      LLMProviderError,
    );
  });

  it('should throw on empty response', () => {
    expect(() => parseValidationResponse('')).toThrow(LLMProviderError);
  });

  it('should throw on array response', () => {
    expect(() => parseValidationResponse('[]')).toThrow(LLMProviderError);
  });

  it('should throw on invalid verdict', () => {
    const response = JSON.stringify({
      verdict: 'maybe',
      overallRisk: 'low',
      reasoning: 'test',
      stepResults: [],
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Invalid verdict/,
    );
  });

  it('should throw on invalid overallRisk', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'very_high',
      reasoning: 'test',
      stepResults: [],
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Invalid overallRisk/,
    );
  });

  it('should throw on missing reasoning', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'low',
      stepResults: [],
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Missing or invalid reasoning/,
    );
  });

  it('should throw on missing stepResults', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'low',
      reasoning: 'test',
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Missing or invalid stepResults/,
    );
  });

  it('should throw on invalid step verdict', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'low',
      reasoning: 'test',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'maybe_approved',
          category: 'security',
          riskLevel: 'low',
          reasoning: 'test',
        },
      ],
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Invalid step verdict/,
    );
  });

  it('should throw on invalid step riskLevel', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'low',
      reasoning: 'test',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'approved',
          category: 'security',
          riskLevel: 'extreme',
          reasoning: 'test',
        },
      ],
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Invalid riskLevel/,
    );
  });

  it('should throw on missing stepId', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'low',
      reasoning: 'test',
      stepResults: [
        {
          verdict: 'approved',
          category: 'security',
          riskLevel: 'low',
          reasoning: 'test',
        },
      ],
    });

    expect(() => parseValidationResponse(response)).toThrow(
      /Invalid stepId/,
    );
  });

  it('should handle suggestedRevisions being absent', () => {
    const result = parseValidationResponse(createValidLLMResponse());
    expect(result.suggestedRevisions).toBeUndefined();
  });

  it('should handle suggestedRevisions being non-string', () => {
    const response = JSON.stringify({
      verdict: 'approved',
      overallRisk: 'low',
      reasoning: 'test',
      stepResults: [],
      suggestedRevisions: 42,
    });

    const result = parseValidationResponse(response);
    expect(result.suggestedRevisions).toBeUndefined();
  });

  it('should parse multi-step responses', () => {
    const response = JSON.stringify({
      verdict: 'needs_user_approval',
      overallRisk: 'high',
      reasoning: 'Mixed risk levels.',
      stepResults: [
        {
          stepId: 'step-1',
          verdict: 'approved',
          category: 'security',
          riskLevel: 'low',
          reasoning: 'Safe read.',
        },
        {
          stepId: 'step-2',
          verdict: 'needs_user_approval',
          category: 'security',
          riskLevel: 'critical',
          reasoning: 'Shell execution.',
        },
        {
          stepId: 'step-3',
          verdict: 'rejected',
          category: 'composite_risk',
          riskLevel: 'critical',
          reasoning: 'Credential exfiltration pattern.',
        },
      ],
    });

    const result = parseValidationResponse(response);
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults[0]?.verdict).toBe('approved');
    expect(result.stepResults[1]?.verdict).toBe('needs_user_approval');
    expect(result.stepResults[2]?.verdict).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// checkSameProvider
// ---------------------------------------------------------------------------

describe('checkSameProvider', () => {
  it('should return warning when providers match', () => {
    const warning = checkSameProvider('anthropic', 'anthropic');

    expect(warning).toBeDefined();
    expect(warning?.scoutProvider).toBe('anthropic');
    expect(warning?.sentinelProvider).toBe('anthropic');
    expect(warning?.message).toContain('same LLM provider');
    expect(warning?.message).toContain('different providers');
  });

  it('should return null when providers differ', () => {
    const warning = checkSameProvider('anthropic', 'openai');
    expect(warning).toBeNull();
  });

  it('should return warning for same custom providers', () => {
    const warning = checkSameProvider('ollama', 'ollama');
    expect(warning).not.toBeNull();
  });

  it('should be case-sensitive', () => {
    const warning = checkSameProvider('Anthropic', 'anthropic');
    expect(warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validatePlanWithLLM
// ---------------------------------------------------------------------------

describe('validatePlanWithLLM', () => {
  it('should return a valid ValidationResult for approved plan', async () => {
    const plan = createTestPlan();
    const config = createConfig();

    const result = await validatePlanWithLLM(plan, config);

    expect(result.id).toBeDefined();
    expect(result.planId).toBe('plan-001');
    expect(result.verdict).toBe('approved');
    expect(result.overallRisk).toBe('low');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.stepId).toBe('step-1');
    expect(result.metadata).toEqual(
      expect.objectContaining({
        validatedBy: 'llm',
        model: 'test-model',
        providerId: 'test-provider',
      }),
    );
  });

  it('should send stripped plan to the LLM', async () => {
    const plan = createTestPlan();
    const mockProvider = createMockProvider(createValidLLMResponse());
    const config = createConfig({ provider: mockProvider });

    await validatePlanWithLLM(plan, config);

    // Verify the LLM was called
    expect(mockProvider.chatFn).toHaveBeenCalledTimes(1);

    // Verify the message doesn't contain stripped fields
    const chatCall = getMockCallArg(
      mockProvider.chatFn,
      0,
      0,
    ) as ChatRequest;
    const userMessage = chatCall.messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toContain('plan-001');
    expect(userMessage?.content).not.toContain('User wants to read a file');
    expect(userMessage?.content).not.toContain('scoutModel');
    expect(userMessage?.content).not.toContain('Read a test file');
  });

  it('should use low temperature for safety-critical validation', async () => {
    const plan = createTestPlan();
    const mockProvider = createMockProvider(createValidLLMResponse());
    const config = createConfig({ provider: mockProvider });

    await validatePlanWithLLM(plan, config);

    const chatCall = getMockCallArg(
      mockProvider.chatFn,
      0,
      0,
    ) as ChatRequest;
    expect(chatCall.temperature).toBe(0.1);
  });

  it('should respect custom temperature', async () => {
    const plan = createTestPlan();
    const mockProvider = createMockProvider(createValidLLMResponse());
    const config = createConfig({ provider: mockProvider, temperature: 0.3 });

    await validatePlanWithLLM(plan, config);

    const chatCall = getMockCallArg(
      mockProvider.chatFn,
      0,
      0,
    ) as ChatRequest;
    expect(chatCall.temperature).toBe(0.3);
  });

  it('should throw LLMProviderError when LLM call fails', async () => {
    const plan = createTestPlan();
    const failingProvider: LLMProvider = {
      id: 'failing-provider',
      name: 'Failing Provider',
      chat: () => {
        throw new Error('Connection refused');
      },
      estimateTokens: () => 0,
      maxContextTokens: 100_000,
    };
    const config = createConfig({ provider: failingProvider });

    await expect(validatePlanWithLLM(plan, config)).rejects.toThrow(
      LLMProviderError,
    );
  });

  it('should throw when LLM returns invalid JSON', async () => {
    const plan = createTestPlan();
    const badProvider = createMockProvider('This is not a valid JSON response');
    const config = createConfig({ provider: badProvider });

    await expect(validatePlanWithLLM(plan, config)).rejects.toThrow(
      LLMProviderError,
    );
  });

  it('should handle streaming response from LLM', async () => {
    const plan = createTestPlan();
    const response = createValidLLMResponse();

    // Simulate streaming by splitting response across chunks
    const half = Math.floor(response.length / 2);
    const chatFn = vi.fn().mockReturnValue(
      makeAsyncIterable([
        { content: response.slice(0, half), done: false },
        { content: response.slice(half), done: true },
      ]),
    );

    const streamingProvider: LLMProvider = {
      id: 'streaming-provider',
      name: 'Streaming Provider',
      chat: chatFn,
      estimateTokens: () => 0,
      maxContextTokens: 100_000,
    };
    const config = createConfig({ provider: streamingProvider });

    const result = await validatePlanWithLLM(plan, config);
    expect(result.verdict).toBe('approved');
  });

  it('should include system prompt with information barrier', async () => {
    const plan = createTestPlan();
    const mockProvider = createMockProvider(createValidLLMResponse());
    const config = createConfig({ provider: mockProvider });

    await validatePlanWithLLM(plan, config);

    const chatCall = getMockCallArg(
      mockProvider.chatFn,
      0,
      0,
    ) as ChatRequest;
    const systemMessage = chatCall.messages.find(
      (m) => m.role === 'system',
    );
    expect(systemMessage).toBeDefined();
    expect(systemMessage?.content).toContain('Information Barrier');
    expect(systemMessage?.content).toContain('Sentinel');
  });

  it('should log validation events', async () => {
    const plan = createTestPlan();
    const logger = createMockLogger();
    const config = createConfig({ logger });

    await validatePlanWithLLM(plan, config);

    expect(logger._debugFn).toHaveBeenCalledWith(
      'Sending stripped plan to LLM for validation',
      expect.objectContaining({ planId: 'plan-001' }),
    );
    expect(logger._infoFn).toHaveBeenCalledWith(
      'LLM plan validation complete',
      expect.objectContaining({
        planId: 'plan-001',
        verdict: 'approved',
      }),
    );
  });

  it('should pass abort signal to LLM provider', async () => {
    const plan = createTestPlan();
    const mockProvider = createMockProvider(createValidLLMResponse());
    const config = createConfig({ provider: mockProvider });
    const signal = AbortSignal.timeout(5000);

    await validatePlanWithLLM(plan, config, signal);

    const chatCall = getMockCallArg(
      mockProvider.chatFn,
      0,
      0,
    ) as ChatRequest;
    expect(chatCall.signal).toBe(signal);
  });
});
