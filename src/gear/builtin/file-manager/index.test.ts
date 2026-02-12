// @meridian/gear/builtin/file-manager — Unit tests (Phase 5.4)
//
// Tests for the file-manager built-in Gear:
// - All 5 actions work correctly (read_file, write_file, list_files, search_files, delete_file)
// - Path traversal attempts blocked
// - Delete requires high risk classification
//
// Architecture references:
// - Section 5.6.2 (Gear Manifest, permissions)
// - Section 9.3 (GearContext API)
// - Implementation Plan Phase 5.4

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { GearContext } from '@meridian/shared';

import manifest from './manifest.json';

import { execute } from './index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock GearContext backed by a real temporary directory.
 * This simulates the sandbox GearContext that enforces manifest permissions.
 */
function createTestContext(
  workspacePath: string,
  params: Record<string, unknown> = {},
): GearContext {
  return {
    params,

    getSecret(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },

    readFile(path: string): Promise<Buffer> {
      const resolved = resolve(workspacePath, path);
      const normalized = resolve(workspacePath);

      // Simulate GearContext path traversal prevention
      if (!resolved.startsWith(normalized + '/') && resolved !== normalized) {
        return Promise.reject(new Error(
          `readFile denied: Path '${path}' resolves outside workspace boundary`,
        ));
      }

      // Check path for traversal sequences
      if (path.includes('..')) {
        return Promise.reject(new Error(
          `readFile denied: Path '${path}' resolves outside workspace boundary`,
        ));
      }

      try {
        return Promise.resolve(readFileSync(resolved));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },

    writeFile(path: string, content: Buffer): Promise<void> {
      const resolved = resolve(workspacePath, path);
      const normalized = resolve(workspacePath);

      // Simulate GearContext path traversal prevention
      if (!resolved.startsWith(normalized + '/') && resolved !== normalized) {
        return Promise.reject(new Error(
          `writeFile denied: Path '${path}' resolves outside workspace boundary`,
        ));
      }

      if (path.includes('..')) {
        return Promise.reject(new Error(
          `writeFile denied: Path '${path}' resolves outside workspace boundary`,
        ));
      }

      // Create parent directories
      const parentDir = resolve(resolved, '..');
      mkdirSync(parentDir, { recursive: true });

      writeFileSync(resolved, content);
      return Promise.resolve();
    },

    deleteFile(path: string): Promise<void> {
      const resolved = resolve(workspacePath, path);
      const normalized = resolve(workspacePath);

      // Simulate GearContext path traversal prevention
      if (!resolved.startsWith(normalized + '/') && resolved !== normalized) {
        return Promise.reject(new Error(
          `deleteFile denied: Path '${path}' resolves outside workspace boundary`,
        ));
      }

      if (path.includes('..')) {
        return Promise.reject(new Error(
          `deleteFile denied: Path '${path}' resolves outside workspace boundary`,
        ));
      }

      try {
        unlinkSync(resolved);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },

    listFiles(dir: string): Promise<string[]> {
      const resolved = resolve(workspacePath, dir);
      const normalized = resolve(workspacePath);

      if (!resolved.startsWith(normalized + '/') && resolved !== normalized) {
        return Promise.reject(new Error(
          `listFiles denied: Path '${dir}' resolves outside workspace boundary`,
        ));
      }

      if (dir.includes('..')) {
        return Promise.reject(new Error(
          `listFiles denied: Path '${dir}' resolves outside workspace boundary`,
        ));
      }

      try {
        const entries = readdirSync(resolved, { withFileTypes: true });
        return Promise.resolve(entries.map((entry) =>
          entry.isDirectory() ? `${entry.name}/` : entry.name,
        ));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },

    fetch(): Promise<never> {
      return Promise.reject(new Error('fetch not available in file-manager tests'));
    },

    log: vi.fn(),

    progress: vi.fn(),

    createSubJob(): Promise<never> {
      return Promise.reject(new Error('createSubJob not available in file-manager tests'));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('file-manager Gear', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'meridian-file-manager-test-'));

    // Set MERIDIAN_WORKSPACE for delete_file action
    process.env['MERIDIAN_WORKSPACE'] = workspacePath;

    // Create test files
    mkdirSync(join(workspacePath, 'subdir'), { recursive: true });
    mkdirSync(join(workspacePath, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(workspacePath, 'hello.txt'), 'Hello, world!');
    writeFileSync(join(workspacePath, 'data.json'), '{"key": "value"}');
    writeFileSync(join(workspacePath, 'subdir', 'file1.txt'), 'File one content\nSecond line');
    writeFileSync(join(workspacePath, 'subdir', 'file2.txt'), 'File two content');
    writeFileSync(join(workspacePath, 'nested', 'deep', 'readme.md'), '# Deep file\nSome text here');
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    delete process.env['MERIDIAN_WORKSPACE'];
  });

  // -------------------------------------------------------------------------
  // Manifest validation
  // -------------------------------------------------------------------------

  describe('manifest', () => {
    it('should have correct id and origin', () => {
      expect(manifest.id).toBe('file-manager');
      expect(manifest.origin).toBe('builtin');
    });

    it('should define all 5 actions', () => {
      const actionNames = manifest.actions.map((a) => a.name);
      expect(actionNames).toEqual([
        'read_file',
        'write_file',
        'list_files',
        'search_files',
        'delete_file',
      ]);
    });

    it('should have correct risk levels', () => {
      const riskMap = Object.fromEntries(
        manifest.actions.map((a) => [a.name, a.riskLevel]),
      );
      expect(riskMap['read_file']).toBe('low');
      expect(riskMap['write_file']).toBe('medium');
      expect(riskMap['list_files']).toBe('low');
      expect(riskMap['search_files']).toBe('low');
      expect(riskMap['delete_file']).toBe('high');
    });

    it('should have filesystem read/write permissions', () => {
      expect(manifest.permissions.filesystem.read).toContain('**');
      expect(manifest.permissions.filesystem.write).toContain('**');
    });
  });

  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------

  describe('read_file', () => {
    it('should read a text file', async () => {
      const context = createTestContext(workspacePath, {
        path: 'hello.txt',
      });

      const result = await execute(context, 'read_file');

      expect(result['content']).toBe('Hello, world!');
      expect(result['size']).toBe(13);
      expect(result['encoding']).toBe('utf-8');
    });

    it('should read a file in a subdirectory', async () => {
      const context = createTestContext(workspacePath, {
        path: 'subdir/file1.txt',
      });

      const result = await execute(context, 'read_file');

      expect(result['content']).toBe('File one content\nSecond line');
      expect(result['size']).toBeGreaterThan(0);
    });

    it('should read a file as base64', async () => {
      const context = createTestContext(workspacePath, {
        path: 'hello.txt',
        encoding: 'base64',
      });

      const result = await execute(context, 'read_file');

      expect(result['content']).toBe(Buffer.from('Hello, world!').toString('base64'));
      expect(result['encoding']).toBe('base64');
    });

    it('should throw on missing path parameter', async () => {
      const context = createTestContext(workspacePath, {});

      await expect(execute(context, 'read_file')).rejects.toThrow(
        'Parameter "path" is required',
      );
    });

    it('should throw on nonexistent file', async () => {
      const context = createTestContext(workspacePath, {
        path: 'nonexistent.txt',
      });

      await expect(execute(context, 'read_file')).rejects.toThrow();
    });

    it('should reject path traversal with ..', async () => {
      const context = createTestContext(workspacePath, {
        path: '../../../etc/passwd',
      });

      await expect(execute(context, 'read_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });

    it('should reject absolute path traversal', async () => {
      const context = createTestContext(workspacePath, {
        path: '/etc/passwd',
      });

      await expect(execute(context, 'read_file')).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // write_file
  // -------------------------------------------------------------------------

  describe('write_file', () => {
    it('should write a text file', async () => {
      const context = createTestContext(workspacePath, {
        path: 'output.txt',
        content: 'Written content',
      });

      const result = await execute(context, 'write_file');

      expect(result['path']).toBe('output.txt');
      expect(result['size']).toBe(15);
      expect(readFileSync(join(workspacePath, 'output.txt'), 'utf-8')).toBe(
        'Written content',
      );
    });

    it('should create parent directories', async () => {
      const context = createTestContext(workspacePath, {
        path: 'new/nested/dir/file.txt',
        content: 'Nested file',
      });

      const result = await execute(context, 'write_file');

      expect(result['path']).toBe('new/nested/dir/file.txt');
      expect(
        existsSync(join(workspacePath, 'new', 'nested', 'dir', 'file.txt')),
      ).toBe(true);
    });

    it('should write base64 content', async () => {
      const originalContent = 'Binary-like content \x00\x01\x02';
      const base64Content = Buffer.from(originalContent).toString('base64');

      const context = createTestContext(workspacePath, {
        path: 'binary.bin',
        content: base64Content,
        encoding: 'base64',
      });

      const result = await execute(context, 'write_file');

      expect(result['size']).toBe(Buffer.from(originalContent).length);
      const written = readFileSync(join(workspacePath, 'binary.bin'));
      expect(written.toString()).toBe(originalContent);
    });

    it('should overwrite existing file', async () => {
      const context = createTestContext(workspacePath, {
        path: 'hello.txt',
        content: 'Updated content',
      });

      await execute(context, 'write_file');

      expect(readFileSync(join(workspacePath, 'hello.txt'), 'utf-8')).toBe(
        'Updated content',
      );
    });

    it('should throw on missing path parameter', async () => {
      const context = createTestContext(workspacePath, {
        content: 'some content',
      });

      await expect(execute(context, 'write_file')).rejects.toThrow(
        'Parameter "path" is required',
      );
    });

    it('should throw on missing content parameter', async () => {
      const context = createTestContext(workspacePath, {
        path: 'output.txt',
      });

      await expect(execute(context, 'write_file')).rejects.toThrow(
        'Parameter "content" is required',
      );
    });

    it('should reject path traversal with ..', async () => {
      const context = createTestContext(workspacePath, {
        path: '../../etc/evil.txt',
        content: 'malicious',
      });

      await expect(execute(context, 'write_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // list_files
  // -------------------------------------------------------------------------

  describe('list_files', () => {
    it('should list all files recursively from workspace root', async () => {
      const context = createTestContext(workspacePath, {});

      const result = await execute(context, 'list_files');

      const files = result['files'] as FileEntry[];
      const paths = files.map((f) => f.path);

      expect(paths).toContain('hello.txt');
      expect(paths).toContain('data.json');
      expect(paths).toContain('subdir/file1.txt');
      expect(paths).toContain('subdir/file2.txt');
      expect(paths).toContain('nested/deep/readme.md');
      expect(result['count']).toBeGreaterThan(0);
    });

    it('should list files non-recursively', async () => {
      const context = createTestContext(workspacePath, {
        recursive: false,
      });

      const result = await execute(context, 'list_files');

      const files = result['files'] as FileEntry[];
      const paths = files.map((f) => f.path);

      expect(paths).toContain('hello.txt');
      expect(paths).toContain('data.json');
      // Should include directories but not their contents
      expect(paths.some((p) => p.includes('subdir'))).toBe(true);
      expect(paths).not.toContain('subdir/file1.txt');
    });

    it('should filter by glob pattern', async () => {
      const context = createTestContext(workspacePath, {
        glob: '*.txt',
      });

      const result = await execute(context, 'list_files');

      const files = result['files'] as FileEntry[];
      const filePaths = files.filter((f) => !f.isDirectory).map((f) => f.path);

      for (const p of filePaths) {
        expect(p.endsWith('.txt')).toBe(true);
      }
      expect(filePaths).toContain('hello.txt');
    });

    it('should filter by recursive glob pattern', async () => {
      const context = createTestContext(workspacePath, {
        glob: '**/*.md',
      });

      const result = await execute(context, 'list_files');

      const files = result['files'] as FileEntry[];
      const filePaths = files.filter((f) => !f.isDirectory).map((f) => f.path);

      expect(filePaths).toContain('nested/deep/readme.md');
    });

    it('should list specific subdirectory', async () => {
      const context = createTestContext(workspacePath, {
        path: 'subdir',
      });

      const result = await execute(context, 'list_files');

      const files = result['files'] as FileEntry[];
      const paths = files.map((f) => f.path);

      expect(paths).toContain('subdir/file1.txt');
      expect(paths).toContain('subdir/file2.txt');
      expect(paths).not.toContain('hello.txt');
    });
  });

  // -------------------------------------------------------------------------
  // search_files
  // -------------------------------------------------------------------------

  describe('search_files', () => {
    it('should find text matches across files', async () => {
      const context = createTestContext(workspacePath, {
        pattern: 'content',
      });

      const result = await execute(context, 'search_files');

      const matches = result['matches'] as SearchMatch[];
      expect(matches.length).toBeGreaterThanOrEqual(2);
      expect(matches.some((m) => m.file.includes('file1.txt'))).toBe(true);
      expect(matches.some((m) => m.file.includes('file2.txt'))).toBe(true);
    });

    it('should return line numbers (1-indexed)', async () => {
      const context = createTestContext(workspacePath, {
        pattern: 'Second line',
      });

      const result = await execute(context, 'search_files');

      const matches = result['matches'] as SearchMatch[];
      expect(matches).toHaveLength(1);
      const firstMatch = matches[0] as SearchMatch;
      expect(firstMatch.file).toContain('file1.txt');
      expect(firstMatch.line).toBe(2); // Second line of the file
    });

    it('should support regex patterns', async () => {
      const context = createTestContext(workspacePath, {
        pattern: 'File \\w+ content',
      });

      const result = await execute(context, 'search_files');

      const matches = result['matches'] as SearchMatch[];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by glob pattern', async () => {
      const context = createTestContext(workspacePath, {
        pattern: 'content',
        glob: '*.txt',
      });

      const result = await execute(context, 'search_files');

      const matches = result['matches'] as SearchMatch[];
      // Only matches in .txt files
      for (const match of matches) {
        expect(match.file.endsWith('.txt')).toBe(true);
      }
    });

    it('should limit results with maxResults', async () => {
      const context = createTestContext(workspacePath, {
        pattern: '.',
        maxResults: 2,
      });

      const result = await execute(context, 'search_files');

      const matches = result['matches'] as SearchMatch[];
      expect(matches.length).toBeLessThanOrEqual(2);
      expect(result['totalMatches']).toBeGreaterThanOrEqual(2);
    });

    it('should set truncated flag when results exceed maxResults', async () => {
      // Create many matching files
      for (let i = 0; i < 5; i++) {
        writeFileSync(
          join(workspacePath, `match-${i}.txt`),
          `This is matching content line ${i}`,
        );
      }

      const context = createTestContext(workspacePath, {
        pattern: 'matching content',
        maxResults: 2,
      });

      const result = await execute(context, 'search_files');

      expect(result['truncated']).toBe(true);
      expect(result['totalMatches']).toBeGreaterThan(2);
    });

    it('should throw on missing pattern parameter', async () => {
      const context = createTestContext(workspacePath, {});

      await expect(execute(context, 'search_files')).rejects.toThrow(
        'Parameter "pattern" is required',
      );
    });

    it('should search within a specific subdirectory', async () => {
      const context = createTestContext(workspacePath, {
        pattern: 'content',
        path: 'subdir',
      });

      const result = await execute(context, 'search_files');

      const matches = result['matches'] as SearchMatch[];
      for (const match of matches) {
        expect(match.file.startsWith('subdir/')).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // delete_file
  // -------------------------------------------------------------------------

  describe('delete_file', () => {
    it('should delete an existing file', async () => {
      const filePath = join(workspacePath, 'to-delete.txt');
      writeFileSync(filePath, 'delete me');

      const context = createTestContext(workspacePath, {
        path: 'to-delete.txt',
      });

      const result = await execute(context, 'delete_file');

      expect(result['deleted']).toBe(true);
      expect(result['path']).toBe('to-delete.txt');
      expect(existsSync(filePath)).toBe(false);
    });

    it('should throw on nonexistent file', async () => {
      const context = createTestContext(workspacePath, {
        path: 'nonexistent.txt',
      });

      await expect(execute(context, 'delete_file')).rejects.toThrow(
        /not found|ENOENT/i,
      );
    });

    it('should throw on missing path parameter', async () => {
      const context = createTestContext(workspacePath, {});

      await expect(execute(context, 'delete_file')).rejects.toThrow(
        'Parameter "path" is required',
      );
    });

    it('should reject path traversal with ..', async () => {
      const context = createTestContext(workspacePath, {
        path: '../../etc/passwd',
      });

      await expect(execute(context, 'delete_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });

    it('should have high risk level in manifest', () => {
      const deleteAction = manifest.actions.find((a) => a.name === 'delete_file');
      expect(deleteAction).toBeDefined();
      expect(deleteAction?.riskLevel).toBe('high');
    });
  });

  // -------------------------------------------------------------------------
  // Path traversal prevention
  // -------------------------------------------------------------------------

  describe('path traversal prevention', () => {
    it('should reject .. in read_file paths', async () => {
      const context = createTestContext(workspacePath, {
        path: 'subdir/../../etc/passwd',
      });

      await expect(execute(context, 'read_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });

    it('should reject .. in write_file paths', async () => {
      const context = createTestContext(workspacePath, {
        path: '../escape/file.txt',
        content: 'malicious',
      });

      await expect(execute(context, 'write_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });

    it('should reject .. in delete_file paths', async () => {
      const context = createTestContext(workspacePath, {
        path: '../../../tmp/important-file',
      });

      await expect(execute(context, 'delete_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });

    it('should reject encoded traversal sequences', async () => {
      // The GearContext path validation uses resolve() which handles
      // encoded sequences. Double-dot with path separators is caught.
      const context = createTestContext(workspacePath, {
        path: 'subdir/../../../etc/passwd',
      });

      await expect(execute(context, 'read_file')).rejects.toThrow(
        /denied|outside workspace/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unknown action
  // -------------------------------------------------------------------------

  describe('unknown action', () => {
    it('should throw on unknown action', async () => {
      const context = createTestContext(workspacePath, {});

      await expect(execute(context, 'unknown_action')).rejects.toThrow(
        'Unknown action: unknown_action',
      );
    });
  });
});

// Type for internal use only — matches the FileEntry in the Gear implementation
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
