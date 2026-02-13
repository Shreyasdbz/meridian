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

### Phase 4.3 Sentinel Integration
- Sentinel class registers with Axis ComponentRegistry as handler for `validate.request` messages
- Returns `validate.response` with ValidationResult payload
- Information barrier enforcement at THREE levels:
  1. Code level: No imports from journal/ or scout/ (ESLint no-restricted-imports + dependency-cruiser)
  2. Message level: Handler checks for barrier-violating payload keys (BARRIER_VIOLATION_KEYS set)
  3. Validation level: Only processes ExecutionPlan, ignores all context fields
- BARRIER_VIOLATION_KEYS: userMessage, conversationHistory, journalData, journalMemories, relevantMemories, gearCatalog, gearManifests, originalMessage
- Barrier violations logged as warnings but don't block processing (defense-in-depth)
- Handler validates message.type === 'validate.request' and plan structure (id, jobId, steps[])
- Factory function `createSentinel(config, deps)` auto-registers with Axis
- `dispose()` method unregisters from Axis (idempotent)
- Tests verify: registration, message dispatch, barrier enforcement, identical results with/without smuggled context
- All 16 integration tests + 15 security tests pass

### Phase 5.2 Process Sandbox (Level 1)
- Two modules: `process-sandbox.ts` (sandbox lifecycle) and `gear-host.ts` (host-side execution)
- HMAC-SHA256 message signing with timing-safe comparison (custom implementation, not crypto.timingSafeEqual directly)
- Secrets injected via tmpfs files (Linux) or temp directory (macOS), NEVER via environment variables
- Secret Buffers zeroed after injection via `buffer.fill(0)`
- Signing key zeroed on GearHost shutdown
- macOS: Seatbelt profiles generated but not enforced via fork() (documentation only in v0.1)
- Linux: Seccomp profiles generated as JSON metadata (enforcement deferred to future implementation)
- Memory limits enforced via `--max-old-space-size` Node.js flag
- Timeout enforced via SIGTERM -> grace period -> SIGKILL pattern
- Path traversal prevention: `resolve()` + `startsWith()` checks on all filesystem paths
- Private IP blocking: 10.x, 172.16-31.x, 192.168.x, 127.x, 0.x, localhost, ::1, fe80::/10
- Domain filtering: exact match, wildcard subdomain (*.example.com), explicit allow-list only
- Provenance tagging: all Gear output wrapped with `_provenance` object at host level (malicious Gear cannot forge)
- Environment isolation: minimal PATH, no HOME/USER/SHELL, only explicitly declared vars passed through
- Sandbox working directory in temp, NOT in workspace (prevents pollution)
- GearHost.execute() flow: integrity check -> create sandbox -> inject secrets -> send/wait -> verify HMAC -> wrap provenance -> destroy sandbox
- Integrity check: re-compute SHA-256 checksum before execution, disable Gear on mismatch
- All 53 unit tests + 39 security tests pass
- No LLM dependency (verified via grep)
- No console.log usage (verified via grep)
- All exported functions have explicit return types (verified)
- TypeScript compilation passes with no errors

### Phase 6.3 WebSocket Server
- WebSocket endpoint at `/api/ws` using `@fastify/websocket` plugin
- Three-step authentication: session cookie → one-time connection token → periodic re-validation (15min)
- Connection token flow: client calls POST /api/ws/token → server returns one-time token → client sends as first WS message → token consumed (replay-safe)
- Tokens stored in `ws_connection_tokens` table with SHA-256 hash, 30s TTL, foreign key to sessions
- Connection limit enforced (10 desktop, 4 Pi, configurable)
- Rate limiting: 60 messages/min per connection, sliding window
- Ping/pong heartbeat: 30s ping interval, 10s pong timeout, disconnect after 2 missed pongs
- Application-level ping/pong (not native WebSocket frames) for explicit timeout control
- Message types: chunk, status, approval_required, result, error, notification, progress, connected, ping, pong
- All message types follow typed-with-metadata pattern (required fields + optional metadata)
- WebSocketManager API: broadcast(), broadcastToSession(), connectionCount(), close()
- Connection tracking: authenticated flag, missed pong counter, rate limit window, three timers (ping, pong, revalidation)
- All timers properly cleaned up in removeConnection() helper
- tokenTimeout cleared in all exit paths (success, failure, close, error)
- Session re-validation uses AuthService.validateSession() every 15 minutes, closes on expiry
- Invalid JSON after auth returns error message but keeps connection alive
- Tests cover: token issuance, auth flow, token replay prevention, all message types, broadcasting, ping/pong, rate limiting, connection limits, manager close, error handling
- 24 tests pass, no type errors, no lint errors
- No console.log, no use of `any`, no Axis imports (Bridge stays in its boundary)

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
- `/Users/shreyas/Development/Projects/meridian/src/sentinel/sentinel.ts` - Sentinel component (Phase 4.3)
- `/Users/shreyas/Development/Projects/meridian/src/sentinel/index.ts` - Sentinel public API
- `/Users/shreyas/Development/Projects/meridian/tests/integration/sentinel-axis.test.ts` - Sentinel-Axis integration (16 tests)
- `/Users/shreyas/Development/Projects/meridian/tests/security/sentinel-barrier.test.ts` - Information barrier security (15 tests)
- `/Users/shreyas/Development/Projects/meridian/src/gear/sandbox/process-sandbox.ts` - Level 1 sandbox implementation (Phase 5.2)
- `/Users/shreyas/Development/Projects/meridian/src/gear/sandbox/gear-host.ts` - Host-side Gear execution (Phase 5.2)
- `/Users/shreyas/Development/Projects/meridian/src/gear/sandbox/process-sandbox.test.ts` - Sandbox unit tests (53 tests)
- `/Users/shreyas/Development/Projects/meridian/tests/security/sandbox-escape.test.ts` - Sandbox security tests (39 tests)
- `/Users/shreyas/Development/Projects/meridian/src/bridge/api/websocket.ts` - WebSocket server (Phase 6.3)
- `/Users/shreyas/Development/Projects/meridian/src/bridge/api/websocket.test.ts` - WebSocket tests (24 tests)
- `/Users/shreyas/Development/Projects/meridian/src/axis/migrations/005_ws_tokens.sql` - Connection token table migration

## Testing Patterns
- Integration tests use temporary directories with random names
- Tests properly clean up resources in `afterEach`
- Tracking processor pattern for async verification
- `waitForCondition` utility for polling assertions
- Tests cover: startup/shutdown, job creation/cancellation, state transitions, crash recovery, worker pool concurrency
