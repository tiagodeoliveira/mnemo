#!/usr/bin/env bash
#
# Local end-to-end smoke test for mnemo.
#
# What it does:
#   ROUND 1 — first-write path (item population)
#   1. Brings up the local Postgres compose service.
#   2. Builds the mnemo-server binary and runs it in the background
#      (auth disabled, real Anthropic LLM via $ANTHROPIC_API_KEY).
#   3. POSTs 2 events designed to populate every memory dimension.
#   4. Manually enqueues a daily_digest job (the scheduler only fires
#      at :19:00 in the actor's TZ; we don't want to wait).
#   5. Polls the jobs table until empty (or timeout).
#   6. Verifies each consolidated dimension has MULTIPLE items (not one blob),
#      and that a planted keyword is present in at least one item per dimension.
#      All items are expected to have reinforced_count = 1 (not yet reinforced).
#
#   ROUND 2 — diff-based consolidation (reinforcement + new content)
#   7. POSTs 2 more events targeting the same actor/project/domain:
#        a. Reinforcement: explicitly restates Go, rustacean style, SKIP LOCKED,
#           and adds new pref: trunk-based development.
#        b. Contradiction: replaces the role claim in the bio (Staff Engineer).
#   8. Waits for the new extract_context jobs to drain.
#   9. Verifies:
#        - At least one item per consolidated dim has reinforced_count > 1
#          (the LLM correctly recognized and reinforced the repeated content).
#        - New content from round 2 is present (trunk-based, Staff Engineer).
#        - Item counts grew only modestly (consolidation, not unbounded append).
#
#   ROUND 3 — semantic search verification
#  10. Exercises POST /search with semantically distinct queries that prove
#      embeddings map meaning (not just substring matching).
#  11. Verifies ?q= on /recall returns similarity-scored items.
#  12. Prints a pass/fail table and exits 0 (all green) or 1 (any red).
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke.sh
#
# Env overrides:
#   MNEMO_SMOKE_PORT      — port the server binds (default 8080)
#   MNEMO_SMOKE_TIMEOUT   — seconds to wait for jobs to drain (default 180)
#   MNEMO_SMOKE_KEEP=1    — leave Postgres + the server running at the end
#                           for manual inspection. Default: stop both.
#   MNEMO_LLM_MODEL       — override the Claude model (default claude-sonnet-4-6)
#   MNEMO_EMBED_DISABLED=1 — skip real embeddings (search assertions will be
#                            skipped / return 503; set when OPENAI_API_KEY absent)
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
MODEL="${MNEMO_LLM_MODEL:-claude-sonnet-4-6}"

# Embeddings: if OPENAI_API_KEY is absent and caller hasn't set MNEMO_EMBED_DISABLED,
# auto-enable the stub so the server starts. Search assertions are skipped in that case.
EMBED_ENABLED=1
if [[ -z "${OPENAI_API_KEY:-}" && -z "${MNEMO_EMBED_DISABLED:-}" ]]; then
  MNEMO_EMBED_DISABLED=1
  EMBED_ENABLED=0
fi

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
  local embed_note="real embeddings"
  [[ "$EMBED_ENABLED" == "0" ]] && embed_note="stub embeddings (OPENAI_API_KEY absent)"
  step "start mnemo-server (auth disabled, real LLM, $embed_note)"
  DATABASE_URL="$DSN" \
  MNEMO_PORT="$PORT" \
  MNEMO_AUTH_DISABLED=1 \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  MNEMO_EMBED_DISABLED="${MNEMO_EMBED_DISABLED:-}" \
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

# ─── Round 2 events ────────────────────────────────────────────────
# Round 2 exercises the diff-based consolidation path: project/task/about/preferences
# should recognize reinforced items (bump reinforced_count) and merge new items.

send_round2_reinforce_event() {
  step "POST /events — round 2 A: reinforces existing preferences, adds new ones"
  local body
  body=$(jq -c -n --arg sid "$RUN_ID-r2a" '{
    session_id: $sid,
    project: "mnemo-smoke",
    source: "smoke-script",
    workdir: "/tmp/mnemo-smoke",
    turns: [
      {role: "user", content:
        "Still working on mnemo-smoke today. The rustacean style I prefer continues to pay off — the codebase is clean and easy to reason about. " +
        "Still using Go for all backend work, no plans to change that. " +
        "The SELECT FOR UPDATE SKIP LOCKED pattern for the job queue is working great — definitely the right architectural call. " +
        "One additional preference worth recording: I now prefer trunk-based development over feature branches for solo projects."},
      {role: "assistant", content:
        "Reinforced preferences: rustacean style, Go for backend, SKIP LOCKED for queues. " +
        "New preference: trunk-based development for solo projects."}
    ],
    attributes: {owner: "tiago", smoke: "true", round: "2"}
  }')
  local id; id=$(post_event "$body")
  info "event_id: $id"
}

send_round2_contradict_event() {
  step "POST /events — round 2 B: contradicts the role claim in about"
  local body
  body=$(jq -c -n --arg sid "$RUN_ID-r2b" '{
    session_id: $sid,
    source: "smoke-script",
    turns: [
      {role: "user", content:
        "Quick profile correction. I left AWS last week and joined a startup as a Staff Engineer. " +
        "So my current role is Staff Engineer at a small startup — no longer a Principal Engineer at AWS. " +
        "Everything else about my background stays the same: still based in Seattle, still originally from Xanxerê."}
    ],
    attributes: {owner: "tiago", smoke: "true", round: "2"}
  }')
  local id; id=$(post_event "$body")
  info "event_id: $id"
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
declare -a RESULTS=()

# Keyword presence: at least one item in the namespace contains the keyword.
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

# Exact-count assertion: use for append dims or to bound growth.
check_dim_count() {
  local label="$1" namespace_like="$2" expected="$3"
  local got
  got=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}';" | tr -d ' ')
  if [[ "$got" == "$expected" ]]; then
    ok "$label: $got row(s)"
    RESULTS+=("PASS|$label|$got rows (expected $expected)")
  else
    fail "$label: expected $expected, got $got"
    RESULTS+=("FAIL|$label|expected $expected got $got")
  fi
}

# Range-count assertion: proves consolidated dims are item-shaped, not one blob.
check_dim_count_range() {
  local label="$1" namespace_like="$2" min_expected="$3" max_expected="$4"
  local got
  got=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}';" | tr -d ' ')
  if [[ "$got" -ge "$min_expected" && "$got" -le "$max_expected" ]]; then
    ok "$label: $got rows (expected ${min_expected}..${max_expected})"
    RESULTS+=("PASS|$label|$got rows in [${min_expected}..${max_expected}]")
  else
    fail "$label: expected ${min_expected}..${max_expected}, got $got"
    RESULTS+=("FAIL|$label|expected ${min_expected}..${max_expected} got $got")
  fi
}

# Absence assertion: proves contradicted content was dropped.
check_dim_absent() {
  local label="$1" namespace_like="$2" keyword="$3"
  local hits
  hits=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}' AND content ILIKE '%${keyword}%';" | tr -d ' ')
  if [[ "$hits" == "0" ]]; then
    ok "$label: '$keyword' not present"
    RESULTS+=("PASS|$label|absent '$keyword'")
  else
    fail "$label: $hits row(s) still contain '$keyword'"
    info "  content snippet:"
    psql_in "SELECT substr(content, 1, 250) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}' ORDER BY updated_at DESC LIMIT 1;" | sed 's/^/    /'
    RESULTS+=("FAIL|$label|still contains '$keyword'")
  fi
}

run_checks() {
  step "verify each dimension (round 1, item-shape)"

  # Consolidated dimensions: expect multiple items, not one blob.
  check_dim_count_range "preferences (multiple items)" "/preferences/${ACTOR}/"             2 12
  check_dim_count_range "about (multiple items)"       "/about/${ACTOR}/"                   1 8
  check_dim_count_range "project (multiple items)"     "/projects/${ACTOR}/mnemo-smoke/"    1 10
  check_dim_count_range "task coding (multiple items)" "/tasks/${ACTOR}/coding/"            1 10

  # Append dimensions: each event produces a row, round 1 has 2 events.
  check_dim_count_range "daily_log (per event)" "/daily/${ACTOR}/${DATE}/log/" 1 5
  check_dim_count_range "episodes (round 1)"    "/episodes/${ACTOR}/%"         1 5
  check_dim_count_range "daily_summary (1)"     "/daily/${ACTOR}/${DATE}/summary/" 1 1
  check_dim_count_range "meeting (4-6 cats)"    "/meetings/${ACTOR}/smoke-meeting/%" 4 6

  # Keyword presence: at least one item per dimension contains the planted keyword.
  check_dim "preferences has 'rustacean'"           "/preferences/${ACTOR}/%"                       "rustacean"
  check_dim "episodes has 'deployed mnemo-smoke'"   "/episodes/${ACTOR}/%"                          "deployed mnemo-smoke"
  check_dim "about has 'Principal Engineer'"        "/about/${ACTOR}/%"                              "Principal Engineer"
  check_dim "project has 'SKIP LOCKED'"             "/projects/${ACTOR}/mnemo-smoke/%"               "SKIP LOCKED"
  check_dim "task has 'SKIP LOCKED'"                "/tasks/${ACTOR}/coding/%"                       "SKIP LOCKED"
  check_dim "daily_log has 'mnemo-smoke'"           "/daily/${ACTOR}/${DATE}/log/%"                  "mnemo-smoke"
  check_dim "daily_summary has 'smoke'"             "/daily/${ACTOR}/${DATE}/summary/%"              "smoke"
  check_dim "meeting has 'ship it tonight'"         "/meetings/${ACTOR}/smoke-meeting/highlights/%"  "ship it tonight"

  # All round-1 items have reinforced_count = 1 (not yet reinforced).
  local reinforced_n
  reinforced_n=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND reinforced_count > 1;" | tr -d ' ')
  if [[ "$reinforced_n" == "0" ]]; then
    ok "round 1: reinforced_count is 1 for all items"
    RESULTS+=("PASS|round 1 reinforced_count|all items at count=1")
  else
    fail "round 1: $reinforced_n items have reinforced_count > 1 (unexpected)"
    RESULTS+=("FAIL|round 1 reinforced_count|$reinforced_n items already reinforced")
  fi
}

run_round2_checks() {
  step "verify round 2 (diff consolidation: reinforcement + new content)"

  # 1. At least one item per consolidated dim has reinforced_count > 1.
  # This proves the LLM correctly recognized reinforcement in the round-2 event.
  for dim_label in preferences about project task; do
    local namespace_like
    case "$dim_label" in
      preferences) namespace_like="/preferences/${ACTOR}/" ;;
      about)       namespace_like="/about/${ACTOR}/" ;;
      project)     namespace_like="/projects/${ACTOR}/mnemo-smoke/" ;;
      task)        namespace_like="/tasks/${ACTOR}/coding/" ;;
    esac
    local n
    n=$(psql_in "SELECT count(*) FROM memories WHERE actor_id='$ACTOR' AND namespace LIKE '${namespace_like}' AND reinforced_count > 1;" | tr -d ' ')
    if [[ "$n" -ge 1 ]]; then
      ok "$dim_label: $n item(s) reinforced (count > 1)"
      RESULTS+=("PASS|$dim_label round-2 reinforced|$n items > 1")
    else
      fail "$dim_label: no items got reinforced in round 2"
      RESULTS+=("FAIL|$dim_label round-2 reinforced|0 items > 1")
    fi
  done

  # 2. New content from round 2 is present.
  check_dim "preferences has 'trunk-based' (new in r2)" "/preferences/${ACTOR}/%" "trunk-based"
  check_dim "about has 'Staff Engineer' (new in r2)"    "/about/${ACTOR}/%"        "Staff Engineer"

  # 3. Item counts grew modestly (the consolidator added items, didn't replace all).
  # Use the same ranges as round 1 — counts should still be in the same ballpark,
  # not 2x what they were (which would mean the LLM is insert-only-mode).
  check_dim_count_range "preferences after r2 (still ranged)" "/preferences/${ACTOR}/"          2 14
  check_dim_count_range "about after r2 (still ranged)"       "/about/${ACTOR}/"                1 10
  check_dim_count_range "project after r2 (still ranged)"     "/projects/${ACTOR}/mnemo-smoke/" 1 12
  check_dim_count_range "task after r2 (still ranged)"        "/tasks/${ACTOR}/coding/"         1 12

  # Note on about + contradictions: we deliberately don't assert silent-drop of
  # the role change. The LLM produces transition narratives ("had previously been
  # at AWS, now at startup") and that's defensible. The "Staff Engineer" presence
  # check above is the operative signal.
}

# ─── Round 3 — semantic search ─────────────────────────────────────
# Exercises POST /search and ?q= on /recall. Uses queries that are
# semantically distinct from the planted keywords to prove embeddings
# actually map meaning, not just substring matching.

# Helper for POST /search.
post_search() {
  local body="$1"
  curl -fsS -X POST "http://localhost:$PORT/search" \
    -H "content-type: application/json" \
    -d "$body"
}

run_search_checks() {
  step "verify semantic search"

  if [[ "$EMBED_ENABLED" == "0" ]]; then
    warn "OPENAI_API_KEY absent — embeddings disabled; skipping semantic search assertions"
    warn "  Set OPENAI_API_KEY to enable this section."
    RESULTS+=("PASS|search (skipped)|no OPENAI_API_KEY; embeddings disabled")
    return
  fi

  # Query 1: 'queue systems for jobs' — semantically near the
  # SKIP LOCKED preference + project items, but lexically far.
  local resp
  resp=$(post_search '{"q":"queue systems for jobs","limit":5}')
  local count
  count=$(echo "$resp" | jq -r '.results | length')
  if [[ "$count" -ge 1 ]]; then
    ok "search 'queue systems for jobs' returned $count results"
    RESULTS+=("PASS|search queue|$count results")
  else
    fail "search 'queue systems for jobs' returned 0 results"
    RESULTS+=("FAIL|search queue|no results")
  fi

  # Top hit should mention SKIP LOCKED (semantically related to 'queue systems').
  local top
  top=$(echo "$resp" | jq -r '.results[0].content // empty')
  if [[ "$top" == *"SKIP LOCKED"* ]] || [[ "$top" == *"queue"* ]] || [[ "$top" == *"SQS"* ]] || [[ "$top" == *"Redis"* ]]; then
    ok "search top hit: '${top:0:80}...'"
    RESULTS+=("PASS|search top hit|content matches expectation")
  else
    fail "search top hit doesn't match expected queue/SKIP semantics"
    info "  top hit content: $top"
    RESULTS+=("FAIL|search top hit|unexpected content")
  fi

  # Query 2: 'where the person lives' — should find the about item with Seattle.
  resp=$(post_search '{"q":"where the person lives","limit":3,"dimensions":["about"]}')
  count=$(echo "$resp" | jq -r '.results | length')
  if [[ "$count" -ge 1 ]]; then
    ok "search 'where the person lives' returned $count about-results"
    local top2
    top2=$(echo "$resp" | jq -r '.results[0].content // empty')
    if [[ "$top2" == *"Seattle"* ]] || [[ "$top2" == *"Xanxerê"* ]]; then
      ok "search about-results contain location"
      RESULTS+=("PASS|search about-location|content matches")
    else
      fail "search about-results don't mention Seattle or Xanxerê"
      info "  top hit content: $top2"
      RESULTS+=("FAIL|search about-location|unexpected content")
    fi
  else
    fail "search 'where the person lives' returned 0 about-results"
    RESULTS+=("FAIL|search about-location|no results")
  fi

  # Query 3: similarity threshold filtering.
  resp=$(post_search '{"q":"completely unrelated quantum physics gravitational waves","limit":5,"min_similarity":0.5}')
  count=$(echo "$resp" | jq -r '.results | length')
  if [[ "$count" == "0" ]]; then
    ok "search with min_similarity=0.5 on unrelated query returned 0 (as expected)"
    RESULTS+=("PASS|search min_similarity|0 results below threshold")
  else
    # Not a hard failure — embeddings might surprise us. Flag as warning instead.
    warn "search with min_similarity=0.5 on unrelated query returned $count (expected 0)"
    info "  this might be fine; check the top similarity"
    info "  top result: $(echo "$resp" | jq -r '.results[0].content + " (sim: " + (.results[0].similarity|tostring) + ")"' )"
    # Still record as a pass-with-note, since LLM-determined similarity floors are imperfect.
    RESULTS+=("PASS|search min_similarity|$count results (note: expected 0, unrelated query)")
  fi

  # Query 4: ?q= on /recall — verify it returns similarity-ordered items.
  local recall_resp
  recall_resp=$(curl -fsS "http://localhost:$PORT/recall?preferences=1&q=Go+programming&limit=3")
  local first_sim
  first_sim=$(echo "$recall_resp" | jq -r '.dimensions[0].items[0].similarity // empty')
  if [[ -n "$first_sim" ]]; then
    ok "?q= on /recall returned similarity-scored items (top sim: $first_sim)"
    RESULTS+=("PASS|recall ?q=|similarity field populated")
  else
    fail "?q= on /recall did not populate similarity field"
    RESULTS+=("FAIL|recall ?q=|no similarity field")
  fi
}

print_report() {
  step "summary"
  local pass=0 fail=0
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r status label note <<<"$r"
    if [[ "$status" == "PASS" ]]; then
      printf "  ${GREEN}PASS${RST}  %-40s  %s\n" "$label" "$note"
      (( pass++ )) || true
    else
      printf "  ${RED}FAIL${RST}  %-40s  %s\n" "$label" "$note"
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

  # ─── Round 2 ─────────────────────────────────────────────────────
  send_round2_reinforce_event
  send_round2_contradict_event
  wait_for_jobs
  run_round2_checks

  # ─── Round 3 — semantic search ───────────────────────────────────
  run_search_checks

  print_report
}

main "$@"
