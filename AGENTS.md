# Meridian — AI Agent Instructions

## Project Overview

Meridian is an open-source, self-hosted AI assistant platform for low-power devices. It uses a dual-LLM trust boundary: Scout (planner) generates execution plans, Sentinel (validator) independently reviews them before execution. All components communicate through Axis (runtime) via signed messages.

## Architecture

```
User -> Bridge -> Axis -> Scout (plan)
                           |
                  Fast path: respond directly
                  Full path: Axis -> Sentinel (validate)
                                       |
                              Approved -> Axis -> Gear (execute) -> Bridge (respond)
                              Rejected -> Scout (revise)
                                       |
                              After execution -> Journal (reflect, learn, build Gear)
```

### Components

- **Axis** (`packages/axis/`): Deterministic runtime. Job scheduler, message router, process supervisor. Zero LLM dependency.
- **Scout** (`packages/scout/`): LLM planner. Understands intent, decomposes tasks into structured execution plans, selects Gear.
- **Sentinel** (`packages/sentinel/`): Independent LLM safety validator. Strict information barrier — never sees user messages, Journal, or Gear catalog.
- **Journal** (`packages/journal/`): Memory system (episodic/semantic/procedural) and Gear Synthesizer. Reflects on task results to learn and create/refine Gear.
- **Bridge** (`packages/bridge/`): React SPA frontend + Fastify HTTP/WebSocket backend. Handles all user interaction.
- **Gear** (`packages/gear/`): Sandboxed plugins with declarative permission manifests. Three origins: builtin, user-installed, journal-generated.
- **Shared** (`packages/shared/`): Shared TypeScript types and utilities.

### Key Design Principles

1. **Loose schema**: Interfaces have required fields + `[key: string]: unknown` for free-form LLM content
2. **Message passing**: All inter-component communication through Axis, never direct calls
3. **Information barrier**: Sentinel is isolated from Scout's context to prevent compromise propagation
4. **Security by default**: Auth mandatory, secrets encrypted, Gear sandboxed, inputs validated

## Tech Stack

- TypeScript, Node.js 20+, ES2022+
- SQLite (`better-sqlite3`, WAL mode) — no external database
- React + Vite + Tailwind CSS + Zustand (frontend)
- Fastify + `ws` (backend)
- `isolated-vm` + Docker for Gear sandboxing
- Vitest + Playwright (testing)
- npm workspaces monorepo

## Code Conventions

- ES modules only, never CommonJS
- `interface` for extensible object shapes, `type` for unions/intersections
- Named exports, explicit return types, `unknown` over `any`
- 2-space indent, single quotes, trailing commas, semicolons
- Files: `kebab-case.ts`, Types: `PascalCase`, Functions: `camelCase`
- UUID v7 for all entity IDs
- Conventional commits: `feat:`, `fix:`, `security:`, `refactor:`, `test:`, `docs:`

## Security Rules

These are non-negotiable. Every code change must comply:

- Secrets NEVER in LLM prompts, logs, or plaintext
- External content MUST have provenance tags (`source: email|web|user`)
- Gear MUST run in sandbox with only declared permissions
- Bridge MUST bind to 127.0.0.1 by default
- Authentication MUST be mandatory
- All inputs MUST be validated at boundaries

## Testing

- Vitest for unit/integration, Playwright for e2e
- Co-located tests: `foo.ts` -> `foo.test.ts`
- `describe`/`it` pattern, Arrange-Act-Assert
- Mock LLM providers for deterministic behavior
- Security tests in `tests/security/` (prompt injection, sandbox escape, auth)

## Database Layout

| Database | Owner | Purpose |
|----------|-------|---------|
| `meridian.db` | Axis | Jobs, config, schedules, gear registry |
| `journal.db` | Journal | Episodic, semantic, procedural memories |
| `journal-vectors.db` | Journal | Vector embeddings (sqlite-vec) |
| `sentinel.db` | Sentinel | Isolated approval decisions |
| `audit.db` | Axis | Append-only audit log |
| `secrets.vault` | Axis | Encrypted secrets (AES-256-GCM) |
