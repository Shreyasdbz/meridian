# Meridian

**Open-source, self-hosted AI assistant platform that executes tasks autonomously, learns from experience, and keeps all your data under your control.**

Meridian runs on modest hardware (Raspberry Pi, Mac Mini, VPS) and uses a dual-LLM trust boundary where every execution plan is independently validated before it runs. It starts as a simple assistant and grows more capable over time by accumulating knowledge from successes, failures, and your feedback.

## Why Meridian?

- **Gets better the more you use it** — Journal accumulates knowledge while the Gear Suggester builds new plugins from repeated patterns. Unlike stateless assistants, Meridian develops expertise specific to your workflows.
- **Self-hosted and private** — All data stays on your hardware. No cloud dependency for storage. LLM API calls transmit minimum context with zero telemetry.
- **Safe by design** — A dual-LLM trust boundary (Scout + Sentinel), sandboxed plugin execution, encrypted credential storage, and mandatory authentication are built into the architecture, not bolted on.
- **Starts small, grows with you** — Begins as a simple command-line assistant on a Raspberry Pi. Over time, gains capabilities through Gear, learns preferences through Journal, and handles increasingly complex autonomous workflows.

## Architecture

Meridian uses a navigation/cartography naming theme. Six core components communicate through Axis, the deterministic runtime:

```
                    ┌─────────────────────────────┐
                    │       Bridge (UI + API)      │
                    │   React SPA · Fastify · WS   │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │        Axis (Runtime)         │
                    │  Job Scheduler · Msg Router   │
                    │    No LLM · Deterministic     │
                    └───┬──────┬──────┬──────┬─────┘
                        │      │      │      │
              ┌─────────▼┐ ┌──▼──────▼─┐ ┌──▼─────────┐
              │  Scout    │ │ Sentinel   │ │  Journal    │
              │  Planner  │ │ Validator  │ │  Memory     │
              │  (LLM)    │ │ (LLM)     │ │  & Learning │
              └───────────┘ └───────────┘ └────────────┘
                        │
              ┌─────────▼─────────┐
              │   Gear (Plugins)   │
              │  Sandboxed · L1-L3 │
              └────────────────────┘
```

| Component | Role |
|-----------|------|
| **Axis** | Deterministic job scheduler and message router. No LLM dependency. The fixed reference point everything revolves around. |
| **Scout** | LLM planner. Understands intent, decomposes tasks, produces structured execution plans. |
| **Sentinel** | Independent LLM safety validator. Reviews every plan with a strict information barrier from Scout. |
| **Journal** | Memory system (episodic, semantic, procedural). Learns from experience and suggests new Gear. |
| **Bridge** | Web UI (React SPA with Chat + Mission Control modes) and API gateway (Fastify + WebSocket). |
| **Gear** | Sandboxed plugins with declarative permission manifests. Three isolation levels. |

### How a request flows

1. **User sends a message** via Bridge (chat UI or API)
2. **Scout analyzes intent** and either responds directly (fast path) or generates a structured execution plan (full path)
3. **Sentinel validates the plan** independently — it never sees the original message, Journal, or Gear catalog
4. **Low-risk plans auto-approve**; medium/high-risk plans require user confirmation
5. **Gear executes** the approved plan steps in sandboxed environments
6. **Journal reflects** on the outcome, storing knowledge for future tasks

## Quick Start

### Prerequisites

- **Node.js 20+** (see `.nvmrc`)
- **npm**
- At least one LLM API key (Anthropic, OpenAI, Google, or OpenRouter) — or [Ollama](https://ollama.com) for local inference

### Installation

```bash
# Clone the repository
git clone https://github.com/meridian-ai/meridian.git
cd meridian

# Install dependencies
npm install

# Build the project
npm run build

# Start Meridian
npm start
```

Open **http://localhost:3200** in your browser. The onboarding wizard will walk you through setting a password, configuring your LLM provider, and sending your first message.

### Development

```bash
# Start the backend with hot reload
npm run dev

# Start the frontend dev server (separate terminal)
npm run dev:ui

# The UI dev server proxies API requests to :3200
```

## Configuration

Meridian loads configuration from multiple sources (highest precedence wins):

1. Application defaults
2. Config file (`data/config.toml`)
3. Environment variables (`MERIDIAN_*` prefix)
4. UI settings (stored in `meridian.db`)

Copy the example config to get started:

```bash
cp docs/config.example.toml data/config.toml
```

### Key settings

```toml
[scout]
provider = "anthropic"           # or "openai", "google", "ollama", "openrouter"
temperature = 0.3

[scout.models]
primary = "claude-sonnet-4-5-20250929"
secondary = "claude-haiku-4-5-20251001"

[sentinel]
provider = "openai"              # Use a different provider from Scout for true independence
model = "gpt-4o"

[bridge]
bind = "127.0.0.1"              # Localhost only by default
port = 3200

[security]
daily_cost_limit_usd = 5.00
require_approval_for = ["file.delete", "shell.execute", "network.post", "message.send"]
```

See [`docs/config.example.toml`](docs/config.example.toml) for the full reference with all options.

## Built-in Gear

Meridian ships with six built-in plugins:

| Gear | Description | Default |
|------|-------------|---------|
| **file-manager** | Read, write, list, search, and delete files within the workspace | Enabled |
| **web-fetch** | Fetch web pages and JSON APIs over HTTPS | Enabled |
| **web-search** | Search the web via DuckDuckGo | Enabled |
| **shell** | Execute shell commands | **Disabled** (must be explicitly enabled) |
| **scheduler** | Create and manage cron-scheduled jobs | Enabled |
| **notification** | Send notifications to the Bridge UI | Enabled |

All Gear runs in sandboxed environments with declared permissions only. Undeclared capabilities are blocked at runtime.

### Sandbox levels

| Level | Mechanism | Use Case |
|-------|-----------|----------|
| **L1** | `child_process.fork()` + OS sandbox (seccomp/sandbox-exec) | Default for all Gear |
| **L2** | `isolated-vm` (V8-level isolation) | Optional, for untrusted code |
| **L3** | Docker container (read-only FS, no network, resource limits) | Maximum isolation |

## Security

Security is structural in Meridian, not optional configuration. Key guarantees:

- **Dual-LLM trust boundary** — Scout (planner) and Sentinel (validator) operate independently. Sentinel never sees the user's message, Journal data, or Gear catalog.
- **Encrypted secrets** — AES-256-GCM with Argon2id key derivation. Secrets are never in LLM prompts, never logged, never stored in plaintext.
- **Mandatory authentication** — Required on all deployments, including localhost. Bcrypt password hashing, secure session tokens, brute-force protection.
- **Gear sandboxing** — Plugins run in isolated environments. Permissions are declared in manifests and enforced at runtime. Private IP ranges are blocked by default.
- **Audit trail** — Append-only, hash-chained audit log in monthly-partitioned SQLite databases. No UPDATE or DELETE permitted.
- **Shell Gear disabled by default** — Must be explicitly enabled and is exempt from auto-approval.

For the full security policy, see [SECURITY.md](SECURITY.md). For the threat model and OWASP LLM Top 10 mitigations, see the [Architecture Document](docs/knowledge/architecture.md), Section 6.

## Data Storage

Meridian uses multiple SQLite databases for isolation:

```
data/
  meridian.db           # Core: jobs, conversations, config, schedules, gear registry
  journal.db            # Memory: episodes, facts, procedures, vector embeddings (sqlite-vec)
  sentinel.db           # Sentinel decisions (completely isolated from other components)
  audit-YYYY-MM.db      # Append-only audit log (monthly partitioned)
  secrets.vault         # Encrypted credentials (AES-256-GCM)
  workspace/            # File workspace for Gear operations
```

All databases use WAL mode for concurrent reads with PRAGMA hardening. Optional SQLCipher encryption is available for databases at rest.

## Deployment

### Target environments

| Environment | RAM | Notes |
|-------------|-----|-------|
| Laptop / Desktop | 8+ GB | Primary development and daily-use target |
| Mac Mini / Home Server | 8-16 GB | Always-on personal server. Docker recommended |
| Linux VPS | 2-4 GB | Docker Compose recommended |
| Raspberry Pi 4/5 | 4-8 GB | Supported with documented tradeoffs |

### Docker Compose

```bash
curl -fsSL https://meridian.dev/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

The container binds to `127.0.0.1:3200` by default. Remote access requires explicit TLS configuration — see [`docs/deployment.md`](docs/deployment.md).

## Development Guide

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build the backend (tsup) |
| `npm run build:ui` | Build the frontend (Vite) |
| `npm run dev` | Start backend with hot reload (tsx watch) |
| `npm run dev:ui` | Start frontend dev server (Vite) |
| `npm start` | Run the built application |
| `npm test` | Run all tests (Vitest) |
| `npm run test:e2e` | Run end-to-end tests (Playwright) |
| `npm run lint` | Run ESLint |
| `npm run format` | Run Prettier |
| `npm run typecheck` | TypeScript type checking |
| `npm run validate:boundaries` | Check module dependency rules (dependency-cruiser) |
| `npm run validate:all` | Run typecheck + lint + boundary check + tests |

### Project structure

```
src/
  axis/              # Runtime & scheduler (deterministic, no LLM)
  scout/             # Planner LLM integration
  sentinel/          # Safety validator (isolated from Scout)
  journal/           # Memory system + Gear Suggester
  bridge/
    api/             # Backend API (Fastify routes, WebSocket)
    ui/              # Frontend SPA (React + Vite + Tailwind + Zustand)
  gear/
    builtin/         # Built-in plugins (file-manager, web-fetch, shell, etc.)
    sandbox/         # Sandbox implementations (process, isolated-vm, Docker)
    sdk/             # Gear development SDK
    mcp/             # MCP compatibility adapters
  shared/            # Shared types, utilities, config, database
  cli/               # CLI for updates and maintenance
tests/
  integration/       # Cross-component integration tests
  security/          # Prompt injection, sandbox escape, auth tests
  e2e/               # Playwright browser tests
docs/
  knowledge/         # Architecture document
  plans/             # Implementation plan
```

Single TypeScript package with directory-based module boundaries enforced via ESLint and dependency-cruiser. Each module's `index.ts` is its public API — no cross-module internal file imports.

### Code conventions

- **TypeScript** — ES2022+, strict mode, `unknown` over `any`, explicit return types on exports
- **Files** — `kebab-case.ts`
- **Types** — `PascalCase` interfaces/types, `camelCase` functions, `SCREAMING_SNAKE_CASE` constants
- **Imports** — ES modules only, grouped by source (Node builtins, external, `@meridian/*`, relative)
- **IDs** — UUID v7 (time-sortable)
- **Errors** — Typed error classes with codes; `Result<T, E>` for expected failures
- **Tests** — Co-located (`foo.test.ts`), `describe`/`it` blocks, Arrange-Act-Assert

### Testing

```bash
# Run all tests
npm test

# Run tests for a specific component
npm test -- --run src/axis/
npm test -- --run src/sentinel/

# Run with coverage
npm test -- --coverage

# Run security tests
npm test -- --run tests/security/

# Run e2e tests
npm run test:e2e
```

The project has 146 test files covering unit, integration, security, and e2e scenarios. Every PR must include tests for new functionality.

## Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (Node.js 20+) |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Vector Store | `sqlite-vec` extension |
| Frontend | React 19 + Vite + Tailwind CSS + Zustand |
| HTTP Server | Fastify 5 |
| WebSocket | `ws` via Fastify plugin |
| LLM Providers | Anthropic, OpenAI, Google Gemini, Ollama, OpenRouter |
| Embeddings | `nomic-embed-text` (Ollama) or OpenAI API |
| Auth | bcrypt + Argon2id, optional TOTP |
| Testing | Vitest + Playwright |
| Linting | ESLint + Prettier |
| Bundling | tsup (backend), Vite (frontend) |
| Module Boundaries | dependency-cruiser + ESLint `no-restricted-imports` |

## Roadmap

| Version | Status | Focus |
|---------|--------|-------|
| **v0.1** | Released | Core loop — Axis, Scout, rule-based Sentinel, Bridge (Chat + Mission Control), 3 built-in Gear |
| **v0.2** | Released | LLM Sentinel, Ed25519 signing, cron scheduling, cost tracking, DAG execution, TLS |
| **v0.3** | Released | Journal memory system, vector search, reflection, Sentinel Memory, container sandbox, encrypted backups |
| **v0.4** | Released | Gear Suggester, adaptive model selection, MCP compatibility, Gear SDK, voice input, TOTP |
| **v1.0+** | Planned | Multi-user, messaging integrations, Gear marketplace, full local LLM, agent federation |

See the [Architecture Document](docs/knowledge/architecture.md), Section 16 for the full delivery roadmap and [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

## Cost

Meridian relies on LLM API calls for Scout (planning) and Sentinel (validation). For moderate use, expect roughly **$45-90/month** in API costs. The built-in cost tracker enforces daily limits with alerts at 80%, 95%, and a hard stop at 100%.

To reduce costs:
- **Fast path** — Simple conversational queries skip Sentinel and Gear entirely
- **Local models** — Use Ollama for Scout and/or embeddings (planning quality tradeoff)
- **Model selection** — Use a cheaper secondary model for simple operations
- **Plan replay cache** — Repeated scheduled tasks reuse cached plans

## Contributing

Contributions are welcome. Please:

1. Read the [Architecture Document](docs/knowledge/architecture.md) to understand the design
2. Follow the code conventions outlined above
3. Include tests for all new functionality
4. Run `npm run validate:all` before submitting
5. Use [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `security:`, `refactor:`, `test:`, `docs:`

Security-sensitive changes require two reviews. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[Apache-2.0](LICENSE) with Contributor License Agreement.

Copyright 2026 Meridian Contributors.
