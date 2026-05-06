#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"

if ! command -v mnemo >/dev/null 2>&1; then
  printf '{}\n'
  exit 0
fi

output="$(printf '%s' "$input" | mnemo hook session-start || true)"
if [ -n "$output" ]; then
  printf '%s\n' "$output"
else
  printf '{}\n'
fi
