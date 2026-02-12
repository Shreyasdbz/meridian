// @meridian/gear/builtin/web-fetch — Web page and JSON API fetching (Phase 5.5)
//
// Built-in Gear providing HTTPS page and JSON fetching with security enforcement.
// All URLs are validated by the GearContext (HTTPS-only, private IP rejection,
// DNS rebinding prevention). This Gear adds content size limits and URL
// traceability fields. Execution-level provenance (_provenance) is added by
// GearHost per architecture Section 5.6.3.
//
// Actions:
//   fetch_page — Fetch URL, return HTML content (with optional text extraction)
//   fetch_json — Fetch URL, parse and return JSON
//
// Architecture references:
//   - Section 5.6.2 (Gear Manifest)
//   - Section 9.3 (GearContext API)
//   - Section 5.6.3 (GearHost provenance)
//   - Implementation Plan Phase 5.5

import type { GearContext } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum response size: 5 MB */
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

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

function optionalHeaders(
  params: Record<string, unknown>,
  name: string,
): Record<string, string> | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Parameter "${name}" must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`Header "${k}" must be a string value`);
    }
    headers[k] = v;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// HTML text extraction
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and decode common HTML entities to produce plain text.
 * This is a lightweight implementation for use inside the sandbox
 * (no DOM or external parser available).
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Replace block-level tags with newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|hr)\b[^>]*\/?>/gi, '\n');

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Numeric entities
  text = text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code)),
  );

  // Collapse whitespace: multiple blank lines -> single, trim lines
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

// ---------------------------------------------------------------------------
// Content size enforcement
// ---------------------------------------------------------------------------

/**
 * Check that response body does not exceed the configured size limit.
 * Throws if the content is too large.
 */
function enforceContentSize(body: string, maxSizeBytes: number): void {
  const byteLength = Buffer.byteLength(body, 'utf-8');
  if (byteLength > maxSizeBytes) {
    throw new Error(
      `Response size ${byteLength} bytes exceeds limit of ${maxSizeBytes} bytes`,
    );
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Fetch a web page and return HTML content (with optional text extraction).
 *
 * Security:
 * - URL validation (HTTPS, domain allowlist, private IP) handled by GearContext
 * - DNS rebinding prevention handled by GearContext
 * - Content size limit enforced locally
 * - Provenance tagging applied to output
 */
async function fetchPage(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const url = requireString(context.params, 'url');
  const extractText = optionalBoolean(context.params, 'extractText', false);
  const maxSizeBytes = optionalNumber(
    context.params,
    'maxSizeBytes',
    DEFAULT_MAX_SIZE_BYTES,
  );

  context.log(`Fetching page: ${url}`);

  // GearContext.fetch() enforces domain allowlist, protocol, private IP, DNS rebinding
  const response = await context.fetch(url);

  // Enforce content size limit
  enforceContentSize(response.body, maxSizeBytes);

  const contentType = response.headers['content-type'] ?? 'text/html';
  let content = response.body;

  if (extractText) {
    content = extractTextFromHtml(content);
  }

  const byteLength = Buffer.byteLength(content, 'utf-8');

  // Content traceability fields — GearHost adds execution-level _provenance
  // (source: "gear:web-fetch", action, correlationId, timestamp).
  // The Gear provides URL-specific traceability that GearHost can't know.
  return {
    content,
    contentType,
    statusCode: response.status,
    byteLength,
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch a URL and parse the response as JSON.
 *
 * Security:
 * - URL validation handled by GearContext
 * - Content size limit enforced locally
 * - Provenance tagging applied to output
 */
async function fetchJson(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const url = requireString(context.params, 'url');
  const method = optionalString(context.params, 'method', 'GET');
  const headers = optionalHeaders(context.params, 'headers');
  const body = optionalStringOrUndefined(context.params, 'body');
  const maxSizeBytes = optionalNumber(
    context.params,
    'maxSizeBytes',
    DEFAULT_MAX_SIZE_BYTES,
  );

  context.log(`Fetching JSON: ${method} ${url}`);

  // GearContext.fetch() enforces domain allowlist, protocol, private IP, DNS rebinding
  const response = await context.fetch(url, {
    method,
    headers,
    body,
  });

  // Enforce content size limit
  enforceContentSize(response.body, maxSizeBytes);

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new Error(
      `Response is not valid JSON (status ${response.status})`,
    );
  }

  const byteLength = Buffer.byteLength(response.body, 'utf-8');

  // Content traceability fields — GearHost adds execution-level _provenance.
  return {
    data,
    statusCode: response.status,
    byteLength,
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Gear entry point
// ---------------------------------------------------------------------------

/**
 * Execute a web-fetch action.
 *
 * This is the standard Gear entry point called by gear-runtime.ts.
 * The GearContext enforces all manifest permissions (network boundaries,
 * domain allowlists, private IP filtering, DNS rebinding prevention).
 *
 * @param context - The constrained GearContext with action parameters
 * @param action - The action name to execute
 * @returns Action result with provenance tagging
 */
export async function execute(
  context: GearContext,
  action: string,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'fetch_page':
      return fetchPage(context);
    case 'fetch_json':
      return fetchJson(context);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
