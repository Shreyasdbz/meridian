#!/bin/bash
# PostToolUse hook: Run typecheck after editing TypeScript files
# This runs asynchronously so it doesn't block the conversation.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check TypeScript files
if ! echo "$FILE_PATH" | grep -qE '\.(ts|tsx)$'; then
  exit 0
fi

# Quick type check of the specific file's package
PACKAGE_DIR=$(echo "$FILE_PATH" | grep -oE 'packages/[^/]+' | head -1)
if [ -n "$PACKAGE_DIR" ]; then
  cd "$PACKAGE_DIR" 2>/dev/null && npx tsc --noEmit --pretty false 2>&1 | head -20
fi

exit 0
