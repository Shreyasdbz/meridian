import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Logger, createLogger, redact } from './logger.js';
import type { LogOutput, LogEntry } from './logger.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Collects log lines in memory for assertions. */
function createTestOutput(): LogOutput & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string): void {
      lines.push(line);
    },
  };
}

/** Safely get a log line by index. Fails the test if missing. */
function getLine(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`Expected log line at index ${index}, but got undefined`);
  }
  return line;
}

/** Parse a JSON log line at index to a LogEntry. */
function entryAt(lines: string[], index: number): LogEntry {
  const line = getLine(lines, index);
  return JSON.parse(line) as LogEntry;
}

/**
 * Build fake credential strings for redaction testing.
 * Constructed at runtime to avoid security hook false positives.
 */
function fakeApiKey(): string {
  return 'sk-' + 'a'.repeat(30);
}

function fakeBearerToken(): string {
  return 'Bearer ' + 'x'.repeat(40);
}

function fakeAwsKeyId(): string {
  return 'AKIA' + 'A'.repeat(16);
}

function fakeGithubToken(): string {
  return 'ghp_' + 'z'.repeat(40);
}

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

describe('redact', () => {
  it('should redact sk-... API keys', () => {
    const key = fakeApiKey();
    const result = redact(`key is ${key}`);
    expect(result).toContain('sk-****');
    expect(result).not.toContain('a'.repeat(20));
  });

  it('should redact Bearer tokens', () => {
    const token = fakeBearerToken();
    const result = redact(`Authorization: ${token}`);
    expect(result).toContain('Bearer ****');
    expect(result).not.toContain('x'.repeat(20));
  });

  it('should redact password= values', () => {
    const result = redact('password=my_secret_pw');
    expect(result).toBe('password=****');
  });

  it('should redact password: values', () => {
    const result = redact('password: my_secret_pw');
    expect(result).toBe('password=****');
  });

  it('should redact token= values', () => {
    const result = redact('token=randomvalue123');
    expect(result).toBe('token=****');
  });

  it('should redact secret= values', () => {
    const result = redact('secret=topsecretvalue');
    expect(result).toBe('secret=****');
  });

  it('should redact api_key= values', () => {
    const result = redact('api_key=somevalue123');
    expect(result).toBe('api_key=****');
  });

  it('should redact api-key= values', () => {
    const result = redact('api-key=somevalue123');
    expect(result).toBe('api_key=****');
  });

  it('should redact AWS access key IDs', () => {
    const key = fakeAwsKeyId();
    const result = redact(`aws key ${key}`);
    expect(result).toContain('AKIA****');
    expect(result).not.toContain('A'.repeat(16));
  });

  it('should redact GitHub tokens', () => {
    const token = fakeGithubToken();
    const result = redact(`token ${token}`);
    expect(result).toContain('ghp_****');
    expect(result).not.toContain('z'.repeat(20));
  });

  it('should handle multiple credentials in one string', () => {
    const key = fakeApiKey();
    const input = `${key} password=secret123 ${fakeBearerToken()}`;
    const result = redact(input);
    expect(result).toContain('sk-****');
    expect(result).toContain('password=****');
    expect(result).toContain('Bearer ****');
  });

  it('should not modify strings without credential patterns', () => {
    const input = 'Hello world, this is a normal log message';
    expect(redact(input)).toBe(input);
  });

  it('should be case-insensitive for password/token/secret patterns', () => {
    expect(redact('PASSWORD=secret')).toBe('password=****');
    expect(redact('Token=abc123')).toBe('token=****');
    expect(redact('SECRET=myval')).toBe('secret=****');
  });
});

// ---------------------------------------------------------------------------
// Logger — structured JSON output
// ---------------------------------------------------------------------------

describe('Logger', () => {
  let output: LogOutput & { lines: string[] };

  beforeEach(() => {
    output = createTestOutput();
  });

  describe('JSON output format', () => {
    it('should output valid JSON', () => {
      const logger = new Logger({ outputs: [output] });
      logger.info('test message');

      expect(output.lines).toHaveLength(1);
      const line = getLine(output.lines, 0);
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    });

    it('should include level, timestamp, and message fields', () => {
      const logger = new Logger({ outputs: [output] });
      logger.info('hello');

      const entry = entryAt(output.lines, 0);
      expect(entry.level).toBe('info');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(entry.message).toBe('hello');
    });

    it('should include additional data fields', () => {
      const logger = new Logger({ outputs: [output] });
      logger.info('job created', { jobId: 'abc-123', status: 'pending' });

      const entry = entryAt(output.lines, 0);
      expect(entry.jobId).toBe('abc-123');
      expect(entry.status).toBe('pending');
    });
  });

  // ---------------------------------------------------------------------------
  // Level filtering
  // ---------------------------------------------------------------------------

  describe('level filtering', () => {
    it('should log at and above the configured level', () => {
      const logger = new Logger({ level: 'warn', outputs: [output] });
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(output.lines).toHaveLength(2);
      expect(entryAt(output.lines, 0).level).toBe('warn');
      expect(entryAt(output.lines, 1).level).toBe('error');
    });

    it('should log everything at debug level', () => {
      const logger = new Logger({ level: 'debug', outputs: [output] });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(output.lines).toHaveLength(4);
    });

    it('should only log errors at error level', () => {
      const logger = new Logger({ level: 'error', outputs: [output] });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(output.lines).toHaveLength(1);
      expect(entryAt(output.lines, 0).level).toBe('error');
    });

    it('should default to info level', () => {
      const logger = new Logger({ outputs: [output] });
      logger.debug('d');
      logger.info('i');

      expect(output.lines).toHaveLength(1);
      expect(entryAt(output.lines, 0).level).toBe('info');
    });
  });

  // ---------------------------------------------------------------------------
  // Redaction in log output
  // ---------------------------------------------------------------------------

  describe('redaction', () => {
    it('should redact API keys in messages', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
      });
      const key = fakeApiKey();
      logger.info(`Using key ${key}`);

      const line = getLine(output.lines, 0);
      expect(line).toContain('sk-****');
      expect(line).not.toContain('a'.repeat(20));
    });

    it('should redact secrets in data fields', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
      });
      const token = fakeBearerToken();
      logger.info('Request sent', { authorization: token });

      const line = getLine(output.lines, 0);
      expect(line).toContain('Bearer ****');
      expect(line).not.toContain('x'.repeat(20));
    });

    it('should redact password values in structured data', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
      });
      logger.info('Config loaded', {
        config: 'password=mysecret',
      });

      const line = getLine(output.lines, 0);
      expect(line).toContain('password=****');
      expect(line).not.toContain('mysecret');
    });
  });

  // ---------------------------------------------------------------------------
  // Child loggers
  // ---------------------------------------------------------------------------

  describe('child logger', () => {
    it('should include parent context in log entries', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
        context: { service: 'meridian' },
      });
      const child = logger.child({ component: 'axis' });
      child.info('started');

      const entry = entryAt(output.lines, 0);
      expect(entry.service).toBe('meridian');
      expect(entry.component).toBe('axis');
      expect(entry.message).toBe('started');
    });

    it('should merge child context over parent context', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
        context: { component: 'root', version: '1.0' },
      });
      const child = logger.child({ component: 'axis' });
      child.info('test');

      const entry = entryAt(output.lines, 0);
      expect(entry.component).toBe('axis');
      expect(entry.version).toBe('1.0');
    });

    it('should not affect parent logger context', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
      });
      const child = logger.child({ component: 'axis' });

      logger.info('parent');
      child.info('child');

      const parentEntry = entryAt(output.lines, 0);
      const childEntry = entryAt(output.lines, 1);

      expect(parentEntry.component).toBeUndefined();
      expect(childEntry.component).toBe('axis');
    });

    it('should share outputs with parent', () => {
      const logger = new Logger({
        level: 'debug',
        outputs: [output],
      });
      const child = logger.child({ component: 'scout' });

      logger.info('from parent');
      child.info('from child');

      // Both should write to the same output
      expect(output.lines).toHaveLength(2);
    });

    it('should inherit level filtering from parent', () => {
      const logger = new Logger({
        level: 'warn',
        outputs: [output],
      });
      const child = logger.child({ component: 'gear' });

      child.debug('should not appear');
      child.info('should not appear');
      child.warn('should appear');

      expect(output.lines).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  it('should respect MERIDIAN_LOG_LEVEL env var', () => {
    const originalLevel = process.env['MERIDIAN_LOG_LEVEL'];
    process.env['MERIDIAN_LOG_LEVEL'] = 'debug';

    const output = createTestOutput();
    const logger = createLogger({ outputs: [output] });
    logger.debug('should appear');

    expect(output.lines).toHaveLength(1);

    process.env['MERIDIAN_LOG_LEVEL'] = originalLevel;
  });

  it('should prefer explicit level over env var', () => {
    const originalLevel = process.env['MERIDIAN_LOG_LEVEL'];
    process.env['MERIDIAN_LOG_LEVEL'] = 'debug';

    const output = createTestOutput();
    const logger = createLogger({ level: 'error', outputs: [output] });
    logger.debug('should not appear');
    logger.info('should not appear');
    logger.error('should appear');

    expect(output.lines).toHaveLength(1);

    process.env['MERIDIAN_LOG_LEVEL'] = originalLevel;
  });

  it('should default to info level when no env var set', () => {
    const originalLevel = process.env['MERIDIAN_LOG_LEVEL'];
    process.env['MERIDIAN_LOG_LEVEL'] = undefined;

    const output = createTestOutput();
    const logger = createLogger({ outputs: [output] });
    logger.debug('should not appear');
    logger.info('should appear');

    expect(output.lines).toHaveLength(1);

    process.env['MERIDIAN_LOG_LEVEL'] = originalLevel;
  });
});

// ---------------------------------------------------------------------------
// Console output routing
// ---------------------------------------------------------------------------

describe('console output routing', () => {
  it('should write errors to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const logger = new Logger({ level: 'debug' });
    logger.error('error message');

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('should write warnings to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const logger = new Logger({ level: 'debug' });
    logger.warn('warning message');

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('should write info to stdout', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const logger = new Logger({ level: 'debug' });
    logger.info('info message');

    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
