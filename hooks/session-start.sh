#!/usr/bin/env bash
set -euo pipefail

# mnemo session start hook (SessionStart)
# Reads hook input from stdin, detects project, recalls memories.
# Outputs Claude Code hook JSON format for hidden context injection.

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

# Detect project from git repo
PROJECT=""
if git -C "$CWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  PROJECT=$(basename "$(git -C "$CWD" rev-parse --show-toplevel)")
fi

# Build recall command args
RECALL_ARGS=()
if [ -n "$PROJECT" ]; then
  RECALL_ARGS+=(--project "$PROJECT")
fi
RECALL_ARGS+=(--task coding)
RECALL_ARGS+=(--date "$(date +%Y-%m-%d)")
RECALL_ARGS+=(--format hook)
RECALL_ARGS+=(--no-episodes)

# Execute recall — output is already formatted as Claude Code hook JSON
# (formatRecallOutput with visible=false returns the proper JSON structure)
RESULT=$(mnemo recall "${RECALL_ARGS[@]}" 2>/dev/null) || exit 0

if [ -n "$RESULT" ]; then
  echo "$RESULT"
fi
