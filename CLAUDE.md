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
| Memory & Gear Builder | **Journal** | Stores/retrieves knowledge (episodic, semantic, procedural). Creates/refines Gear from reflections. |
| User Interface | **Bridge** | Web UI (React SPA) + API gateway. Handles all input/output modalities. |
| Plugin / Capability | **Gear** | Sandboxed plugins with declarative permission manifests. Three origins: builtin, user, journal. |

See `docs/architecture.md` for full details.

## Tech Stack

- **Language**: TypeScript (Node.js)
- **Database**: SQLite via `better-sqlite3` (WAL mode)
- **Vector Store**: `sqlite-vec` extension
- **Frontend**: React + TypeScript + Vite + Tailwind CSS + Zustand
- **HTTP Server**: Fastify
- **WebSocket**: `ws` via Fastify plugin
- **Process Sandbox**: `isolated-vm` + seccomp/sandbox-exec
- **Container Sandbox**: Docker (optional)
- **Embeddings (local)**: `nomic-embed-text` via Ollama
- **Testing**: Vitest (unit/integration), Playwright (e2e)
- **Linting**: ESLint + Prettier
- **Bundling**: tsup
- **Package Manager**: npm workspaces (monorepo)

## Project Structure

```
packages/
  axis/          # Runtime & scheduler (no LLM dependency)
  scout/         # Planner LLM integration
  sentinel/      # Safety validator (isolated from Scout)
  journal/       # Memory system + Gear Synthesizer
  bridge/        # UI (src/api/ for backend, src/ui/ for frontend SPA)
  gear/          # Plugin runtime + builtin/ directory
  shared/        # Shared types and utilities
tests/
  integration/   # Cross-component integration tests
  security/      # Prompt injection, sandbox escape, auth tests
  e2e/           # Playwright browser tests
docs/            # Architecture, idea docs
```

## Common Commands

- `npm install` - Install all workspace dependencies
- `npm run build` - Build all packages
- `npm run dev` - Start development server
- `npm run test` - Run all tests via Vitest
- `npm run test -- --run packages/axis/tests/` - Run tests for a single package
- `npm run lint` - Run ESLint across all packages
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

- **Loose schema principle**: Interfaces have a small set of required fields for routing/execution, plus `[key: string]: unknown` for free-form LLM-generated content. Axis only inspects required fields.
- **Message passing**: All components communicate through Axis using signed messages (HMAC-SHA256). No direct component-to-component calls.
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
  meridian.db           # Core (jobs, config, schedules, gear registry)
  journal.db            # Memory (episodes, facts, procedures)
  journal-vectors.db    # Vector embeddings (sqlite-vec)
  sentinel.db           # Sentinel Memory (isolated approval decisions)
  audit.db              # Append-only audit log
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
- `isolated-vm` over `vm2`: vm2 is deprecated/archived due to unfixable escape CVEs
- Fastify over Express: better performance, built-in schema validation
- Zustand over Redux: lightweight, minimal boilerplate for single-user UI
