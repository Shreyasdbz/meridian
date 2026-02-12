// @meridian/scout — External content provenance tagging (Phase 3.4)
//
// Wraps external content with provenance tags so that Scout can distinguish
// between user instructions and untrusted data from external sources.
//
// Architecture references:
// - Section 3.2.5 (Prompt Injection via External Content)
// - Section 5.2.8 (Prompt Injection Defense — soft defense layer)
// - Section 6.2 LLM01 (Content provenance tagging)
//
// NOTE: Provenance tagging is a *soft defense layer* (defense-in-depth).
// LLMs do not reliably respect delimiter boundaries. This reduces the attack
// surface but is NOT a security boundary on its own. Hard boundaries include
// structured plan output, Sentinel review, and sandbox enforcement.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Source type for external content.
 * Only 'user' is treated as instructions; all others are DATA.
 */
export type ContentSource = 'email' | 'web' | 'document' | 'gear' | 'user';

/** Trust level assigned to content. */
export type TrustLevel = 'trusted' | 'untrusted';

/** Attributes for the provenance tag. */
export interface ProvenanceAttributes {
  /** Source type of the content. */
  source: ContentSource;
  /** Optional sender/origin identifier (e.g., email address, URL, gear ID). */
  sender?: string;
  /** Trust level. Defaults to 'untrusted' for non-user sources. */
  trust?: TrustLevel;
  /** Additional attributes to include in the tag. */
  extra?: Record<string, string>;
}

/** Result of wrapping content with provenance. */
export interface ProvenanceWrappedContent {
  /** The wrapped content string with provenance tags. */
  tagged: string;
  /** The source type. */
  source: ContentSource;
  /** The trust level applied. */
  trust: TrustLevel;
  /** Whether this content should be treated as instructions. */
  isInstructions: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPEN_TAG = '<external_content';
const CLOSE_TAG = '</external_content>';

/**
 * Characters that must be escaped in XML attribute values.
 * We escape &, <, >, ", and ' to prevent attribute injection.
 */
const ATTR_ESCAPE_MAP: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
]);

/**
 * Pattern to detect potential provenance tag escape attempts in content.
 * This catches attempts to close the external_content tag prematurely.
 */
const TAG_ESCAPE_PATTERN = /<\/?external_content[\s>]/gi;

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion as an XML attribute value.
 */
export function escapeAttributeValue(value: string): string {
  let result = '';
  for (const char of value) {
    const escaped = ATTR_ESCAPE_MAP.get(char);
    result += escaped ?? char;
  }
  return result;
}

/**
 * Sanitize content body to prevent provenance tag escape attempts.
 *
 * Replaces occurrences of `</external_content>` and `<external_content`
 * within the content body with escaped variants so that nested or
 * malicious content cannot break out of the provenance wrapper.
 */
export function sanitizeContent(content: string): string {
  return content.replace(
    TAG_ESCAPE_PATTERN,
    (match) => match.replace('<', '&lt;').replace('>', '&gt;'),
  );
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Wrap content with provenance tags.
 *
 * All non-user content is wrapped with `<external_content>` tags and
 * marked as untrusted. User content is marked as trusted and treated
 * as instructions.
 *
 * @example
 * ```ts
 * const result = wrapWithProvenance('Hello from Alice', {
 *   source: 'email',
 *   sender: 'alice@example.com',
 * });
 * // result.tagged:
 * // <external_content source="email" sender="alice@example.com" trust="untrusted">
 * // Hello from Alice
 * // </external_content>
 * ```
 */
export function wrapWithProvenance(
  content: string,
  attributes: ProvenanceAttributes,
): ProvenanceWrappedContent {
  const isUser = attributes.source === 'user';
  const trust: TrustLevel = attributes.trust ?? (isUser ? 'trusted' : 'untrusted');

  // User content is instructions — no wrapping needed
  if (isUser) {
    return {
      tagged: content,
      source: 'user',
      trust,
      isInstructions: true,
    };
  }

  // Build attribute string
  const attrs: string[] = [
    `source="${escapeAttributeValue(attributes.source)}"`,
  ];

  if (attributes.sender) {
    attrs.push(`sender="${escapeAttributeValue(attributes.sender)}"`);
  }

  attrs.push(`trust="${escapeAttributeValue(trust)}"`);

  // Add any extra attributes
  if (attributes.extra) {
    for (const [key, value] of Object.entries(attributes.extra)) {
      attrs.push(`${escapeAttributeValue(key)}="${escapeAttributeValue(value)}"`);
    }
  }

  // Sanitize content to prevent tag escape
  const sanitized = sanitizeContent(content);

  const tagged = `${OPEN_TAG} ${attrs.join(' ')}>\n${sanitized}\n${CLOSE_TAG}`;

  return {
    tagged,
    source: attributes.source,
    trust,
    isInstructions: false,
  };
}

/**
 * Wrap Gear output with provenance tags.
 *
 * Convenience function that tags content with `source: "gear:<gearId>"`.
 * Gear output is always untrusted to prevent multi-hop injection attacks
 * (Section 6.2 LLM01).
 */
export function wrapGearOutput(content: string, gearId: string): ProvenanceWrappedContent {
  return wrapWithProvenance(content, {
    source: 'gear',
    sender: `gear:${gearId}`,
    trust: 'untrusted',
  });
}

/**
 * Wrap email content with provenance tags.
 */
export function wrapEmailContent(
  content: string,
  sender: string,
): ProvenanceWrappedContent {
  return wrapWithProvenance(content, {
    source: 'email',
    sender,
  });
}

/**
 * Wrap web content with provenance tags.
 */
export function wrapWebContent(
  content: string,
  url: string,
): ProvenanceWrappedContent {
  return wrapWithProvenance(content, {
    source: 'web',
    sender: url,
  });
}

/**
 * Wrap document content with provenance tags.
 */
export function wrapDocumentContent(
  content: string,
  path: string,
): ProvenanceWrappedContent {
  return wrapWithProvenance(content, {
    source: 'document',
    sender: path,
  });
}

/**
 * Check whether a content source should be treated as instructions.
 * Only 'user' source is instructions; all others are DATA.
 */
export function isInstructionSource(source: ContentSource): boolean {
  return source === 'user';
}

/**
 * Check whether content contains potential provenance tag escape attempts.
 * Returns true if the content contains strings that look like they're trying
 * to close or open external_content tags.
 */
export function hasTagEscapeAttempt(content: string): boolean {
  // Reset lastIndex since TAG_ESCAPE_PATTERN has the g flag
  TAG_ESCAPE_PATTERN.lastIndex = 0;
  return TAG_ESCAPE_PATTERN.test(content);
}
