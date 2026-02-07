---
applyTo: "**/*.test.ts,**/*.spec.ts,tests/**"
---

# Testing Conventions for Meridian

- Use Vitest (not Jest) for all unit and integration tests
- Use `describe` blocks grouped by function/component name
- Use `it` (not `test`) for individual test cases
- Test names should read as sentences: `it('should reject plans with undeclared permissions')`
- Follow Arrange-Act-Assert pattern
- Mock LLM providers with deterministic responses
- Never mock the module under test — only its dependencies
- Use factory functions for test data: `createTestJob()`, `createTestPlan()`
- Co-locate test files with source: `foo.ts` -> `foo.test.ts`
- Security tests go in `tests/security/`
- E2E tests go in `tests/e2e/` and use Playwright
