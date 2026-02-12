// @meridian/shared — Structured JSON logging with sensitive data redaction

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  [key: string]: unknown;
}

/** Pluggable output target for log entries. */
export interface LogOutput {
  write(line: string): void;
  close?(): void;
}

export interface LoggerOptions {
  /** Minimum log level. Default: 'info' */
  level?: LogLevel;
  /** Base context fields merged into every log entry. */
  context?: Record<string, unknown>;
  /** Path to log file. Enables file output with daily rotation. */
  filePath?: string;
  /** Days to retain rotated log files. Default: 7 */
  retentionDays?: number;
  /** Custom outputs — overrides default console output when provided. */
  outputs?: LogOutput[];
}

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// ---------------------------------------------------------------------------
// Sensitive data redaction patterns
// ---------------------------------------------------------------------------

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const REDACTION_RULES: RedactionRule[] = [
  // OpenAI / Anthropic API keys (sk-...)
  { pattern: /sk-[A-Za-z0-9_-]{10,}/g, replacement: 'sk-****' },
  // Bearer tokens
  {
    pattern: /Bearer\s+[A-Za-z0-9._\-/+=]{8,}/g,
    replacement: 'Bearer ****',
  },
  // password= or password: values
  { pattern: /password[=:]\s*\S+/gi, replacement: 'password=****' },
  // token= or token: values
  { pattern: /token[=:]\s*\S+/gi, replacement: 'token=****' },
  // secret= or secret: values
  { pattern: /secret[=:]\s*\S+/gi, replacement: 'secret=****' },
  // api_key= or apikey= or api-key= values
  { pattern: /api[_-]?key[=:]\s*\S+/gi, replacement: 'api_key=****' },
  // AWS access key IDs
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA****' },
  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, replacement: 'ghp_****' },
  { pattern: /gho_[A-Za-z0-9]{36,}/g, replacement: 'gho_****' },
];

/** Apply all redaction rules to a string. */
export function redact(input: string): string {
  let result = input;
  for (const rule of REDACTION_RULES) {
    // Reset lastIndex for global regex reuse
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

class ConsoleOutput implements LogOutput {
  write(line: string): void {
    try {
      const parsed = JSON.parse(line) as LogEntry;
      if (parsed.level === 'error' || parsed.level === 'warn') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    } catch {
      process.stdout.write(line + '\n');
    }
  }
}

// ---------------------------------------------------------------------------
// File output with daily rotation
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_DAYS = 7;

class FileOutput implements LogOutput {
  private readonly filePath: string;
  private readonly retentionDays: number;
  private currentDate: string;

  constructor(filePath: string, retentionDays: number) {
    this.filePath = filePath;
    this.retentionDays = retentionDays;
    this.currentDate = todayDateString();

    // Ensure log directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Rotate stale file from a previous day
    this.rotateStaleFile();

    // Clean up old rotated files
    this.cleanupOldFiles();
  }

  write(line: string): void {
    const today = todayDateString();
    if (today !== this.currentDate) {
      this.rotate(this.currentDate);
      this.currentDate = today;
      this.cleanupOldFiles();
    }

    appendFileSync(this.filePath, line + '\n', 'utf-8');
  }

  close(): void {
    // No persistent handle to close with appendFileSync
  }

  private rotateStaleFile(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const stat = statSync(this.filePath);
      const fileDate = stat.mtime.toISOString().slice(0, 10);
      if (fileDate < this.currentDate) {
        this.rotate(fileDate);
      }
    } catch {
      // If we can't stat the file, just continue
    }
  }

  private rotate(date: string): void {
    if (!existsSync(this.filePath)) return;

    const dir = dirname(this.filePath);
    const base = this.filePath.slice(
      this.filePath.lastIndexOf('/') + 1,
      this.filePath.lastIndexOf('.'),
    );
    const ext = this.filePath.slice(this.filePath.lastIndexOf('.'));
    const rotatedPath = join(dir, `${base}-${date}${ext}`);

    try {
      renameSync(this.filePath, rotatedPath);
    } catch {
      // If rename fails (e.g., cross-device), just continue
    }
  }

  private cleanupOldFiles(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) return;

    const base = this.filePath.slice(
      this.filePath.lastIndexOf('/') + 1,
      this.filePath.lastIndexOf('.'),
    );
    const ext = this.filePath.slice(this.filePath.lastIndexOf('.'));
    const pattern = new RegExp(`^${escapeRegex(base)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegex(ext)}$`);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        const match = pattern.exec(file);
        if (match?.[1] && match[1] < cutoffStr) {
          try {
            unlinkSync(join(dir, file));
          } catch {
            // Best-effort cleanup
          }
        }
      }
    } catch {
      // If we can't read the directory, skip cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  private readonly level: LogLevel;
  private readonly context: Record<string, unknown>;
  private readonly outputs: LogOutput[];

  constructor(options?: LoggerOptions) {
    this.level = options?.level ?? 'info';
    this.context = options?.context ?? {};

    if (options?.outputs) {
      this.outputs = options.outputs;
    } else {
      const outputs: LogOutput[] = [new ConsoleOutput()];
      if (options?.filePath) {
        outputs.push(
          new FileOutput(options.filePath, options.retentionDays ?? DEFAULT_RETENTION_DAYS),
        );
      }
      this.outputs = outputs;
    }
  }

  /** Create a child logger with additional context fields. */
  child(context: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      context: { ...this.context, ...context },
      outputs: this.outputs,
    });
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  /** Flush and close all outputs. Call during graceful shutdown. */
  close(): void {
    for (const output of this.outputs) {
      output.close?.();
    }
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[this.level]) return;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...this.context,
      ...data,
    };

    // Serialize to JSON then redact sensitive patterns
    const raw = JSON.stringify(entry);
    const safe = redact(raw);

    for (const output of this.outputs) {
      output.write(safe);
    }
  }
}

/**
 * Create a root logger.
 *
 * Reads `MERIDIAN_LOG_LEVEL` env var if no level is specified.
 */
export function createLogger(options?: LoggerOptions): Logger {
  const envLevel = process.env['MERIDIAN_LOG_LEVEL'] as LogLevel | undefined;
  const level = options?.level ?? (envLevel && envLevel in LEVEL_PRIORITY ? envLevel : 'info');

  return new Logger({ ...options, level });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
