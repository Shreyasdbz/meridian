---
description: 'Implement a TypeScript interface from the architecture document'
agent: 'agent'
tools: ['search/codebase']
---

Implement the following interface from Meridian's architecture: $PROMPT_INPUT

## Instructions

1. Find the interface definition in `docs/architecture.md`
2. Create the TypeScript implementation in the appropriate `packages/` directory
3. Follow the **loose schema principle**: required fields for routing/execution + `[key: string]: unknown` for free-form content
4. Include proper validation functions
5. Add factory/builder functions for creating instances
6. Write comprehensive tests
7. Export from the package's `src/index.ts`

## Key Interfaces from Architecture

- `Job` — Axis job tracking (packages/axis/)
- `ExecutionPlan` / `ExecutionStep` — Scout output (packages/scout/)
- `ValidationResult` / `StepValidation` — Sentinel output (packages/sentinel/)
- `SentinelDecision` — Sentinel Memory (packages/sentinel/)
- `GearManifest` / `GearAction` / `GearContext` — Gear system (packages/gear/)
- `AxisMessage` — Inter-component messaging (packages/shared/)
- `LLMProvider` — LLM abstraction (packages/shared/)
- `MemoryQuery` / `MemoryResult` — Journal retrieval (packages/journal/)
- `WSMessage` — WebSocket protocol (packages/bridge/)
- `AuditEntry` — Audit logging (packages/shared/)
- `Secret` — Secrets management (packages/shared/)
