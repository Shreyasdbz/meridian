# Meridian — GitHub Copilot Instructions

## Project Overview

Meridian is an open-source, self-hosted AI assistant platform that runs on low-power devices (Raspberry Pi, Mac Mini, VPS). It uses a dual-LLM trust boundary architecture where a planner (Scout) generates execution plans and an independent validator (Sentinel) reviews them before execution.

## Tech Stack

- TypeScript (Node.js 20+, ES2022+)
- SQLite via `better-sqlite3` (WAL mode, no external DB)
- React + Vite + Tailwind CSS + Zustand (frontend)
- Fastify (HTTP server)
- Vitest (testing), Playwright (e2e)
- npm workspaces monorepo

## Component Architecture

| Component | Package | Role |
|-----------|---------|------|
| Axis | `packages/axis/` | Deterministic runtime, job scheduler, message router. NO LLM dependency. |
| Scout | `packages/scout/` | LLM planner. Produces structured execution plans. |
| Sentinel | `packages/sentinel/` | Independent safety validator. Information barrier from Scout. |
| Journal | `packages/journal/` | Memory system + Gear builder. Episodic, semantic, procedural memory. |
| Bridge | `packages/bridge/` | React SPA + Fastify API + WebSocket. |
| Gear | `packages/gear/` | Sandboxed plugins with declarative permission manifests. |
| Shared | `packages/shared/` | Shared types and utilities. |

## Code Conventions

- ES modules only (`import`/`export`), never CommonJS
- `interface` for extensible shapes, `type` for unions
- Named exports over default exports
- 2-space indent, single quotes, trailing commas, semicolons
- Explicit return types on exported functions
- `unknown` over `any`
- Files: `kebab-case.ts`, Types: `PascalCase`, Functions: `camelCase`
- UUID v7 for all entity IDs

## Key Patterns

### Loose Schema

Interfaces have required fields for routing plus `[key: string]: unknown` for free-form LLM content:

```typescript
interface ExecutionPlan {
  id: string;
  jobId: string;
  steps: ExecutionStep[];
  [key: string]: unknown; // reasoning, context, etc.
}
```

### Message Passing

All components communicate through Axis. No direct cross-component calls:

```typescript
interface AxisMessage {
  id: string;
  from: ComponentId;
  to: ComponentId;
  type: string;
  signature: string;
  [key: string]: unknown;
}
```

## Security (Non-Negotiable)

- Secrets NEVER in LLM prompts or logs
- External content tagged with provenance metadata
- Gear runs in sandboxed environments only
- All inputs validated at boundaries
- Authentication mandatory on all deployments
- Sentinel never sees user messages, Journal, or Gear catalog

## Testing

- Vitest with `describe`/`it` pattern
- Co-located tests: `foo.ts` -> `foo.test.ts`
- Mock LLM providers for deterministic tests
- Security tests in `tests/security/`

## Git

- Conventional commits: `feat:`, `fix:`, `security:`, `refactor:`, `test:`, `docs:`
- Branch from `main`
