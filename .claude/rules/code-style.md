# Code Style Rules

## TypeScript

- Target ES2022+ with Node.js 20+ runtime
- Use `interface` for object shapes that may be extended, `type` for unions/intersections/primitives
- Always use explicit return types on exported functions and public methods
- Use `unknown` instead of `any` — cast narrowly at the point of use
- Prefer `const` assertions for literal types: `as const`
- Use optional chaining (`?.`) and nullish coalescing (`??`) over manual null checks
- Destructure function parameters when there are 3+ params — use an options object instead

## Naming

- Files: `kebab-case.ts` (e.g., `job-scheduler.ts`, `gear-manifest.ts`)
- Interfaces/Types: `PascalCase` (e.g., `ExecutionPlan`, `GearManifest`)
- Functions/variables: `camelCase` (e.g., `validatePlan`, `jobQueue`)
- Constants: `SCREAMING_SNAKE_CASE` for true constants (e.g., `MAX_RETRY_ATTEMPTS`)
- Enums: avoid. Use union types instead: `type Status = 'pending' | 'running' | 'failed'`
- Boolean variables: prefix with `is`, `has`, `can`, `should` (e.g., `isValid`, `hasPermission`)

## Imports

- Group imports: 1) Node built-ins, 2) external packages, 3) internal packages (`@meridian/*`), 4) relative imports
- Blank line between each group
- Alphabetize within each group
- Use path aliases: `@meridian/axis`, `@meridian/shared`, etc.

## Error Handling

- Define typed error classes extending `Error` with a `code` property
- Throw at the source, catch at the boundary (Axis message handler, API endpoint, Gear executor)
- Never swallow errors silently — at minimum, log them
- Use `Result<T, E>` pattern for expected failures (validation, parsing) instead of exceptions
- Unexpected errors (bugs, infra failures) should throw and be caught at the boundary

## Formatting

- 2-space indentation
- Single quotes for strings
- Trailing commas in multi-line structures
- Semicolons required
- Max line length: 100 characters (soft limit — don't break readability to hit it)
- Braces required for all control structures (no single-line `if` without braces)
