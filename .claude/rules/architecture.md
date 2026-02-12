# Architecture Rules

## Component Boundaries

- Axis is deterministic and has NO LLM dependency. If you're adding an LLM call to Axis, stop.
- Scout produces plans. It does NOT execute them.
- Sentinel validates plans. It does NOT see the user's original message, Journal, or Gear catalog.
- Journal stores memories and suggests Gear. It does NOT execute plans or make safety decisions.
- Bridge handles UI/API. It does NOT make planning or safety decisions.
- Gear executes actions. It runs in a sandbox with declared permissions only.

## Communication

- Core components share a single Node.js process; communication is in-process typed function dispatch through Axis
- Gear communicates via JSON over stdin/stdout with HMAC-SHA256 signing (v0.1) or Ed25519 (v0.2)
- No component directly calls another component's functions — all routed through Axis
- Use the `ComponentId` type: `'bridge' | 'scout' | 'sentinel' | 'journal' | 'gear:${string}'`

## Typed-with-Metadata Principle

- Interfaces have required fields (for Axis routing/execution), typed optional fields for common properties, and `metadata?: Record<string, unknown>` for ad-hoc content
- Axis ONLY inspects required fields and passes the rest through opaquely
- Scout, Sentinel, Journal can include context/reasoning in typed optional fields or metadata
- This allows format evolution without schema migrations while providing type safety for common patterns

## Data Isolation

- `meridian.db` — jobs, conversations, config, schedules, gear registry, execution_log (Axis owns this)
- `journal.db` — episodic, semantic, procedural memories + vector embeddings via sqlite-vec (Journal owns this)
- `sentinel.db` — approval decisions (Sentinel owns this, completely isolated)
- `audit-YYYY-MM.db` — append-only audit log, monthly partitioned (Axis writes, all can read)
- `secrets.vault` — encrypted credentials (Axis manages access)

## Module Dependencies (single package, directory-based boundaries)

- `shared/` depends on nothing
- `axis/` depends on `shared/`
- `scout/` depends on `shared/`
- `sentinel/` depends on `shared/`
- `journal/` depends on `shared/`
- `gear/` depends on `shared/`
- `bridge/` depends on `shared/`
- No circular dependencies between modules
- No cross-module internal file imports — only through each module's `index.ts`
- Enforced via ESLint `no-restricted-imports` or `dependency-cruiser`
- `ComponentRegistry` interface and `MessageHandler` type live in `shared/` so registering components stay within the boundary. The implementation (`ComponentRegistryImpl`) lives in `axis/`.

## Job Lifecycle

Jobs follow this state machine:
`pending` -> `planning` -> `validating` -> `awaiting_approval` -> `executing` -> `completed` | `failed` | `cancelled`

## Fast Path vs Full Path

- Fast path (conversational): Scout responds directly, no Sentinel/Gear/Journal
- Full path (action): Scout -> Sentinel -> Gear -> (optional Journal reflection)
- When uncertain, default to full path (fail-safe)
