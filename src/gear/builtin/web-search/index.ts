// @meridian/gear/builtin/web-search — Web search via DuckDuckGo (Phase 9.3)
//
// Built-in Gear providing web search via DuckDuckGo's HTML endpoint.
// Uses context.fetch() which enforces domain allowlist, private IP rejection,
// and DNS rebinding prevention.

import type { GearContext } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 20;
const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse DuckDuckGo HTML search results page into structured results.
 * Uses regex since no DOM parser is available in the sandbox.
 */
export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <div class="result"> blocks
  // Each contains <a class="result__a"> for the link and <a class="result__snippet"> for text
  const resultPattern = /<div[^>]*class="[^"]*result\s[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result[\s"]|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    const block = match[1] ?? '';

    // Extract title and URL from result__a link
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1] ?? '';
    const rawTitle = linkMatch[2] ?? '';

    // Extract snippet from result__snippet
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const rawSnippet = snippetMatch?.[1] ?? '';

    // Clean HTML tags and decode entities
    const title = stripHtml(rawTitle).trim();
    const snippet = stripHtml(rawSnippet).trim();

    // Decode the DuckDuckGo redirect URL if present
    const url = decodeDdgUrl(rawUrl);

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/**
 * Strip HTML tags and decode common entities.
 */
function stripHtml(html: string): string {
  let text = html.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  return text.replace(/\s+/g, ' ');
}

/**
 * Decode DuckDuckGo redirect URLs (/l/?uddg=...) to the actual URL.
 */
function decodeDdgUrl(rawUrl: string): string {
  // DDG wraps URLs in redirects like //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
  if (rawUrl.includes('uddg=')) {
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch?.[1]) {
      try {
        return decodeURIComponent(uddgMatch[1]);
      } catch {
        return rawUrl;
      }
    }
  }
  // If it's a plain URL, return as-is
  if (rawUrl.startsWith('http')) {
    return rawUrl;
  }
  return rawUrl;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function search(context: GearContext): Promise<Record<string, unknown>> {
  const query = context.params['query'];
  if (typeof query !== 'string' || query === '') {
    throw new Error('Parameter "query" is required and must be a non-empty string');
  }

  const maxResultsRaw = context.params['maxResults'];
  let maxResults = DEFAULT_MAX_RESULTS;
  if (typeof maxResultsRaw === 'number') {
    maxResults = Math.min(Math.max(1, Math.floor(maxResultsRaw)), MAX_RESULTS_LIMIT);
  }

  context.log(`Searching: ${query} (max ${maxResults} results)`);

  // Query DuckDuckGo HTML endpoint
  const encodedQuery = encodeURIComponent(query);
  const response = await context.fetch(`${DUCKDUCKGO_URL}?q=${encodedQuery}`, {
    method: 'GET',
    headers: {
      'User-Agent': 'Meridian/1.0',
    },
  });

  if (response.status !== 200) {
    throw new Error(`DuckDuckGo returned status ${response.status}`);
  }

  const results = parseDuckDuckGoResults(response.body, maxResults);

  return {
    results,
    query,
    resultCount: results.length,
    searchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Gear entry point
// ---------------------------------------------------------------------------

export async function execute(
  context: GearContext,
  action: string,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'search':
      return search(context);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
