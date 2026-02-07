---
name: add-gear
description: Create a new Gear (plugin) with proper manifest, sandbox compliance, and tests
argument-hint: "[gear-name] [description of what it does]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

Create a new Gear plugin: $ARGUMENTS

## Process

1. Read the Gear specification in `docs/architecture.md` (Section 5.6)
2. Create the Gear directory structure:
   ```
   packages/gear/builtin/<gear-name>/
     index.ts        # Gear implementation
     manifest.ts     # GearManifest definition
     <gear-name>.test.ts  # Tests
   ```
3. Define the `GearManifest` with:
   - Identity: id, name, version, description, author, license
   - Actions: each with name, description, parameters (JSON Schema), returns, riskLevel
   - Permissions: only declare what's actually needed (filesystem, network, secrets, shell)
   - Resources: memory limit, CPU limit, timeout
   - Origin: `'builtin'`
4. Implement actions using only the `GearContext` API:
   - `params`, `getSecret()`, `readFile()`, `writeFile()`, `listFiles()`, `fetch()`, `log()`, `progress()`
   - Do NOT use `process`, `require('child_process')`, or raw filesystem access
5. Write tests that verify:
   - Happy path for each action
   - Permission enforcement (attempting undeclared operations fails)
   - Error handling for edge cases
   - Manifest validity
6. Run tests: `npm run test -- --run packages/gear/tests/`
