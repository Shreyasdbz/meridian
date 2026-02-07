---
description: 'Debug an issue in a specific Meridian component'
agent: 'agent'
tools: ['search/codebase']
---

Debug the following issue in Meridian: $PROMPT_INPUT

## Component Architecture

Meridian components communicate through Axis via message passing. When debugging:

1. **Identify the component** — which package is affected?
   - `packages/axis/` — job scheduling, message routing, process supervision
   - `packages/scout/` — LLM planning, model selection, context assembly
   - `packages/sentinel/` — safety validation, policy enforcement, Sentinel Memory
   - `packages/journal/` — memory retrieval, reflection, Gear synthesis
   - `packages/bridge/` — API endpoints, WebSocket, authentication, UI
   - `packages/gear/` — sandbox execution, manifest validation, permission enforcement

2. **Trace the message flow** — follow the AxisMessage path through the system
3. **Check boundaries** — is the information barrier intact? Are permissions correct?
4. **Look at the database** — is the right DB being accessed? Is the schema current?
5. **Fix minimally** — target root cause, add regression test
