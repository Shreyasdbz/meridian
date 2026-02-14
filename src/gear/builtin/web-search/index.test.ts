/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi } from 'vitest';

import type { GearContext } from '@meridian/shared';

import { execute, parseDuckDuckGoResults } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(
  params: Record<string, unknown>,
  fetchResponse?: { status: number; headers: Record<string, string>; body: string },
): GearContext {
  return {
    params,
    getSecret: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    writeFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    deleteFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    listFiles: vi.fn().mockRejectedValue(new Error('not implemented')),
    fetch: vi.fn().mockResolvedValue(fetchResponse ?? { status: 200, headers: {}, body: '' }),
    log: vi.fn(),
    progress: vi.fn(),
    createSubJob: vi.fn().mockResolvedValue({ jobId: 'test', status: 'pending' }),
  };
}

const SAMPLE_DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=abc">
        Example Page One
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=abc">
      This is the first <b>search</b> result snippet.
    </a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage2&amp;rut=def">
        Another &amp; Result
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage2&amp;rut=def">
      Second result with &lt;tags&gt; and entities.
    </a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.example.com&amp;rut=ghi">
        Third Result
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.example.com&amp;rut=ghi">
      Third snippet here.
    </a>
  </div>
</div>
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('web-search Gear', () => {
  describe('parseDuckDuckGoResults', () => {
    it('should parse multiple results from HTML', () => {
      const results = parseDuckDuckGoResults(SAMPLE_DDG_HTML, 10);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({
        title: 'Example Page One',
        url: 'https://example.com/page1',
        snippet: 'This is the first search result snippet.',
      });
    });

    it('should decode HTML entities in titles and snippets', () => {
      const results = parseDuckDuckGoResults(SAMPLE_DDG_HTML, 10);
      expect(results[1]?.title).toBe('Another & Result');
      expect(results[1]?.snippet).toBe('Second result with <tags> and entities.');
    });

    it('should respect maxResults limit', () => {
      const results = parseDuckDuckGoResults(SAMPLE_DDG_HTML, 1);
      expect(results).toHaveLength(1);
    });

    it('should handle empty HTML', () => {
      const results = parseDuckDuckGoResults('', 10);
      expect(results).toHaveLength(0);
    });

    it('should handle HTML with no result divs', () => {
      const results = parseDuckDuckGoResults('<html><body>No results</body></html>', 10);
      expect(results).toHaveLength(0);
    });

    it('should decode DuckDuckGo redirect URLs', () => {
      const results = parseDuckDuckGoResults(SAMPLE_DDG_HTML, 10);
      expect(results[0]?.url).toBe('https://example.com/page1');
      expect(results[2]?.url).toBe('https://third.example.com');
    });
  });

  describe('execute', () => {
    it('should return search results for a valid query', async () => {
      const context = createMockContext(
        { query: 'test query' },
        { status: 200, headers: {}, body: SAMPLE_DDG_HTML },
      );

      const result = await execute(context, 'search');

      expect(result['query']).toBe('test query');
      expect(result['resultCount']).toBe(3);
      expect(result['searchedAt']).toBeDefined();
      expect(Array.isArray(result['results'])).toBe(true);
      expect((result['results'] as unknown[]).length).toBe(3);
    });

    it('should respect maxResults parameter', async () => {
      const context = createMockContext(
        { query: 'test', maxResults: 2 },
        { status: 200, headers: {}, body: SAMPLE_DDG_HTML },
      );

      const result = await execute(context, 'search');
      expect(result['resultCount']).toBe(2);
    });

    it('should clamp maxResults to MAX_RESULTS_LIMIT', async () => {
      const context = createMockContext(
        { query: 'test', maxResults: 100 },
        { status: 200, headers: {}, body: SAMPLE_DDG_HTML },
      );

      const result = await execute(context, 'search');
      // Only 3 results in sample HTML, so it returns 3 even with maxResults=100
      expect(result['resultCount']).toBe(3);
    });

    it('should throw for missing query parameter', async () => {
      const context = createMockContext({});

      await expect(execute(context, 'search')).rejects.toThrow(
        'Parameter "query" is required',
      );
    });

    it('should throw for empty query parameter', async () => {
      const context = createMockContext({ query: '' });

      await expect(execute(context, 'search')).rejects.toThrow(
        'Parameter "query" is required',
      );
    });

    it('should throw for unknown action', async () => {
      const context = createMockContext({ query: 'test' });

      await expect(execute(context, 'unknown')).rejects.toThrow(
        'Unknown action: unknown',
      );
    });

    it('should throw when DuckDuckGo returns non-200 status', async () => {
      const context = createMockContext(
        { query: 'test' },
        { status: 503, headers: {}, body: 'Service Unavailable' },
      );

      await expect(execute(context, 'search')).rejects.toThrow(
        'DuckDuckGo returned status 503',
      );
    });

    it('should call context.fetch with correct URL', async () => {
      const context = createMockContext(
        { query: 'hello world' },
        { status: 200, headers: {}, body: '' },
      );

      await execute(context, 'search');

      expect(context.fetch).toHaveBeenCalledWith(
        'https://html.duckduckgo.com/html/?q=hello%20world',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should call context.log with search info', async () => {
      const context = createMockContext(
        { query: 'test' },
        { status: 200, headers: {}, body: '' },
      );

      await execute(context, 'search');
      expect(context.log).toHaveBeenCalled();
    });

    it('should handle response with no results', async () => {
      const context = createMockContext(
        { query: 'asdfghjklzxcvb' },
        { status: 200, headers: {}, body: '<html><body>No results found</body></html>' },
      );

      const result = await execute(context, 'search');
      expect(result['resultCount']).toBe(0);
      expect(result['results']).toEqual([]);
    });

    it('should use default maxResults of 5 when not specified', async () => {
      const context = createMockContext(
        { query: 'test' },
        { status: 200, headers: {}, body: SAMPLE_DDG_HTML },
      );

      const result = await execute(context, 'search');
      // Only 3 results in sample, all returned (less than default 5)
      expect(result['resultCount']).toBe(3);
    });
  });
});
