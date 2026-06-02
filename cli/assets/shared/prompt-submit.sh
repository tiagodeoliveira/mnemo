#!/usr/bin/env bash
set -euo pipefail
command -v mnemo >/dev/null 2>&1 || exit 0
mnemo hook prompt-submit
