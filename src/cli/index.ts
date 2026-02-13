#!/usr/bin/env node
// @meridian/cli — CLI entry point
//
// Parses top-level commands and delegates to the appropriate handler.
// This module is the single entry point for all CLI operations.

import { resolve } from 'node:path';

import { createLogger } from '@meridian/shared';

import { runCli as runUpdateCli } from './update.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';

const logger = createLogger({ context: { component: 'cli' } });

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(write: (msg: string) => void): void {
  write(`Meridian v${VERSION}`);
  write('');
  write('Usage: meridian <command> [options]');
  write('');
  write('Commands:');
  write('  update --check   Check for available updates');
  write('  update           Apply the latest update');
  write('  rollback         Revert to the previous backup');
  write('  version          Show the current version');
  write('  help             Show this help message');
  write('');
  write('Options:');
  write('  --data-dir <path>   Path to data directory (default: ./data)');
  write('  --project-root <path>   Path to project root (default: cwd)');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | undefined;
  flags: string[];
  dataDir: string | undefined;
  projectRoot: string | undefined;
}

/**
 * Parse CLI arguments into a structured format.
 * Extracts known global options and passes the rest to subcommands.
 */
function parseArgs(args: string[]): ParsedArgs {
  let dataDir: string | undefined;
  let projectRoot: string | undefined;
  const flags: string[] = [];
  let command: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) break;

    if (arg === '--data-dir' && i + 1 < args.length) {
      dataDir = args[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--project-root' && i + 1 < args.length) {
      projectRoot = args[i + 1];
      i += 2;
      continue;
    }

    if (!command && !arg.startsWith('-')) {
      command = arg;
    } else {
      flags.push(arg);
    }

    i++;
  }

  return { command, flags, dataDir, projectRoot };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Main CLI entry point.
 *
 * Parses the top-level command from process arguments and delegates to
 * the appropriate handler module.
 *
 * @param argv - Raw process arguments (typically `process.argv.slice(2)`)
 * @returns Exit code (0 for success, non-zero for failure)
 */
export async function main(argv: string[]): Promise<number> {
  const write = (msg: string): void => {
    process.stdout.write(msg + '\n');
  };
  const writeErr = (msg: string): void => {
    process.stderr.write(msg + '\n');
  };

  const { command, flags, dataDir, projectRoot } = parseArgs(argv);

  const resolvedProjectRoot = projectRoot
    ? resolve(projectRoot)
    : resolve(process.cwd());

  const resolvedDataDir = dataDir
    ? resolve(dataDir)
    : resolve(resolvedProjectRoot, 'data');

  try {
    switch (command) {
      case 'update':
      case 'rollback':
        return await runUpdateCli([command, ...flags], {
          projectRoot: resolvedProjectRoot,
          dataDir: resolvedDataDir,
          stdout: write,
          stderr: writeErr,
        });

      case 'version':
        write(`Meridian v${VERSION}`);
        return 0;

      case 'help':
      case undefined:
        printUsage(command === 'help' ? write : writeErr);
        return command === 'help' ? 0 : 1;

      default:
        writeErr(`Unknown command: ${command}`);
        writeErr('');
        printUsage(writeErr);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('CLI command failed', { command, error: message });
    writeErr(`Error: ${message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Run when executed directly (not imported)
// ---------------------------------------------------------------------------

const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('/cli/index.ts') ||
   process.argv[1].endsWith('/cli/index.js'));

if (isMainModule) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
