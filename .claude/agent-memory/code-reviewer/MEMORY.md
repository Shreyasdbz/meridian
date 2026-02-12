# Code Reviewer Memory

## Review Patterns

### Phase 2.8 Axis Runtime
- Axis class composes all sub-systems (ComponentRegistry, MessageRouter, JobQueue, WorkerPool, PlanValidator, crash recovery, Watchdog, AuditLog, LifecycleManager, BasicMaintenance)
- Lifecycle steps registered in correct order: config → database → axis_core → components → recovery → bridge
- Shutdown handlers registered in reverse order via `registerShutdownHandler`
- Audit writer bridge pattern: sync MessageRouter interface bridged to async AuditLog via fire-and-forget `void` + error catch
- NO LLM dependency in Axis code (verified via grep)
- All exported functions have explicit return types
- Uses `unknown` instead of `any` (no `any` found in codebase)

### Phase 3.4 External Content Provenance
- Provenance tagging is soft defense layer (documented in code comments)
- Tag format: `<external_content source="..." sender="..." trust="...">[content]</external_content>`
- User content NOT wrapped (prevents escaping legitimate angle brackets)
- Both attribute values AND content body sanitized separately
- Tag escape pattern is case-insensitive
- `isInstructions` flag in return type makes contract explicit
- Gear output convenience function uses `gear:${gearId}` format
- Tests cover: all 5 source types, special chars, tag escapes, nested wrapping, unicode, empty/long content
- Common issue: missing explicit return types on exported functions (found 1 in Phase 3.4)

## Common Issues Found

### Architecture
- All component boundaries respected
- Message passing through Axis properly implemented
- Data isolation maintained
- No cross-module internal imports

### Security
- No secrets in code (verified)
- No console.log usage (proper logger abstraction used)
- Error handling follows project patterns
- Input validation at boundaries

### Code Quality
- Explicit return types on all exported functions
- Error handling with typed errors
- Tests use `it` not `test` (verified)
- Files in kebab-case, types in PascalCase
- 2-space indentation, single quotes, trailing commas

## Key Files
- `/Users/shreyas/Development/Projects/meridian/src/axis/axis.ts` - Main Axis runtime class
- `/Users/shreyas/Development/Projects/meridian/src/axis/index.ts` - Public barrel export
- `/Users/shreyas/Development/Projects/meridian/tests/integration/axis-lifecycle.test.ts` - Integration tests
- `/Users/shreyas/Development/Projects/meridian/src/scout/provenance.ts` - External content tagging (Phase 3.4)
- `/Users/shreyas/Development/Projects/meridian/src/scout/provenance.test.ts` - Provenance tests (43 tests)

## Testing Patterns
- Integration tests use temporary directories with random names
- Tests properly clean up resources in `afterEach`
- Tracking processor pattern for async verification
- `waitForCondition` utility for polling assertions
- Tests cover: startup/shutdown, job creation/cancellation, state transitions, crash recovery, worker pool concurrency
