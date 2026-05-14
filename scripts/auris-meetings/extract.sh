#!/usr/bin/env bash
#
# Extracts 4 auris meetings (metadata + transcript) into a self-contained
# bundle for transfer to a local machine. Run this ON the VPS.
#
# Usage:
#   # auto-pick the 4 most recent completed meetings:
#   ./extract.sh
#
#   # or specify meeting IDs explicitly:
#   ./extract.sh <meeting_id_1> <meeting_id_2> <meeting_id_3> <meeting_id_4>
#
# Produces: /tmp/auris-meetings-bundle.tar.gz
# Transfer with: scp tiago@<vps>:/tmp/auris-meetings-bundle.tar.gz ./
#
# Assumptions (verified against jarvis production on 2026-05-14):
#   - postgres container is named `auris-postgres`
#   - server container is named `auris-server`
#   - DB user + db name are both `meeting_companion`
#     (the project was renamed from meeting_companion to auris but the
#      DB credentials weren't migrated)
#   - transcripts live at /data/blobs/meetings/<id>/transcription.jsonl
#     inside the auris-server container
#
# Override via env if the deploy ever changes:
#   PG_CONTAINER, PG_USER, PG_DB, SERVER_CONTAINER

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-auris-postgres}"
PG_USER="${PG_USER:-meeting_companion}"
PG_DB="${PG_DB:-meeting_companion}"
SERVER_CONTAINER="${SERVER_CONTAINER:-auris-server}"
OUTPUT="${OUTPUT:-/tmp/auris-meetings-bundle.tar.gz}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Sanity: containers must be running.
for c in "$PG_CONTAINER" "$SERVER_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "container '$c' not running. Override with PG_CONTAINER / SERVER_CONTAINER env vars." >&2
    exit 1
  fi
done

# Run a SQL query against the auris postgres container.
# -t -A: tuples-only, unaligned; -F'|': pipe-separated for multi-column
pg() {
  docker exec -i "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$PG_DB" -t -A -F'|' -c "$1"
}

# Run a shell command inside the auris server container.
server_exec() {
  docker exec -i "$SERVER_CONTAINER" "$@"
}

# Step 1: determine which meetings to extract.
if (($# > 0)); then
  MEETING_IDS=("$@")
else
  echo "Auto-picking 4 most recent completed meetings (ended_at IS NOT NULL)..."
  mapfile -t MEETING_IDS < <(
    pg "SELECT id FROM meetings WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 4;" \
    | awk -F'|' '{print $1}' \
    | grep -v '^$'
  )
fi

if [[ ${#MEETING_IDS[@]} -eq 0 ]]; then
  echo "No completed meetings found." >&2
  exit 1
fi

echo "Extracting ${#MEETING_IDS[@]} meetings: ${MEETING_IDS[*]}"

# Step 2: dump metadata + transcript for each meeting.
mkdir -p "$WORK/meetings"

for mid in "${MEETING_IDS[@]}"; do
  echo ""
  echo "  Processing $mid..."
  out_dir="$WORK/meetings/$mid"
  mkdir -p "$out_dir"

  # Full meeting metadata as JSON.
  pg "
    SELECT row_to_json(t) FROM (
      SELECT id, user_id, started_at, ended_at, description, metadata::text
      FROM meetings
      WHERE id = '$mid'
    ) t;
  " > "$out_dir/meeting.json"

  if [[ ! -s "$out_dir/meeting.json" ]]; then
    echo "    WARN: no meeting row found for id=$mid — skipping" >&2
    rm -rf "$out_dir"
    continue
  fi

  # Items (highlights / actions / questions / chat / summary).
  pg "
    SELECT COALESCE(json_agg(row_to_json(i) ORDER BY i.created_at), '[]'::json)
    FROM (
      SELECT id, mode, text, detail, t_ms, meta, created_at
      FROM items
      WHERE meeting_id = '$mid'
    ) i;
  " > "$out_dir/items.json"

  # Moments (manual marks + summaries).
  pg "
    SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.t), '[]'::json)
    FROM (
      SELECT id, kind, t, note, summary, summary_status, created_at
      FROM moments
      WHERE meeting_id = '$mid'
    ) m;
  " > "$out_dir/moments.json"

  # Transcript JSONL from the server container's filesystem.
  TRANSCRIPT_PATH="/data/blobs/meetings/$mid/transcription.jsonl"
  if server_exec test -f "$TRANSCRIPT_PATH"; then
    server_exec cat "$TRANSCRIPT_PATH" > "$out_dir/transcription.jsonl"
    line_count=$(wc -l < "$out_dir/transcription.jsonl" | tr -d ' ')
    echo "    transcript: $line_count lines"
  else
    echo "    WARN: no transcription.jsonl at $TRANSCRIPT_PATH" >&2
    touch "$out_dir/transcription.jsonl"
  fi
done

# Step 3: verify at least one meeting directory was written.
n_dirs=$(find "$WORK/meetings" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [[ "$n_dirs" -eq 0 ]]; then
  echo "No meeting directories written — aborting." >&2
  exit 1
fi

# Step 4: bundle everything.
echo ""
echo "Bundling $n_dirs meeting(s) to $OUTPUT..."
tar -czf "$OUTPUT" -C "$WORK" meetings
echo "Done."
ls -lh "$OUTPUT"
echo ""
echo "Transfer to local machine with:"
echo "  scp tiago@<vps>:$OUTPUT ./"
