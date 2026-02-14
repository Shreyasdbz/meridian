// @meridian/scout — ModelRouter tests (Phase 11.1)

import { describe, expect, it, vi } from 'vitest';

import { classifyTaskComplexity, ModelRouter, selectModelTier } from './model-router.js';

// ---------------------------------------------------------------------------
// classifyTaskComplexity
// ---------------------------------------------------------------------------

describe('classifyTaskComplexity', () => {
  it('should return replanning when hasFailureState is true', () => {
    const result = classifyTaskComplexity({
      userMessage: 'send an email',
      hasFailureState: true,
    });
    expect(result).toBe('replanning');
  });

  it('should return complex_reasoning when forceFullPath is true', () => {
    const result = classifyTaskComplexity({
      userMessage: 'hello',
      forceFullPath: true,
    });
    expect(result).toBe('complex_reasoning');
  });

  it('should prioritize hasFailureState over forceFullPath', () => {
    const result = classifyTaskComplexity({
      userMessage: 'hello',
      hasFailureState: true,
      forceFullPath: true,
    });
    expect(result).toBe('replanning');
  });

  it('should classify multi-step tasks with "then" and "and"', () => {
    const result = classifyTaskComplexity({
      userMessage: 'First check my email then send a reply and also update the spreadsheet',
    });
    expect(result).toBe('multi_step_planning');
  });

  it('should classify multi-step tasks with "after that"', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Download the file, after that convert it to PDF',
    });
    expect(result).toBe('multi_step_planning');
  });

  it('should classify multi-step tasks with "and then"', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Read the CSV and then create a chart from the data',
    });
    expect(result).toBe('multi_step_planning');
  });

  it('should classify summarization tasks', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Summarize the report from yesterday',
    });
    expect(result).toBe('summarization');
  });

  it('should classify tl;dr requests as summarization', () => {
    const result = classifyTaskComplexity({
      userMessage: 'tl;dr of the meeting notes',
    });
    expect(result).toBe('summarization');
  });

  it('should classify parsing/extraction tasks', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Extract all email addresses from this document',
    });
    expect(result).toBe('parsing');
  });

  it('should classify conversion tasks as parsing', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Convert this JSON to CSV format',
    });
    expect(result).toBe('parsing');
  });

  it('should classify simple Gear operations like sending email', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Send an email to the team about the update',
    });
    expect(result).toBe('simple_gear_op');
  });

  it('should classify file listing as simple Gear op', () => {
    const result = classifyTaskComplexity({
      userMessage: 'List files in the downloads folder',
    });
    expect(result).toBe('simple_gear_op');
  });

  it('should classify short greetings as parameter_generation', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Hello!',
    });
    expect(result).toBe('parameter_generation');
  });

  it('should classify short questions as parameter_generation', () => {
    const result = classifyTaskComplexity({
      userMessage: 'What time is it?',
    });
    expect(result).toBe('parameter_generation');
  });

  it('should classify longer questions as summarization', () => {
    const result = classifyTaskComplexity({
      userMessage: 'What are the differences between Python and JavaScript for web development?',
    });
    expect(result).toBe('summarization');
  });

  it('should default to novel_request for ambiguous long messages', () => {
    const result = classifyTaskComplexity({
      userMessage: 'I need help with something complex that involves multiple systems and integrations across the platform with various custom configurations that have not been set up before and require careful consideration of edge cases and error handling strategies.',
    });
    expect(result).toBe('novel_request');
  });

  it('should default to novel_request for medium ambiguous messages', () => {
    const result = classifyTaskComplexity({
      userMessage: 'Deploy the latest changes to production',
    });
    expect(result).toBe('novel_request');
  });
});

// ---------------------------------------------------------------------------
// selectModelTier
// ---------------------------------------------------------------------------

describe('selectModelTier', () => {
  it('should select secondary for simple_gear_op', () => {
    expect(selectModelTier('simple_gear_op')).toBe('secondary');
  });

  it('should select secondary for summarization', () => {
    expect(selectModelTier('summarization')).toBe('secondary');
  });

  it('should select secondary for parsing', () => {
    expect(selectModelTier('parsing')).toBe('secondary');
  });

  it('should select secondary for parameter_generation', () => {
    expect(selectModelTier('parameter_generation')).toBe('secondary');
  });

  it('should select primary for multi_step_planning', () => {
    expect(selectModelTier('multi_step_planning')).toBe('primary');
  });

  it('should select primary for complex_reasoning', () => {
    expect(selectModelTier('complex_reasoning')).toBe('primary');
  });

  it('should select primary for replanning', () => {
    expect(selectModelTier('replanning')).toBe('primary');
  });

  it('should select primary for novel_request', () => {
    expect(selectModelTier('novel_request')).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// ModelRouter
// ---------------------------------------------------------------------------

describe('ModelRouter', () => {
  const PRIMARY_MODEL = 'claude-sonnet-4-5-20250929';
  const SECONDARY_MODEL = 'claude-haiku-4-5-20251001';

  function createRouter(logger?: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }): ModelRouter {
    return new ModelRouter({
      primaryModel: PRIMARY_MODEL,
      secondaryModel: SECONDARY_MODEL,
      logger,
    });
  }

  describe('route', () => {
    it('should route simple greetings to secondary model', () => {
      const router = createRouter();
      const decision = router.route({ userMessage: 'Hello!' });

      expect(decision.tier).toBe('secondary');
      expect(decision.model).toBe(SECONDARY_MODEL);
      expect(decision.taskComplexity).toBe('parameter_generation');
      expect(decision.reason).toContain('secondary');
    });

    it('should route multi-step tasks to primary model', () => {
      const router = createRouter();
      const decision = router.route({
        userMessage: 'Check my inbox then forward important emails and also create a summary',
      });

      expect(decision.tier).toBe('primary');
      expect(decision.model).toBe(PRIMARY_MODEL);
      expect(decision.taskComplexity).toBe('multi_step_planning');
    });

    it('should route replanning to primary model', () => {
      const router = createRouter();
      const decision = router.route({
        userMessage: 'Send an email',
        hasFailureState: true,
      });

      expect(decision.tier).toBe('primary');
      expect(decision.model).toBe(PRIMARY_MODEL);
      expect(decision.taskComplexity).toBe('replanning');
    });

    it('should route novel requests to primary model', () => {
      const router = createRouter();
      const decision = router.route({
        userMessage: 'Deploy the latest changes to production',
      });

      expect(decision.tier).toBe('primary');
      expect(decision.model).toBe(PRIMARY_MODEL);
      expect(decision.taskComplexity).toBe('novel_request');
    });

    it('should route summarization to secondary model', () => {
      const router = createRouter();
      const decision = router.route({
        userMessage: 'Summarize the quarterly report',
      });

      expect(decision.tier).toBe('secondary');
      expect(decision.model).toBe(SECONDARY_MODEL);
      expect(decision.taskComplexity).toBe('summarization');
    });

    it('should log routing decisions when logger is provided', () => {
      const logger = { info: vi.fn(), debug: vi.fn() };
      const router = createRouter(logger);

      router.route({ userMessage: 'Hello!', jobId: 'job-123' });

      expect(logger.debug).toHaveBeenCalledWith(
        'Model routing decision',
        expect.objectContaining({
          jobId: 'job-123',
          tier: 'secondary',
          model: SECONDARY_MODEL,
        }),
      );
    });

    it('should include jobId in log metadata', () => {
      const logger = { info: vi.fn(), debug: vi.fn() };
      const router = createRouter(logger);

      router.route({ userMessage: 'test', jobId: 'job-abc' });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ jobId: 'job-abc' }),
      );
    });
  });
});
