---
name: implement-component
description: Implement a Meridian component or feature following the architecture document
argument-hint: "[component-name or feature description]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

Implement the specified Meridian component or feature: $ARGUMENTS

## Process

1. Read `docs/architecture.md` to understand the full component specification
2. Check the relevant package directory under `packages/` for existing code
3. Read `packages/shared/src/` for shared types and utilities
4. Implement the component following these rules:
   - Use the loose schema principle (required fields + `[key: string]: unknown`)
   - Follow the naming conventions from architecture (Axis, Scout, Sentinel, Journal, Bridge, Gear)
   - Maintain component boundaries — no direct cross-component calls
   - All inter-component communication goes through Axis message passing
5. Write unit tests alongside the implementation
6. Run `npm run typecheck` and `npm run test` to verify

## Architecture Reference

- Axis: deterministic runtime, no LLM dependency, job scheduling, message routing
- Scout: LLM planner, execution plans, model selection, context management
- Sentinel: safety validator, information barrier, policy enforcement, Sentinel Memory
- Journal: memory system (episodic/semantic/procedural), reflection, Gear Synthesizer
- Bridge: React SPA + Fastify API, WebSocket streaming, authentication
- Gear: sandboxed plugins, declarative manifests, three origins (builtin/user/journal)
