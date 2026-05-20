#!/usr/bin/env bash
# Build and/or test the Go server inside a container, so the host
# machine never needs a Go toolchain installed.
#
# Usage:
#   scripts/dev.sh build                         # compile (output discarded — just verifies it builds)
#   scripts/dev.sh test                           # go test ./...
#   scripts/dev.sh test ./internal/store/...      # run a specific package
#   scripts/dev.sh test -run TestMigrateUp ./internal/store/...
#   scripts/dev.sh shell                          # interactive sh inside the container
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-test}"
shift 2>/dev/null || true

case "$CMD" in
  build)
    docker compose -f "$ROOT/docker-compose.yml" run --rm dev \
      go build -trimpath -o /dev/null ./cmd/mnemo-server
    ;;
  test)
    docker compose -f "$ROOT/docker-compose.yml" run --rm dev \
      go test -count=1 "${@:-./...}"
    ;;
  shell)
    docker compose -f "$ROOT/docker-compose.yml" run --rm dev sh
    ;;
  *)
    echo "Usage: $0 {build|test|shell} [go test flags...]" >&2
    exit 1
    ;;
esac
