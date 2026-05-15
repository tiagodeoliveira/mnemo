#!/usr/bin/env bash
#
# Replays auris meeting transcripts (extracted by extract.sh) through
# local v2 mnemo. Each meeting's transcript is posted in chunks of ~10
# items; the last chunk carries meeting_ended=true to trigger finalize_meeting.
#
# Transcript JSONL format (one line per item, from auris contract.rs):
#   {"id":"...","text":"...","t":<ms>,"meta":{"speaker":"Speaker N"}}
# The script reproduces the same formatting the live auris pusher uses:
# "[Speaker N] <text>" when meta.speaker is present, "<text>" otherwise.
#
# Usage:
#   ./replay.sh [path/to/auris-meetings-bundle.tar.gz]
#
# Env:
#   MNEMO_URL   — default http://localhost:8080
#   ACTOR_ID    — default dev-actor (matches local v2 auth-disabled mode)
#   CHUNK_SIZE  — transcript items per POST /events (default 10)
#   DRY_RUN=1   — print what would be sent, don't call the server

set -euo pipefail

MNEMO_URL="${MNEMO_URL:-http://localhost:8080}"
ACTOR_ID="${ACTOR_ID:-dev-actor}"
CHUNK_SIZE="${CHUNK_SIZE:-10}"
DRY_RUN="${DRY_RUN:-0}"

BUNDLE="${1:-/tmp/auris-meetings-bundle.tar.gz}"
if [[ ! -f "$BUNDLE" ]]; then
  echo "Bundle not found: $BUNDLE" >&2
  echo "Usage: $0 [path/to/auris-meetings-bundle.tar.gz]" >&2
  exit 1
fi

# Sanity check — server is up (skip in dry-run mode).
if [[ "$DRY_RUN" != "1" ]]; then
  if ! curl -fsS "$MNEMO_URL/healthz" >/dev/null 2>&1; then
    echo "mnemo server not responding at $MNEMO_URL" >&2
    echo "Start it first: go run ./server/cmd/mnemo-server" >&2
    exit 1
  fi
  echo "mnemo server is up at $MNEMO_URL"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$BUNDLE" -C "$WORK"

mapfile -t MEETING_DIRS < <(
  find "$WORK/meetings" -mindepth 1 -maxdepth 1 -type d | sort
)

if [[ ${#MEETING_DIRS[@]} -eq 0 ]]; then
  echo "No meeting directories in bundle." >&2
  exit 1
fi

# Format one transcript Item JSONL line the same way the auris pusher does:
#   "[Speaker N] <text>"  when meta.speaker is present and non-empty
#   "<text>"              otherwise
format_item() {
  local json_line="$1"
  local speaker text
  speaker=$(echo "$json_line" | jq -r '(.meta.speaker // "") | ltrimstr(" ") | rtrimstr(" ")')
  text=$(echo "$json_line" | jq -r '.text // ""')
  if [[ -n "$speaker" ]]; then
    echo "[Speaker ${speaker}] ${text}"
  else
    echo "$text"
  fi
}

# Build the turns JSON array from a list of formatted content strings.
# Each item becomes one user-role turn, matching the live pusher.
build_turns_json() {
  local -a contents=("$@")
  local arr='[]'
  for content in "${contents[@]}"; do
    arr=$(echo "$arr" | jq -c --arg c "$content" '. + [{role: "user", content: $c}]')
  done
  echo "$arr"
}

post_chunk() {
  local mid="$1" turns_json="$2" is_last="$3"
  local body
  body=$(jq -c -n \
    --arg sid "replay-${mid}-$(date +%s%N)" \
    --arg mid "$mid" \
    --argjson turns "$turns_json" \
    --argjson ended "$is_last" \
    '{
      session_id: $sid,
      source: "auris-replay",
      turns: $turns,
      attributes: {
        meeting_id: $mid,
        meeting_ended: $ended,
        mode: "transcript",
        source: "auris-replay"
      }
    }')

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    [DRY-RUN] POST /events  meeting_ended=$is_last  turns=$(echo "$turns_json" | jq 'length')"
    echo "    first turn: $(echo "$turns_json" | jq -r '.[0].content // "(empty)"' | head -c 120)"
    return
  fi

  local resp
  resp=$(curl -fsS -X POST "$MNEMO_URL/events" \
    -H "content-type: application/json" \
    -d "$body")
  local event_id
  event_id=$(echo "$resp" | jq -r '.event_id // empty')
  echo "    event_id: $event_id  meeting_ended=$is_last"
}

for mdir in "${MEETING_DIRS[@]}"; do
  mid=$(basename "$mdir")
  echo ""
  echo "=== Meeting: $mid ==="

  # Print sample line so operator can verify JSONL shape.
  if [[ -s "$mdir/transcription.jsonl" ]]; then
    echo "  sample JSONL line:"
    head -1 "$mdir/transcription.jsonl" | jq -c '.' | sed 's/^/    /'
  fi

  if [[ ! -s "$mdir/transcription.jsonl" ]]; then
    echo "  empty or missing transcript — skipping"
    continue
  fi

  total=$(wc -l < "$mdir/transcription.jsonl" | tr -d ' ')
  if [[ "$total" == "0" ]]; then
    echo "  empty transcript — skipping"
    continue
  fi
  echo "  $total transcript lines  chunk_size=$CHUNK_SIZE"

  chunk_count=0
  chunk_contents=()

  while IFS= read -r line; do
    # Skip blank lines (shouldn't occur in well-formed JSONL, but be safe).
    [[ -z "$line" ]] && continue

    content=$(format_item "$line")
    chunk_contents+=("$content")

    if (( ${#chunk_contents[@]} >= CHUNK_SIZE )); then
      turns_json=$(build_turns_json "${chunk_contents[@]}")
      post_chunk "$mid" "$turns_json" false
      chunk_count=$((chunk_count + 1))
      chunk_contents=()
    fi
  done < "$mdir/transcription.jsonl"

  # Final chunk — possibly partial — with meeting_ended=true.
  if (( ${#chunk_contents[@]} > 0 )); then
    turns_json=$(build_turns_json "${chunk_contents[@]}")
    post_chunk "$mid" "$turns_json" true
    chunk_count=$((chunk_count + 1))
  else
    # Exact multiple of CHUNK_SIZE: send a minimal marker-only chunk.
    post_chunk "$mid" '[{"role":"user","content":"[end of transcript]"}]' true
    chunk_count=$((chunk_count + 1))
  fi
  chunk_contents=()

  echo "  pushed $chunk_count chunk(s) for $mid"
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  echo "Dry-run complete. Rerun without DRY_RUN=1 to actually push."
  exit 0
fi

echo ""
echo "All meetings pushed. Waiting for jobs to drain (up to 10 min)..."

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "WARN: docker-compose.yml not found at $REPO_ROOT — cannot poll job queue."
  echo "Check mnemo server logs manually to confirm jobs have drained."
  exit 0
fi

deadline=$(( $(date +%s) + 600 ))
while (( $(date +%s) < deadline )); do
  pending=$(docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U mnemo -d mnemo -t -A \
    -c "SELECT count(*) FROM jobs WHERE state IN ('pending','running');" \
    | tr -d ' ')
  if [[ "$pending" == "0" ]]; then
    echo "$(date +%H:%M:%S) — all jobs drained."
    break
  fi
  echo "  $(date +%H:%M:%S) — $pending job(s) pending/running..."
  sleep 5
done

if (( $(date +%s) >= deadline )); then
  echo "WARN: jobs did not drain within 10 min. Check the server logs."
  exit 1
fi
