# Security Rules

These rules are non-negotiable. Every code change must comply.

## Secrets

- Secrets are NEVER included in LLM prompts or context
- Secrets are NEVER logged, even at debug level
- Secrets are NEVER stored in plaintext on disk
- Secrets are NEVER committed to version control
- Secrets in memory are zeroed after use
- Every secret has an ACL specifying which Gear can access it

## Input Validation

- All external inputs (Bridge API, WebSocket, Gear results) are validated at the boundary
- Use JSON Schema validation for structured inputs (Fastify's built-in schema validation)
- Never trust client-supplied URLs, paths, or parameters without validation
- Sanitize all paths to prevent directory traversal (no `../` sequences)
- Validate that Gear parameters match their declared JSON Schema before execution

## LLM Safety

- All external content (emails, web pages, docs) MUST be wrapped with provenance tags
- Scout's system prompt MUST instruct it to treat non-user content as untrusted data
- Sentinel MUST NOT have access to the user's original message, Journal, or Gear catalog
- Execution plans MUST be structured JSON, not free-form text
- Plans that don't conform to the schema MUST be rejected

## Gear Sandboxing

- Gear code runs in isolated environments (process or container), never in the main process
- Gear cannot exceed its declared permissions at runtime
- Undeclared filesystem access MUST fail
- Undeclared network requests MUST be blocked
- Private IP ranges (10.x, 172.16.x, 192.168.x, 127.x) are blocked for Gear network requests by default
- Resource limits (memory, CPU, timeout) are enforced by the sandbox

## Authentication

- Bridge authentication is mandatory on all deployments, including localhost
- Passwords are hashed with bcrypt
- Session tokens are cryptographically random, HTTP-only, Secure, SameSite=Strict
- Internal component messages are signed with HMAC-SHA256
- Brute-force protection: exponential backoff after 5 failed attempts

## Network

- Bridge binds to 127.0.0.1 by default, never 0.0.0.0
- Remote access requires explicit TLS configuration
- DNS resolution for Gear is filtered to prevent DNS rebinding attacks

## Audit

- Every significant action is recorded in the append-only audit log
- The application NEVER issues UPDATE or DELETE on audit entries
- Audit log is stored in a separate SQLite database
