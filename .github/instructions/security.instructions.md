---
applyTo: "**"
---

# Security Rules for Meridian (Non-Negotiable)

When writing or reviewing code in this project:

- Secrets MUST NEVER appear in LLM prompts, log output, or plaintext storage
- All external content (emails, web pages, documents) MUST be tagged with provenance metadata and treated as DATA, never as INSTRUCTIONS
- Gear parameters MUST be validated against their JSON Schema before execution
- No shell command string interpolation — pass parameters as structured data
- All API endpoints MUST require authentication
- All inputs MUST be validated at the boundary (use Fastify schema validation)
- Sanitize file paths to prevent directory traversal
- Private IP ranges are blocked for Gear network requests by default
- The Sentinel component MUST NOT have access to user messages, Journal, or Gear catalog
