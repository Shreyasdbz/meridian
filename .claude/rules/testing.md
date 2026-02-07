# Testing Rules

## Framework

- Vitest for all unit and integration tests
- Playwright for e2e browser tests
- No Jest — the project uses Vitest exclusively

## File Organization

- Unit tests: co-located with source as `<name>.test.ts`
- Integration tests: `tests/integration/`
- Security tests: `tests/security/`
- E2E tests: `tests/e2e/`

## Writing Tests

- Use `describe` blocks grouped by function/component name
- Use `it` (not `test`) for individual test cases
- Test names should read as sentences: `it('should reject plans with undeclared permissions')`
- Arrange-Act-Assert pattern within each test
- One assertion concept per test (multiple `expect` calls are fine if they assert the same thing)

## Mocking

- Use Vitest's built-in `vi.mock()` and `vi.fn()`
- Mock LLM providers with deterministic responses for Scout/Sentinel tests
- Mock filesystem and network for Gear sandbox tests
- Never mock the module under test — only its dependencies
- Prefer dependency injection over module mocking where the architecture supports it

## What to Test

- Axis: job scheduling, message routing, fault tolerance, graceful shutdown, crash recovery
- Scout: plan structure validation, model selection logic, context assembly
- Sentinel: policy enforcement, risk assessment, Sentinel Memory matching, information barrier
- Journal: memory CRUD, reflection pipeline, Gear Synthesizer output validation
- Bridge: API endpoint validation, authentication, WebSocket message format
- Gear: sandbox enforcement (filesystem isolation, network filtering, resource limits), manifest validation
- Security: prompt injection attempts, sandbox escape attempts, credential exposure

## Test Data

- Use factory functions to create test fixtures (e.g., `createTestJob()`, `createTestPlan()`)
- Keep test data minimal — only include fields relevant to the test
- Use the `[key: string]: unknown` pattern on test objects just like production code
