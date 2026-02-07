---
description: 'Scaffold a new Meridian package in the monorepo'
agent: 'agent'
---

Create a new package in the Meridian monorepo.

## Package: $PROMPT_INPUT

### Steps

1. Create the directory structure:
   ```
   packages/<name>/
     src/
       index.ts
     tests/
       <name>.test.ts
     package.json
     tsconfig.json
   ```

2. The `package.json` should:
   - Use `@meridian/<name>` as the package name
   - Set `"type": "module"`
   - Reference `@meridian/shared` as a workspace dependency
   - Include `build`, `test`, `typecheck` scripts

3. The `tsconfig.json` should extend the root config

4. Export types and main functionality from `src/index.ts`

5. Include a basic test file

6. Update the root `package.json` workspaces array if needed

Follow Meridian conventions: ES modules, TypeScript strict mode, 2-space indent, single quotes.
