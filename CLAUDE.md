# Meridian

## Overview

Meridian is an open-source, self-hosted AI assistant platform designed to run on low-power devices (Raspberry Pi, Mac Mini, VPS). It executes tasks autonomously via natural language commands and learns over time through reflection on successes, failures, and user feedback. The platform uses a dual-LLM trust boundary where every plan goes through independent safety validation before execution.

## Architecture

Meridian uses a navigation/cartography naming theme. These are the core components:

| Component | Name | Role |
|-----------|------|------|
| Runtime / Scheduler | **Axis** | Deterministic job scheduler, message router, process supervisor. No LLM dependency. |
| Planner LLM | **Scout** | Understands intent, decomposes tasks, produces structured execution plans, selects Gear. |
| Safety Validator | **Sentinel** | Independent LLM that reviews execution plans. Strict information barrier from Scout. |
| Memory & Learning | **Journal** | Stores/retrieves knowledge (episodic, semantic, procedural). Suggests new Gear from reflections. |
| User Interface | **Bridge** | Web UI (React SPA) + API gateway. Handles all input/output modalities. |
| Plugin / Capability | **Gear** | Sandboxed plugins with declarative permission manifests. Three origins: builtin, user, journal. |

See `docs/knowledge/architecture.md` for full details.

## Tech Stack

- **Language**: TypeScript (Node.js)
- **Database**: SQLite via `better-sqlite3` (WAL mode)
- **Vector Store**: `sqlite-vec` extension
- **Frontend**: React + TypeScript + Vite + Tailwind CSS + Zustand
- **HTTP Server**: Fastify
- **WebSocket**: `ws` via Fastify plugin
- **Process Sandbox**: `child_process.fork()` + seccomp/sandbox-exec (Level 1), `isolated-vm` (Level 2), Docker (Level 3)
- **Embeddings (local)**: `nomic-embed-text` via Ollama
- **Testing**: Vitest (unit/integration), Playwright (e2e)
- **Linting**: ESLint + Prettier
- **Bundling**: tsup
- **Module Boundaries**: ESLint `no-restricted-imports` + `dependency-cruiser`

## Project Structure

```
src/
  axis/          # Runtime & scheduler (no LLM dependency)
  scout/         # Planner LLM integration
  sentinel/      # Safety validator (isolated from Scout)
  journal/       # Memory system + Gear Suggester
  bridge/
    api/         # Backend API (Fastify)
    ui/          # Frontend SPA (React)
  gear/          # Plugin runtime + builtin/ directory
  shared/        # Shared types and utilities
tests/
  integration/   # Cross-component integration tests
  security/      # Prompt injection, sandbox escape, auth tests
  e2e/           # Playwright browser tests
docs/            # Architecture, idea docs
```

Single TypeScript package with directory-based module boundaries. Each module's `index.ts` is its public API.

## Common Commands

- `npm install` - Install dependencies
- `npm run build` - Build the project
- `npm run dev` - Start development server
- `npm run test` - Run all tests via Vitest
- `npm run test -- --run tests/` - Run tests for a specific directory
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier
- `npm run typecheck` - Run TypeScript type checking

## Code Conventions

- Use ES modules (`import`/`export`), never CommonJS (`require`)
- Use `interface` for object shapes, `type` for unions/intersections
- Prefer named exports over default exports
- Use 2-space indentation, single quotes, trailing commas
- Always use explicit return types on exported functions
- Prefer `const` over `let`; never use `var`
- Use `unknown` instead of `any` wherever possible
- Error handling: throw typed errors, catch at boundaries. Never swallow errors silently.
- Use UUID v7 (time-sortable) for all entity IDs

## Architecture Patterns

- **Typed-with-metadata principle**: Interfaces have required fields for routing/execution, typed optional fields for commonly-used properties, and `metadata?: Record<string, unknown>` for genuinely ad-hoc content. Axis only inspects required fields.
- **Message passing**: Core components communicate through Axis via in-process typed function dispatch (same Node.js process). Gear communicates via JSON over stdin/stdout with HMAC-SHA256 signing (v0.1) or Ed25519 (v0.2).
- **Information barrier**: Sentinel never sees the user's original message, Journal data, or Gear catalog. Only the execution plan and system policies.
- **Fast path vs full path**: Simple conversational queries skip Sentinel/Gear entirely. Action-requiring tasks go through the full Scout -> Sentinel -> Gear pipeline.
- **Journal-skip**: Simple info-retrieval tasks skip reflection. Failures always get reflected on.

## Security Rules (Non-Negotiable)

- Secrets are NEVER included in LLM prompts. They are injected at runtime by Axis.
- Secrets are NEVER logged. Log output is scrubbed for credential patterns.
- Secrets are NEVER stored in plaintext. AES-256-GCM with Argon2id key derivation.
- All external content (emails, web pages, documents) is tagged with provenance metadata and treated as DATA, never as INSTRUCTIONS.
- Gear parameters are validated against their JSON Schema. No direct shell interpolation.
- Bridge binds to 127.0.0.1 by default. Remote access requires explicit TLS configuration.
- Authentication is mandatory on all deployments, including localhost.

## Database Layout

```
data/
  meridian.db           # Core (jobs, conversations, config, schedules, gear registry, execution_log)
  journal.db            # Memory (episodes, facts, procedures, vector embeddings via sqlite-vec)
  sentinel.db           # Sentinel Memory (isolated approval decisions)
  audit-YYYY-MM.db      # Append-only audit log (monthly partitioned)
  secrets.vault         # Encrypted secrets store
  workspace/            # File workspace for Gear operations
```

Meridian uses multiple SQLite databases for isolation. Each has a specific purpose and access control boundary.

## Testing Conventions

- Test files go next to source: `foo.ts` -> `foo.test.ts`
- Use `describe` blocks grouped by function/component
- Use `it` (not `test`) for test cases
- Use mock LLM providers for deterministic tests
- Security tests go in `tests/security/`
- E2E tests go in `tests/e2e/`
- Every PR must include tests for new functionality

## Git Workflow

- Branch from `main`
- Conventional commits: `feat:`, `fix:`, `security:`, `refactor:`, `test:`, `docs:`
- Security-sensitive changes require two reviews
- No new dependencies without explicit justification
- Always run `npm run typecheck && npm run test` before committing

## Key Design Decisions

- SQLite over PostgreSQL: no separate daemon, zero config, portable, sufficient for single-user
- Dual LLM (Scout + Sentinel): safety over cost. Fast path mitigates cost for simple queries.
- `child_process.fork()` + seccomp/sandbox-exec as default sandbox (Level 1); `isolated-vm` optional (Level 2); Docker optional (Level 3). `vm2` is deprecated/archived — do not use.
- Fastify over Express: better performance, built-in schema validation
- Zustand over Redux: lightweight, minimal boilerplate for single-user UI
- Single package over npm workspaces: simpler tooling pre-1.0, split when concrete need arises
- Apache-2.0 license with CLA
