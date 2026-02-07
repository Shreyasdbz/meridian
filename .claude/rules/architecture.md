# Architecture Rules

## Component Boundaries

- Axis is deterministic and has NO LLM dependency. If you're adding an LLM call to Axis, stop.
- Scout produces plans. It does NOT execute them.
- Sentinel validates plans. It does NOT see the user's original message, Journal, or Gear catalog.
- Journal stores memories and builds Gear. It does NOT execute plans or make safety decisions.
- Bridge handles UI/API. It does NOT make planning or safety decisions.
- Gear executes actions. It runs in a sandbox with declared permissions only.

## Communication

- All inter-component communication goes through Axis using typed `AxisMessage` objects
- No component directly calls another component's functions
- Messages are signed with HMAC-SHA256 for authenticity
- Use the `ComponentId` type: `'bridge' | 'scout' | 'sentinel' | 'journal' | 'gear:${string}'`

## Loose Schema Principle

- Interfaces have required fields (for Axis routing/execution) and free-form fields (`[key: string]: unknown`)
- Axis ONLY inspects required fields and passes the rest through opaquely
- Scout, Sentinel, Journal can include whatever context/reasoning they deem useful
- This allows format evolution without schema migrations

## Data Isolation

- `meridian.db` — jobs, config, schedules, gear registry (Axis owns this)
- `journal.db` — episodic, semantic, procedural memories (Journal owns this)
- `journal-vectors.db` — vector embeddings (Journal owns this)
- `sentinel.db` — approval decisions (Sentinel owns this, completely isolated)
- `audit.db` — append-only audit log (Axis writes, all can read)
- `secrets.vault` — encrypted credentials (Axis manages access)

## Package Dependencies

- `shared` depends on nothing
- `axis` depends on `shared`
- `scout` depends on `shared`
- `sentinel` depends on `shared`
- `journal` depends on `shared`
- `gear` depends on `shared`
- `bridge` depends on `shared`
- No circular dependencies between packages
- No package imports from another package's internals — only from its public API

## Job Lifecycle

Jobs follow this state machine:
`pending` -> `planning` -> `validating` -> `awaiting_approval` -> `executing` -> `completed` | `failed` | `cancelled`

## Fast Path vs Full Path

- Fast path (conversational): Scout responds directly, no Sentinel/Gear/Journal
- Full path (action): Scout -> Sentinel -> Gear -> (optional Journal reflection)
- When uncertain, default to full path (fail-safe)
