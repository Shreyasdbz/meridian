---
applyTo: "packages/bridge/src/api/**"
---

# Bridge API Conventions

- Use Fastify with TypeScript
- All endpoints require authentication (session cookie or Bearer token)
- Use Fastify's built-in JSON Schema validation for request/response
- Rate limit: 100 requests/minute by default
- WebSocket endpoint at `/api/ws` for real-time streaming
- REST endpoints follow the pattern defined in architecture.md Section 9.2
- Log all API calls to the audit log (no secrets in logs)
- Return proper HTTP status codes and structured error responses
- Use parameterized queries for all database operations (no SQL injection)
