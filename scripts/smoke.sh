#!/usr/bin/env bash
#
# Local end-to-end smoke test for mnemo.
#
# What it does:
#   1. Brings up the local Postgres compose service.
#   2. Builds the mnemo-server binary and runs it in the background
#      (auth disabled, real Anthropic LLM via $ANTHROPIC_API_KEY).
#   3. POSTs 3 events designed to populate every memory dimension.
#   4. Manually enqueues a daily_digest job (the scheduler only fires
#      at :19:00 in the actor's TZ; we don't want to wait).
#   5. Polls the jobs table until empty (or timeout).
#   6. Queries each dimension's namespace and asserts:
#        - At least one row exists.
#        - The content contains a distinctive keyword planted in the
#          input event.
#   7. Prints a pass/fail table and exits 0 (all green) or 1 (any red).
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke.sh
#
# Env overrides:
#   MNEMO_SMOKE_PORT     — port the server binds (default 8080)
#   MNEMO_SMOKE_TIMEOUT  — seconds to wait for jobs to drain (default 180)
#   MNEMO_SMOKE_KEEP=1   — leave Postgres + the server running at the end
#                          for manual inspection. Default: stop both.
#   MNEMO_LLM_MODEL      — override the Claude model (default claude-sonnet-4-7-20251015)
#
# Why "presence + keyword" rather than exact-content checks?
#   LLM output is non-deterministic. The keywords we plant are
#   distinctive enough that, if the prompt+parser+writer pipeline is
#   healthy, the planted strings will survive into the stored content.
#   If a future prompt change paraphrases them out, that's a real
#   regression worth knowing about.

set -euo pipefail

# ─── Config ────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${MNEMO_SMOKE_PORT:-8080}"
TIMEOUT="${MNEMO_SMOKE_TIMEOUT:-180}"
KEEP="${MNEMO_SMOKE_KEEP:-0}"
MODEL="${MNEMO_LLM_MODEL:-claude-sonnet-4-7-20251015}"

RUN_ID="smoke-$(date +%s)"
ACTOR="dev-actor"
DATE="$(date -u +%Y-%m-%d)"
DSN="postgres://mnemo:mnemo@localhost:5432/mnemo?sslmode=disable"

SERVER_PID=""
BIN="/tmp/mnemo-smoke-server"

# ─── Output helpers ────────────────────────────────────────────────
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; BOLD=$'\033[1m'; RST=$'\033[0m'
step()   { echo "${BLUE}${BOLD}== $* ==${RST}"; }
info()   { echo "   $*"; }
ok()     { echo "${GREEN}   PASS${RST}  $*"; }
fail()   { echo "${RED}   FAIL${RST}  $*"; }
warn()   { echo "${YELLOW}   WARN${RST}  $*"; }

# ─── Pre-flight ────────────────────────────────────────────────────
require_env() {
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "${RED}ANTHROPIC_API_KEY is required${RST}" >&2
    echo "  This script makes real Anthropic API calls. Set the env var and rerun." >&2
    exit 2
  fi
}

require_tools() {
  local missing=()
  for t in docker curl jq go; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  if (( ${#missing[@]} > 0 )); then
    echo "${RED}Missing required tools: ${missing[*]}${RST}" >&2
    exit 2
  fi
}

# ─── Postgres ──────────────────────────────────────────────────────
psql_in() {
  docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U mnemo -d mnemo -t -A -c "$1"
}

bring_up_postgres() {
  step "bring up Postgres"
  (cd "$REPO_ROOT" && docker compose up -d postgres >/dev/null)
  for _ in $(seq 1 30); do
    if docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
        pg_isready -U mnemo -d mnemo >/dev/null 2>&1; then
      ok "Postgres healthy"
      return
    fi
    sleep 1
  done
  fail "Postgres did not become healthy within 30s"
  exit 1
}

# ─── Server lifecycle ──────────────────────────────────────────────
build_server() {
  step "build mnemo-server"
  (cd "$REPO_ROOT/server" && go build -o "$BIN" ./cmd/mnemo-server)
  ok "built $BIN"
}

start_server() {
  step "start mnemo-server (auth disabled, real LLM)"
  DATABASE_URL="$DSN" \
  MNEMO_PORT="$PORT" \
  MNEMO_AUTH_DISABLED=1 \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  MNEMO_LLM_MODEL="$MODEL" \
  "$BIN" >/tmp/mnemo-smoke.log 2>&1 &
  SERVER_PID=$!
  info "PID=$SERVER_PID, log=/tmp/mnemo-smoke.log"

  for _ in $(seq 1 20); do
    if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
      ok "server up on :$PORT"
      return
    fi
    sleep 0.5
  done
  fail "server did not become healthy within 10s"
  cat /tmp/mnemo-smoke.log
  exit 1
}

stop_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -INT "$SERVER_PID" 2>/dev/null || true
    # Wait up to 5s for graceful shutdown.
    for _ in $(seq 1 10); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
}

cleanup() {
  local rc=$?
  if [[ "$KEEP" == "1" ]]; then
    info "MNEMO_SMOKE_KEEP=1, leaving server + Postgres running for inspection"
    info "  Server log: /tmp/mnemo-smoke.log"
    info "  Server PID: $SERVER_PID"
    info "  Stop with: kill $SERVER_PID && docker compose down"
  else
    stop_server
    (cd "$REPO_ROOT" && docker compose down >/dev/null 2>&1 || true)
  fi
  exit "$rc"
}

# ─── Events ────────────────────────────────────────────────────────
# Each event plants distinct keywords in fields we expect to survive
# into specific dimensions. The keyword tokens are chosen to be both
# semantically appropriate AND distinctive enough to grep for.

post_event() {
  local body="$1"
  curl -fsS -X POST "http://localhost:$PORT/events" \
    -H "content-type: application/json" \
    -d "$body" | jq -r '.event_id'
}

send_rich_event() {
  step "POST /events — rich coding event (keywords: 'rustacean', 'Principal Engineer', 'SKIP LOCKED', 'deployed mnemo-smoke')"
  local body
  body=$(jq -c -n --arg sid "$RUN_ID-1" '{
    session_id: $sid,
    project: "mnemo-smoke",
    source: "smoke-script",
    workdir: "/tmp/mnemo-smoke",
    turns: [
      {role: "user", content:
        "Quick context — I am Tiago, a Principal Engineer at AWS based in the Seattle area. I grew up in Xanxerê. " +
        "Today I am smoke testing the mnemo Go server. I prefer rustacean style for my code (small types, " +
        "errors as values). The interesting part of the design is the in-process worker pool that claims jobs " +
        "with SELECT FOR UPDATE SKIP LOCKED — no Redis, no SQS, just Postgres. " +
        "Yesterday I deployed mnemo-smoke for the first time and was reminded that integration tests catch more " +
        "than I expect; next time I should write them earlier."},
      {role: "assistant", content:
        "Got it. Principal Engineer, Seattle, originally from Xanxerê. Preference noted: rustacean code style. " +
        "Project: mnemo-smoke, using Postgres SKIP LOCKED for the job queue. Reflection on yesterday: " +
        "integration tests earlier."}
    ],
    attributes: {owner: "tiago", smoke: "true"}
  }')
  local id; id=$(post_event "$body")
  info "event_id: $id"
}

send_meeting_event() {
  step "POST /events — meeting ending (keyword: 'ship it tonight' in highlights)"
  local body
  body=$(jq -c -n --arg sid "$RUN_ID-meeting" '{
    session_id: $sid,
    source: "smoke-script",
    turns: [
      {role: "user", content:
        "[Speaker 1] Welcome everyone. Today we are deciding whether the mnemo-smoke rewrite is ready to ship.\n" +
        "[Speaker 2] I reviewed the diff. Tests pass, deploy doc looks good.\n" +
        "[Speaker 1] OK then. Lets ship it tonight.\n" +
        "[Speaker 2] Agreed. I will draft the announcement by Friday."}
    ],
    attributes: {meeting_id: "smoke-meeting", meeting_ended: true}
  }')
  local id; id=$(post_event "$body")
  info "event_id: $id"
}

enqueue_daily_digest() {
  step "manually enqueue a daily_digest job (skip the 7pm scheduler wait)"
  psql_in "INSERT INTO jobs (kind, payload) VALUES ('daily_digest', '{\"actor_id\":\"$ACTOR\",\"date\":\"$DATE\"}'::jsonb);"
  ok "daily_digest enqueued for $ACTOR / $DATE"
}

# ─── Wait for jobs ─────────────────────────────────────────────────
wait_for_jobs() {
  step "wait for jobs to drain (timeout: ${TIMEOUT}s)"
  local deadline=$(( $(date +%s) + TIMEOUT ))
  local last_state=""
  while (( $(date +%s) < deadline )); do
    local state
    state=$(psql_in "SELECT
      coalesce(sum(CASE WHEN state='pending' THEN 1 ELSE 0 END), 0) || '/' ||
      coalesce(sum(CASE WHEN state='running' THEN 1 ELSE 0 END), 0) || '/' ||
      coalesce(sum(CASE WHEN state='done' THEN 1 ELSE 0 END), 0) || '/' ||
      coalesce(sum(CASE WHEN state='failed' THEN 1 ELSE 0 END), 0)
      FROM jobs;" | tr -d ' ')
    if [[ "$state" != "$last_state" ]]; then
      info "  pending/running/done/failed = $state"
      last_state="$state"
    fi
    local pending_running
    pending_running=$(psql_in "SELECT count(*) FROM jobs WHERE state IN ('pending','running');" | tr -d ' ')
    if [[ "$pending_running" == "0" ]]; then
      ok "all jobs drained"
      return
    fi
    sleep 2
  done
  fail "jobs did not drain within ${TIMEOUT}s"
  psql_in "SELECT job_id, kind, state, attempts, last_error FROM jobs ORDER BY job_id;" || true
  return 1
}

# ─── Dimension checks ──────────────────────────────────────────────
# Each check: (dimension, namespace-prefix, keyword)
# Pass = at least 1 row matching namespace prefix AND content contains keyword (case-insensitive).

declare -a RESULTS=()

check_dim() {
  local label="$1" namespace_like="$2" keyword="$3"
  local row_count
  row_count=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}';" | tr -d ' ')
  if [[ "$row_count" == "0" ]]; then
    fail "$label: 0 rows under ${namespace_like}"
    RESULTS+=("FAIL|$label|no rows")
    return
  fi
  # Case-insensitive grep across all matching rows.
  local hits
  hits=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}' AND content ILIKE '%${keyword}%';" | tr -d ' ')
  if [[ "$hits" == "0" ]]; then
    fail "$label: $row_count row(s) present but no row contains '$keyword'"
    info "  first row content snippet:"
    psql_in "SELECT substr(content, 1, 200) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}' ORDER BY updated_at DESC LIMIT 1;" | sed 's/^/    /'
    RESULTS+=("FAIL|$label|missing keyword '$keyword'")
    return
  fi
  ok "$label: $row_count row(s), $hits contain '$keyword'"
  RESULTS+=("PASS|$label|$row_count row(s), $hits with '$keyword'")
}

run_checks() {
  step "verify each dimension"
  check_dim "preferences"   "/preferences/${ACTOR}/"                        "rustacean"
  check_dim "episodes"      "/episodes/${ACTOR}/%"                          "deployed mnemo-smoke"
  check_dim "about"         "/about/${ACTOR}/"                              "Principal Engineer"
  check_dim "project"       "/projects/${ACTOR}/mnemo-smoke/"               "SKIP LOCKED"
  check_dim "task"          "/tasks/${ACTOR}/coding/"                       "SKIP LOCKED"
  check_dim "daily_log"     "/daily/${ACTOR}/${DATE}/log/"                  "smoke test"
  check_dim "daily_summary" "/daily/${ACTOR}/${DATE}/summary/"              "smoke"
  check_dim "meeting"       "/meetings/${ACTOR}/smoke-meeting/highlights/"  "ship it tonight"
}

print_report() {
  step "summary"
  local pass=0 fail=0
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r status label note <<<"$r"
    if [[ "$status" == "PASS" ]]; then
      printf "  ${GREEN}PASS${RST}  %-15s  %s\n" "$label" "$note"
      (( pass++ )) || true
    else
      printf "  ${RED}FAIL${RST}  %-15s  %s\n" "$label" "$note"
      (( fail++ )) || true
    fi
  done
  echo
  if (( fail > 0 )); then
    echo "${RED}${BOLD}${fail} dimension(s) failed${RST} (${pass} passed)"
    return 1
  fi
  echo "${GREEN}${BOLD}all ${pass} dimensions green${RST}"
}

# ─── Main ──────────────────────────────────────────────────────────
main() {
  require_env
  require_tools
  trap cleanup EXIT INT TERM

  bring_up_postgres
  build_server
  start_server

  send_rich_event
  send_meeting_event

  step "wait briefly for extract_context + finalize_meeting to start, then enqueue digest"
  sleep 5  # gives extract_context a head start so daily_log rows exist when digest runs

  # The digest needs daily_log entries to exist. Wait for the extract handler to write them.
  for _ in $(seq 1 60); do
    local n
    n=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND dimension='daily_log';" | tr -d ' ')
    if [[ "$n" != "0" ]]; then
      info "daily_log has $n row(s); enqueueing digest"
      break
    fi
    sleep 2
  done
  enqueue_daily_digest

  wait_for_jobs
  run_checks
  print_report
}

main "$@"
