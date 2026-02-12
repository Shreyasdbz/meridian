// @meridian/gear/builtin/web-fetch — Unit tests (Phase 5.5)
//
// Tests for the web-fetch built-in Gear:
// - Successful page fetch (mock HTTP)
// - Successful JSON fetch (mock HTTP)
// - Private IP rejection (simulated via GearContext)
// - Content size limit enforcement
// - Content traceability (sourceUrl, fetchedAt)
// - HTML text extraction
// - Error handling (invalid JSON, fetch failures)
//
// Note: Execution-level _provenance tagging is handled by GearHost
// (Section 5.6.3) and tested in gear-host.test.ts.
//
// Architecture references:
//   - Section 5.6.2 (Gear Manifest, permissions)
//   - Section 9.3 (GearContext API)
//   - Section 5.6.3 (GearHost provenance)
//   - Implementation Plan Phase 5.5

import { describe, it, expect, vi } from 'vitest';

import type { GearContext, FetchOptions, FetchResponse } from '@meridian/shared';

import manifest from './manifest.json';

import { execute } from './index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock GearContext that simulates the sandbox network enforcement.
 * The mock fetch returns canned responses for testing the Gear logic.
 */
function createTestContext(
  params: Record<string, unknown> = {},
  fetchMock?: (url: string, options?: FetchOptions) => Promise<FetchResponse>,
): GearContext {
  return {
    params,

    getSecret(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },

    readFile(): Promise<Buffer> {
      return Promise.reject(new Error('readFile not available in web-fetch tests'));
    },

    writeFile(): Promise<void> {
      return Promise.reject(new Error('writeFile not available in web-fetch tests'));
    },

    deleteFile(): Promise<void> {
      return Promise.reject(new Error('deleteFile not available in web-fetch tests'));
    },

    listFiles(): Promise<string[]> {
      return Promise.reject(new Error('listFiles not available in web-fetch tests'));
    },

    fetch: fetchMock ?? ((): Promise<FetchResponse> => {
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body>Hello</body></html>',
      });
    }),

    log: vi.fn(),

    progress: vi.fn(),

    createSubJob(): Promise<never> {
      return Promise.reject(new Error('createSubJob not available in web-fetch tests'));
    },
  };
}

/**
 * Build a mock fetch that returns fixed content.
 */
function mockFetch(
  status: number,
  headers: Record<string, string>,
  body: string,
): (url: string, options?: FetchOptions) => Promise<FetchResponse> {
  return vi.fn(() => Promise.resolve({ status, headers, body }));
}

/**
 * Build a mock fetch that simulates GearContext private IP rejection.
 */
function mockFetchPrivateIpRejection(): (
  url: string,
  options?: FetchOptions,
) => Promise<FetchResponse> {
  return vi.fn(() =>
    Promise.reject(new Error(
      "fetch denied for Gear 'web-fetch': Private/reserved address '192.168.1.1' blocked for Gear network requests",
    )),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('web-fetch Gear', () => {
  // -------------------------------------------------------------------------
  // Manifest validation
  // -------------------------------------------------------------------------

  describe('manifest', () => {
    it('should have correct id and origin', () => {
      expect(manifest.id).toBe('web-fetch');
      expect(manifest.origin).toBe('builtin');
    });

    it('should define fetch_page and fetch_json actions', () => {
      const actionNames = manifest.actions.map((a) => a.name);
      expect(actionNames).toEqual(['fetch_page', 'fetch_json']);
    });

    it('should have low risk levels for both actions', () => {
      for (const action of manifest.actions) {
        expect(action.riskLevel).toBe('low');
      }
    });

    it('should have network permissions for all HTTPS domains', () => {
      expect(manifest.permissions.network.domains).toEqual(['*']);
      expect(manifest.permissions.network.protocols).toEqual(['https']);
    });

    it('should not declare filesystem permissions', () => {
      expect((manifest.permissions as Record<string, unknown>)['filesystem'])
        .toBeUndefined();
    });

    it('should have resource limits', () => {
      expect(manifest.resources.maxMemoryMb).toBe(128);
      expect(manifest.resources.maxCpuPercent).toBe(25);
      expect(manifest.resources.timeoutMs).toBe(30000);
    });
  });

  // -------------------------------------------------------------------------
  // fetch_page
  // -------------------------------------------------------------------------

  describe('fetch_page', () => {
    it('should fetch a page and return HTML content', async () => {
      const html = '<html><head><title>Test</title></head><body><p>Hello World</p></body></html>';
      const context = createTestContext(
        { url: 'https://example.com' },
        mockFetch(200, { 'content-type': 'text/html; charset=utf-8' }, html),
      );

      const result = await execute(context, 'fetch_page');

      expect(result['content']).toBe(html);
      expect(result['contentType']).toBe('text/html; charset=utf-8');
      expect(result['statusCode']).toBe(200);
      expect(result['byteLength']).toBe(Buffer.byteLength(html, 'utf-8'));
    });

    it('should extract text from HTML when extractText is true', async () => {
      const html = [
        '<html><head><title>Test</title>',
        '<script>var x = 1;</script>',
        '<style>.foo { color: red; }</style>',
        '</head><body>',
        '<h1>Title</h1>',
        '<p>First paragraph.</p>',
        '<p>Second &amp; third &lt;paragraph&gt;.</p>',
        '</body></html>',
      ].join('');

      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const text = result['content'] as string;

      // Script and style content should be removed
      expect(text).not.toContain('var x = 1');
      expect(text).not.toContain('.foo');

      // Text content should be preserved
      expect(text).toContain('Title');
      expect(text).toContain('First paragraph.');

      // HTML entities should be decoded
      expect(text).toContain('Second & third <paragraph>.');
    });

    it('should return HTML without extraction by default', async () => {
      const html = '<html><body><p>Hello</p></body></html>';
      const context = createTestContext(
        { url: 'https://example.com' },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');

      // Should return raw HTML, not extracted text
      expect(result['content']).toBe(html);
      expect((result['content'] as string)).toContain('<p>');
    });

    it('should use text/html as default content type when header is missing', async () => {
      const context = createTestContext(
        { url: 'https://example.com' },
        mockFetch(200, {}, 'plain content'),
      );

      const result = await execute(context, 'fetch_page');

      expect(result['contentType']).toBe('text/html');
    });

    it('should report byteLength of extracted text, not raw HTML', async () => {
      const html = '<html><body><p>Short</p></body></html>';
      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const content = result['content'] as string;

      // byteLength should match the returned content, not the raw HTML
      expect(result['byteLength']).toBe(Buffer.byteLength(content, 'utf-8'));
      // The extracted text is shorter than the raw HTML
      expect(result['byteLength']).toBeLessThan(Buffer.byteLength(html, 'utf-8'));
    });

    it('should throw on missing url parameter', async () => {
      const context = createTestContext({});

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        'Parameter "url" is required',
      );
    });
  });

  // -------------------------------------------------------------------------
  // fetch_json
  // -------------------------------------------------------------------------

  describe('fetch_json', () => {
    it('should fetch and parse JSON', async () => {
      const jsonBody = JSON.stringify({ key: 'value', count: 42 });
      const context = createTestContext(
        { url: 'https://api.example.com/data' },
        mockFetch(200, { 'content-type': 'application/json' }, jsonBody),
      );

      const result = await execute(context, 'fetch_json');

      expect(result['data']).toEqual({ key: 'value', count: 42 });
      expect(result['statusCode']).toBe(200);
      expect(result['byteLength']).toBe(Buffer.byteLength(jsonBody, 'utf-8'));
    });

    it('should pass method, headers, and body to fetch', async () => {
      const fetchSpy = vi.fn((): Promise<FetchResponse> =>
        Promise.resolve({
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: '{"created": true}',
        }),
      );

      const context = createTestContext(
        {
          url: 'https://api.example.com/items',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name": "test"}',
        },
        fetchSpy,
      );

      const result = await execute(context, 'fetch_json');

      expect(fetchSpy).toHaveBeenCalledWith('https://api.example.com/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name": "test"}',
      });
      expect(result['data']).toEqual({ created: true });
      expect(result['statusCode']).toBe(201);
    });

    it('should use GET as default method', async () => {
      const fetchSpy = vi.fn((): Promise<FetchResponse> =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );

      const context = createTestContext(
        { url: 'https://api.example.com/data' },
        fetchSpy,
      );

      await execute(context, 'fetch_json');

      expect(fetchSpy).toHaveBeenCalledWith('https://api.example.com/data', {
        method: 'GET',
        headers: undefined,
        body: undefined,
      });
    });

    it('should handle JSON array responses', async () => {
      const jsonBody = JSON.stringify([1, 2, 3]);
      const context = createTestContext(
        { url: 'https://api.example.com/list' },
        mockFetch(200, { 'content-type': 'application/json' }, jsonBody),
      );

      const result = await execute(context, 'fetch_json');

      expect(result['data']).toEqual([1, 2, 3]);
      expect(result['statusCode']).toBe(200);
    });

    it('should handle JSON string responses', async () => {
      const jsonBody = JSON.stringify('hello');
      const context = createTestContext(
        { url: 'https://api.example.com/string' },
        mockFetch(200, { 'content-type': 'application/json' }, jsonBody),
      );

      const result = await execute(context, 'fetch_json');

      expect(result['data']).toBe('hello');
    });

    it('should handle JSON null responses', async () => {
      const context = createTestContext(
        { url: 'https://api.example.com/null' },
        mockFetch(200, { 'content-type': 'application/json' }, 'null'),
      );

      const result = await execute(context, 'fetch_json');

      expect(result['data']).toBeNull();
    });

    it('should throw on invalid JSON response', async () => {
      const context = createTestContext(
        { url: 'https://api.example.com/data' },
        mockFetch(200, { 'content-type': 'text/html' }, '<html>Not JSON</html>'),
      );

      await expect(execute(context, 'fetch_json')).rejects.toThrow(
        /not valid JSON/,
      );
    });

    it('should not include response body in JSON parse error message', async () => {
      const sensitiveBody = 'secret-credential-value-12345';
      const context = createTestContext(
        { url: 'https://api.example.com/data' },
        mockFetch(401, { 'content-type': 'text/plain' }, sensitiveBody),
      );

      await expect(execute(context, 'fetch_json')).rejects.toSatisfy(
        (error: unknown) => !(error as Error).message.includes('secret-credential'),
      );
    });

    it('should throw on missing url parameter', async () => {
      const context = createTestContext({});

      await expect(execute(context, 'fetch_json')).rejects.toThrow(
        'Parameter "url" is required',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Private IP rejection
  // -------------------------------------------------------------------------

  describe('private IP rejection', () => {
    it('should reject requests to private IPs (delegated to GearContext)', async () => {
      const context = createTestContext(
        { url: 'https://192.168.1.1/secret' },
        mockFetchPrivateIpRejection(),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        /Private\/reserved address.*blocked/,
      );
    });

    it('should reject fetch_json to private IPs', async () => {
      const context = createTestContext(
        { url: 'https://10.0.0.1/api' },
        vi.fn(() =>
          Promise.reject(new Error(
            "fetch denied for Gear 'web-fetch': Private/reserved address '10.0.0.1' blocked",
          )),
        ),
      );

      await expect(execute(context, 'fetch_json')).rejects.toThrow(
        /Private\/reserved address.*blocked/,
      );
    });

    it('should reject localhost (delegated to GearContext)', async () => {
      const context = createTestContext(
        { url: 'https://localhost/admin' },
        vi.fn(() =>
          Promise.reject(new Error(
            "fetch denied for Gear 'web-fetch': localhost blocked for Gear network requests",
          )),
        ),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        /localhost blocked/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Content size limit enforcement
  // -------------------------------------------------------------------------

  describe('content size limit', () => {
    it('should reject responses exceeding default size limit (5 MB)', async () => {
      // Create a response just over 5MB
      const largeBody = 'x'.repeat(5 * 1024 * 1024 + 1);
      const context = createTestContext(
        { url: 'https://example.com/large' },
        mockFetch(200, { 'content-type': 'text/html' }, largeBody),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        /exceeds limit/,
      );
    });

    it('should accept responses within default size limit', async () => {
      const body = 'x'.repeat(1000);
      const context = createTestContext(
        { url: 'https://example.com' },
        mockFetch(200, { 'content-type': 'text/html' }, body),
      );

      const result = await execute(context, 'fetch_page');

      expect(result['statusCode']).toBe(200);
    });

    it('should enforce custom maxSizeBytes for fetch_page', async () => {
      const body = 'x'.repeat(2000);
      const context = createTestContext(
        { url: 'https://example.com', maxSizeBytes: 1000 },
        mockFetch(200, { 'content-type': 'text/html' }, body),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        /exceeds limit of 1000 bytes/,
      );
    });

    it('should enforce custom maxSizeBytes for fetch_json', async () => {
      const body = JSON.stringify({ data: 'x'.repeat(2000) });
      const context = createTestContext(
        { url: 'https://api.example.com/data', maxSizeBytes: 500 },
        mockFetch(200, { 'content-type': 'application/json' }, body),
      );

      await expect(execute(context, 'fetch_json')).rejects.toThrow(
        /exceeds limit of 500 bytes/,
      );
    });

    it('should report correct byte length in error message', async () => {
      const body = 'a'.repeat(200);
      const context = createTestContext(
        { url: 'https://example.com', maxSizeBytes: 100 },
        mockFetch(200, { 'content-type': 'text/html' }, body),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        `Response size 200 bytes exceeds limit of 100 bytes`,
      );
    });

    it('should enforce size limits correctly for multi-byte UTF-8', async () => {
      // Each CJK character is 3 bytes in UTF-8, so 400 chars = 1200 bytes
      const multiByte = '\u4e16'.repeat(400);
      expect(multiByte.length).toBe(400);
      expect(Buffer.byteLength(multiByte, 'utf-8')).toBe(1200);

      const context = createTestContext(
        { url: 'https://example.com', maxSizeBytes: 1000 },
        mockFetch(200, { 'content-type': 'text/html' }, multiByte),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        'Response size 1200 bytes exceeds limit of 1000 bytes',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Content traceability (sourceUrl, fetchedAt)
  // Note: Execution-level _provenance is added by GearHost and tested there.
  // -------------------------------------------------------------------------

  describe('content traceability', () => {
    it('should include sourceUrl in fetch_page output', async () => {
      const context = createTestContext(
        { url: 'https://example.com/page' },
        mockFetch(200, { 'content-type': 'text/html' }, '<html>test</html>'),
      );

      const result = await execute(context, 'fetch_page');

      expect(result['sourceUrl']).toBe('https://example.com/page');
    });

    it('should include sourceUrl in fetch_json output', async () => {
      const context = createTestContext(
        { url: 'https://api.example.com/data' },
        mockFetch(200, { 'content-type': 'application/json' }, '{"ok": true}'),
      );

      const result = await execute(context, 'fetch_json');

      expect(result['sourceUrl']).toBe('https://api.example.com/data');
    });

    it('should include fetchedAt with ISO 8601 timestamp', async () => {
      const context = createTestContext(
        { url: 'https://example.com' },
        mockFetch(200, { 'content-type': 'text/html' }, 'test'),
      );

      const result = await execute(context, 'fetch_page');

      expect(typeof result['fetchedAt']).toBe('string');
      const timestamp = new Date(result['fetchedAt'] as string);
      expect(timestamp.getTime()).not.toBeNaN();
    });

    it('should not include _provenance (handled by GearHost)', async () => {
      const context = createTestContext(
        { url: 'https://example.com' },
        mockFetch(200, { 'content-type': 'text/html' }, 'test'),
      );

      const result = await execute(context, 'fetch_page');

      expect(result['_provenance']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // HTML text extraction
  // -------------------------------------------------------------------------

  describe('text extraction', () => {
    it('should remove script tags and content', async () => {
      const html = '<html><body><script>alert("xss")</script><p>Safe text</p></body></html>';
      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const text = result['content'] as string;

      expect(text).not.toContain('alert');
      expect(text).toContain('Safe text');
    });

    it('should remove style tags and content', async () => {
      const html = '<html><body><style>body { display: none; }</style><p>Visible</p></body></html>';
      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const text = result['content'] as string;

      expect(text).not.toContain('display');
      expect(text).toContain('Visible');
    });

    it('should decode HTML entities', async () => {
      const html = '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>';
      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const text = result['content'] as string;

      expect(text).toContain('A & B < C > D "E" \'F\'');
    });

    it('should decode numeric HTML entities', async () => {
      const html = '<p>&#65;&#66;&#67;</p>';
      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const text = result['content'] as string;

      expect(text).toContain('ABC');
    });

    it('should collapse excessive whitespace', async () => {
      const html = '<p>Line 1</p>\n\n\n\n\n<p>Line 2</p>';
      const context = createTestContext(
        { url: 'https://example.com', extractText: true },
        mockFetch(200, { 'content-type': 'text/html' }, html),
      );

      const result = await execute(context, 'fetch_page');
      const text = result['content'] as string;

      // Should not have more than 2 consecutive newlines
      expect(text).not.toMatch(/\n{3,}/);
      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should propagate fetch errors', async () => {
      const context = createTestContext(
        { url: 'https://example.com' },
        vi.fn(() => Promise.reject(new Error('Network timeout'))),
      );

      await expect(execute(context, 'fetch_page')).rejects.toThrow(
        'Network timeout',
      );
    });

    it('should handle non-200 status codes in fetch_page', async () => {
      const context = createTestContext(
        { url: 'https://example.com/404' },
        mockFetch(404, { 'content-type': 'text/html' }, '<html>Not Found</html>'),
      );

      // fetch_page should not throw on non-200 — it returns the status code
      const result = await execute(context, 'fetch_page');

      expect(result['statusCode']).toBe(404);
      expect(result['content']).toBe('<html>Not Found</html>');
    });

    it('should handle non-200 status codes with valid JSON in fetch_json', async () => {
      const errorBody = JSON.stringify({ error: 'not_found', message: 'Resource not found' });
      const context = createTestContext(
        { url: 'https://api.example.com/missing' },
        mockFetch(404, { 'content-type': 'application/json' }, errorBody),
      );

      // fetch_json should not throw on non-200 — it returns the parsed JSON + status
      const result = await execute(context, 'fetch_json');

      expect(result['statusCode']).toBe(404);
      expect(result['data']).toEqual({ error: 'not_found', message: 'Resource not found' });
    });
  });

  // -------------------------------------------------------------------------
  // Unknown action
  // -------------------------------------------------------------------------

  describe('unknown action', () => {
    it('should throw on unknown action', async () => {
      const context = createTestContext({ url: 'https://example.com' });

      await expect(execute(context, 'unknown_action')).rejects.toThrow(
        'Unknown action: unknown_action',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe('logging', () => {
    it('should log fetch_page URL', async () => {
      const logSpy = vi.fn();
      const context = createTestContext(
        { url: 'https://example.com/page' },
        mockFetch(200, { 'content-type': 'text/html' }, 'test'),
      );
      context.log = logSpy;

      await execute(context, 'fetch_page');

      expect(logSpy).toHaveBeenCalledWith(
        'Fetching page: https://example.com/page',
      );
    });

    it('should log fetch_json method and URL', async () => {
      const logSpy = vi.fn();
      const context = createTestContext(
        { url: 'https://api.example.com/data', method: 'POST' },
        mockFetch(200, { 'content-type': 'application/json' }, '{}'),
      );
      context.log = logSpy;

      await execute(context, 'fetch_json');

      expect(logSpy).toHaveBeenCalledWith(
        'Fetching JSON: POST https://api.example.com/data',
      );
    });
  });
});
