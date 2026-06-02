#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"

if command -v mnemo >/dev/null 2>&1; then
  printf '%s' "$input" | mnemo hook prompt-submit >/dev/null || true
fi

printf '{}\n'
