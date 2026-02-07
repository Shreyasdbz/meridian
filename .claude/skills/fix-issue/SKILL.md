---
name: fix-issue
description: Fix a bug or issue in the Meridian codebase
argument-hint: "[issue description or GitHub issue number]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

Fix the following issue: $ARGUMENTS

## Process

1. Understand the issue — read any referenced files, error messages, or stack traces
2. Identify the root cause by tracing through the relevant package(s)
3. Check the architecture document if the fix involves component boundaries
4. Implement the fix with minimal changes — don't refactor surrounding code
5. Write a regression test that reproduces the original issue and verifies the fix
6. Run the test suite for the affected package: `npm run test -- --run packages/<package>/tests/`
7. Run `npm run typecheck` to verify no type errors
8. Verify the fix doesn't violate any security rules (see `.claude/rules/security.md`)
