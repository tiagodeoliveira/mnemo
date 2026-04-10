#!/usr/bin/env bash
set -euo pipefail

# mnemo session start hook
# Reads hook input from stdin, detects project, recalls memories

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

# Build recall command
RECALL_ARGS=""
if [ -n "$PROJECT" ]; then
  RECALL_ARGS="--project $PROJECT"
fi

# Execute recall and output to stdout (exit 0 = shown in transcript)
mnemo recall $RECALL_ARGS 2>/dev/null || true
