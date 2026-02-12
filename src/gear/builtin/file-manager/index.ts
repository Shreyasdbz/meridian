// @meridian/gear/builtin/file-manager — File operations within the workspace (Phase 5.4)
//
// Built-in Gear providing read, write, list, search, and delete file operations.
// All paths are relative to the workspace root and validated by the GearContext
// to prevent directory traversal.
//
// Actions:
//   read_file   — Read file contents at given path
//   write_file  — Write content to file at given path (creates directories)
//   list_files  — Recursive directory listing with optional glob filter
//   search_files — Text search within files (grep-like)
//   delete_file — Delete file (high risk, always requires approval)
//
// Architecture references:
//   - Section 5.6.2 (Gear Manifest)
//   - Section 9.3 (GearContext API)
//   - Implementation Plan Phase 5.4

import type { GearContext } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
}

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

// ---------------------------------------------------------------------------
// Parameter extraction helpers
// ---------------------------------------------------------------------------

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Parameter "${name}" is required and must be a string`);
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  name: string,
  defaultValue: string,
): string {
  const value = params[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'string') {
    throw new Error(`Parameter "${name}" must be a string`);
  }
  return value;
}

function optionalNumber(
  params: Record<string, unknown>,
  name: string,
  defaultValue: number,
): number {
  const value = params[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number') {
    throw new Error(`Parameter "${name}" must be a number`);
  }
  return value;
}

function optionalStringOrUndefined(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Parameter "${name}" must be a string`);
  }
  return value;
}

function optionalBoolean(
  params: Record<string, unknown>,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = params[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Parameter "${name}" must be a boolean`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Read file contents at a given path within the workspace.
 * Supports utf-8 text and base64-encoded binary.
 */
async function readFile(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const path = requireString(context.params, 'path');
  const encoding = optionalString(context.params, 'encoding', 'utf-8');

  // Canonicalize and reject traversal — done by GearContext.readFile()
  const buffer = await context.readFile(path);

  const content = encoding === 'base64'
    ? buffer.toString('base64')
    : buffer.toString('utf-8');

  return {
    content,
    size: buffer.length,
    encoding,
  };
}

/**
 * Write content to a file at a given path within the workspace.
 * Creates parent directories if needed.
 */
async function writeFile(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const path = requireString(context.params, 'path');
  const content = requireString(context.params, 'content');
  const encoding = optionalString(context.params, 'encoding', 'utf-8');

  const buffer = encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf-8');

  // Path validation and directory creation handled by GearContext.writeFile()
  await context.writeFile(path, buffer);

  return {
    path,
    size: buffer.length,
  };
}

/**
 * List files and directories within the workspace.
 * Supports optional glob filtering and recursive traversal.
 */
async function listFiles(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const basePath = optionalString(context.params, 'path', '.');
  const globPattern = optionalStringOrUndefined(context.params, 'glob');
  const recursive = optionalBoolean(context.params, 'recursive', true);

  const entries: FileEntry[] = [];

  await listDir(context, basePath, entries, recursive, globPattern);

  return {
    files: entries,
    count: entries.length,
  };
}

/**
 * Recursively list directory contents, collecting entries.
 */
async function listDir(
  context: GearContext,
  dirPath: string,
  entries: FileEntry[],
  recursive: boolean,
  globPattern: string | undefined,
): Promise<void> {
  let items: string[];
  try {
    items = await context.listFiles(dirPath);
  } catch {
    // Directory might not exist or not be readable
    return;
  }

  for (const item of items) {
    const isDirectory = item.endsWith('/');
    const name = isDirectory ? item.slice(0, -1) : item;
    const fullPath = dirPath === '.' ? name : `${dirPath}/${name}`;

    // When glob filtering, only include matching files (directories excluded
    // from results). Without glob, include all entries.
    if (globPattern) {
      if (!isDirectory && matchGlob(fullPath, globPattern)) {
        entries.push({ path: fullPath, isDirectory });
      }
    } else {
      entries.push({ path: fullPath, isDirectory });
    }

    if (isDirectory && recursive) {
      await listDir(context, fullPath, entries, recursive, globPattern);
    }
  }
}

/**
 * Simple glob matching for file filtering.
 * Supports *, **, and ? patterns.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === '*') {
      if (pattern.charAt(i + 1) === '*') {
        // ** matches any path segments
        regex += '.*';
        i += 1;
        // Skip trailing slash after **
        if (pattern.charAt(i + 1) === '/') i += 1;
        continue;
      }
      // * matches anything except /
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else if (char === '.') {
      regex += '\\.';
    } else {
      regex += char;
    }
  }
  regex += '$';

  try {
    return new RegExp(regex).test(filePath);
  } catch {
    return false;
  }
}

/**
 * Search for text patterns within files (grep-like functionality).
 * Returns matching lines with file path and line number.
 */
async function searchFiles(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const pattern = requireString(context.params, 'pattern');
  const basePath = optionalString(context.params, 'path', '.');
  const globPattern = optionalStringOrUndefined(context.params, 'glob');
  const maxResults = optionalNumber(context.params, 'maxResults', 100);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    // Fall back to literal string matching if the pattern is not valid regex
    regex = new RegExp(escapeRegex(pattern), 'g');
  }

  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let truncated = false;

  // Collect all files to search
  const fileEntries: FileEntry[] = [];
  await listDir(context, basePath, fileEntries, true, globPattern);

  // Search through each file, continuing to count all matches even after
  // maxResults is reached so totalMatches reflects the true count.
  for (const entry of fileEntries) {
    if (entry.isDirectory) continue;

    let content: string;
    try {
      const buffer = await context.readFile(entry.path);
      content = buffer.toString('utf-8');
    } catch {
      // Skip files that can't be read (e.g., binary files)
      continue;
    }

    // Skip likely binary files
    if (isBinary(content)) continue;

    const lines = content.split('\n');
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum] ?? '';
      regex.lastIndex = 0;
      if (regex.test(line)) {
        totalMatches++;
        if (matches.length < maxResults) {
          matches.push({
            file: entry.path,
            line: lineNum + 1, // 1-indexed
            content: line.length > 500 ? line.slice(0, 500) + '...' : line,
          });
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    matches,
    totalMatches,
    truncated,
  };
}

/**
 * Escape special regex characters for literal matching.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Simple heuristic to detect binary content.
 * Checks for null bytes in the first 8KB.
 */
function isBinary(content: string): boolean {
  const sample = content.slice(0, 8192);
  return sample.includes('\0');
}

/**
 * Delete a file within the workspace.
 * This is a high-risk operation that always requires user approval
 * (enforced by Sentinel via the riskLevel: 'high' in the manifest).
 */
async function deleteFile(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const path = requireString(context.params, 'path');

  // Verify file exists by trying to read it.
  // GearContext.readFile() validates the path against manifest permissions.
  try {
    await context.readFile(path);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Re-throw permission errors as-is
    if (message.includes('denied') || message.includes('outside workspace')) {
      throw e;
    }
    throw new Error(`File not found: ${path}`);
  }

  // GearContext.deleteFile() validates write permissions and performs the unlink.
  // Added in Phase 5.4 to support file-manager's delete_file action.
  await context.deleteFile(path);

  return {
    deleted: true,
    path,
  };
}

// ---------------------------------------------------------------------------
// Gear entry point
// ---------------------------------------------------------------------------

/**
 * Execute a file-manager action.
 *
 * This is the standard Gear entry point called by gear-runtime.ts.
 * The GearContext enforces all manifest permissions (filesystem boundaries,
 * path traversal prevention).
 *
 * @param context - The constrained GearContext with action parameters
 * @param action - The action name to execute
 * @returns Action result
 */
export async function execute(
  context: GearContext,
  action: string,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'read_file':
      return readFile(context);
    case 'write_file':
      return writeFile(context);
    case 'list_files':
      return listFiles(context);
    case 'search_files':
      return searchFiles(context);
    case 'delete_file':
      return deleteFile(context);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
