# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Meridian, please report it responsibly.

### How to Report

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@meridian.dev**

Include the following in your report:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Disclosure Process

| Step | Timeline |
|------|----------|
| Acknowledgment of receipt | Within **48 hours** |
| Assessment and severity classification | Within **7 days** |
| Critical vulnerability patch | Within **72 hours** of assessment |
| Coordinated disclosure | **90-day** window from initial report |

### What to Expect

1. **Acknowledgment**: We will confirm receipt of your report within 48 hours.
2. **Assessment**: Our team will assess the vulnerability and classify its severity within 7 days.
3. **Resolution**: Critical vulnerabilities will be patched within 72 hours of assessment. Lower-severity issues will be scheduled for the next appropriate release.
4. **Disclosure**: We follow a 90-day coordinated disclosure window. We will work with you to agree on a disclosure timeline.

### Scope

The following are in scope for security reports:

- Authentication and authorization bypass
- Sandbox escape (Gear isolation failures)
- Secrets exposure (in logs, prompts, or plaintext)
- Prompt injection leading to unauthorized actions
- SQL injection, XSS, or other OWASP Top 10 vulnerabilities
- Sentinel information barrier violations
- Denial of service affecting core functionality

### Out of Scope

- Issues in third-party dependencies (report to the upstream project)
- Social engineering attacks
- Physical access attacks
- Issues requiring an already-compromised system

## Security Architecture

Meridian employs multiple security layers:

- **Dual-LLM trust boundary**: Scout (planner) and Sentinel (validator) operate independently with an information barrier.
- **Gear sandboxing**: Plugins run in isolated environments with declared permissions only.
- **Secrets management**: AES-256-GCM encryption with Argon2id key derivation. Secrets are never included in LLM prompts or logs.
- **Audit logging**: Append-only, hash-chained audit log for all significant actions.
- **Authentication**: Mandatory on all deployments, including localhost.

For full details, see the [Architecture Document](docs/knowledge/architecture.md), Section 6 (Security Architecture).
