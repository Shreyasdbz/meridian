#!/bin/bash
# PreToolUse hook: Block writes that might expose secrets or violate security rules
# This hook validates Edit and Write operations for common security issues.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Edit and Write tools
if [ "$TOOL_NAME" != "Edit" ] && [ "$TOOL_NAME" != "Write" ]; then
  exit 0
fi

# Get the file content being written
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Block writes to secrets.vault
if echo "$FILE_PATH" | grep -q "secrets.vault"; then
  echo "Blocked: Cannot directly write to secrets.vault — use the secrets management API" >&2
  exit 2
fi

# Block writes that contain hardcoded API keys or tokens
if echo "$CONTENT" | grep -iE '(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36}|Bearer [a-zA-Z0-9._-]{20,})' > /dev/null 2>&1; then
  echo "Blocked: Content appears to contain a hardcoded API key or token. Use the encrypted vault instead." >&2
  exit 2
fi

exit 0
