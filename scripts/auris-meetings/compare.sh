#!/usr/bin/env bash
#
# Compares meeting category summaries produced by local v2 mnemo against
# those stored in the AWS v1 mnemo stack. Emits a side-by-side markdown report.
#
# Usage:
#   ./compare.sh [path/to/auris-meetings-bundle.tar.gz]
#
# Required env:
#   AWS_MNEMO_URL   — e.g. https://abc.execute-api.us-east-1.amazonaws.com/v1
#   AWS_MNEMO_KEY   — the v1 static API key
#
# Optional env:
#   MNEMO_URL       — local v2 base URL (default http://localhost:8080)
#   ACTOR_ID        — local v2 actor ID (default dev-actor)
#   OUTPUT_FILE     — where to write the markdown report (default ./meeting-comparison.md)

set -euo pipefail

if [[ -z "${AWS_MNEMO_URL:-}" || -z "${AWS_MNEMO_KEY:-}" ]]; then
  echo "AWS_MNEMO_URL and AWS_MNEMO_KEY env vars are required." >&2
  echo "  export AWS_MNEMO_URL=https://..." >&2
  echo "  export AWS_MNEMO_KEY=..." >&2
  exit 1
fi

MNEMO_URL="${MNEMO_URL:-http://localhost:8080}"
ACTOR_ID="${ACTOR_ID:-dev-actor}"
OUTPUT_FILE="${OUTPUT_FILE:-meeting-comparison.md}"
CATEGORIES=(summary decisions actions questions highlights followups)

BUNDLE="${1:-/tmp/auris-meetings-bundle.tar.gz}"
if [[ ! -f "$BUNDLE" ]]; then
  echo "Bundle not found: $BUNDLE" >&2
  echo "Usage: $0 [path/to/auris-meetings-bundle.tar.gz]" >&2
  exit 1
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

# ─── Fetch helpers ────────────────────────────────────────────────────────────

# v2 local: GET /recall?meeting=<id>
# Returns: {"dimensions":[{"dimension":"meeting","namespace":"/meetings/<actor>/<mid>/","items":[{...}]}]}
# Each item's namespace ends in "/<category>/".
fetch_v2() {
  local mid="$1"
  curl -fsS --max-time 30 "$MNEMO_URL/recall?meeting=${mid}" || echo '{}'
}

# v1 AWS: GET /recall?meeting=<id>  (with API key header)
# The v1 shape varies across deploys; we try two common ones (see extract functions below).
fetch_aws() {
  local mid="$1"
  curl -fsS --max-time 30 \
    -H "x-api-key: $AWS_MNEMO_KEY" \
    "${AWS_MNEMO_URL}/recall?meeting=${mid}" || echo '{}'
}

# ─── Normalization helpers ─────────────────────────────────────────────────────

# Extract a category's text from a v2 response.
# v2 item namespace format: /meetings/<actor>/<mid>/<category>/
v2_category() {
  local json="$1" cat="$2"
  echo "$json" | jq -r --arg cat "$cat" '
    ( .dimensions // [] )
    | map(select(.dimension == "meeting"))
    | first
    | .items // []
    | map(select(.namespace // "" | endswith("/" + $cat + "/")))
    | .[0].content // ""
  ' 2>/dev/null || echo ""
}

# Extract a category's text from a v1 AWS response.
# Tries two common v1 shapes:
#   Shape A (late v1):  {dimensions:[{dimension:"meeting",items:[{namespace:"../<cat>/",content:"..."}]}]}
#   Shape B (early v1): {meetings:{"<mid>":{"summary":"...","decisions":"..."}}}
# Returns empty string if neither matches.
aws_category() {
  local json="$1" cat="$2" mid="$3"

  # Shape A: same namespace convention as v2.
  local result
  result=$(echo "$json" | jq -r --arg cat "$cat" '
    ( .dimensions // [] )
    | map(select(.dimension == "meeting"))
    | first
    | .items // []
    | map(select(.namespace // "" | endswith("/" + $cat + "/")))
    | .[0].content // ""
  ' 2>/dev/null || echo "")
  if [[ -n "$result" ]]; then
    echo "$result"
    return
  fi

  # Shape B: flat map keyed by meeting id then category.
  result=$(echo "$json" | jq -r --arg cat "$cat" --arg mid "$mid" '
    ( .meetings // {} )
    | ( .[$mid] // ( to_entries | .[0].value // {} ) )
    | .[$cat] // ""
  ' 2>/dev/null || echo "")
  if [[ -n "$result" ]]; then
    echo "$result"
    return
  fi

  # Shape C: top-level category keys directly (some early deploys).
  echo "$json" | jq -r --arg cat "$cat" '.[$cat] // ""' 2>/dev/null || echo ""
}

# ─── Report generation ────────────────────────────────────────────────────────

{
  echo "# Meeting summary comparison: v2 (local) vs v1 AWS"
  echo ""
  echo "Generated: $(date -u +%FT%TZ)"
  echo "- v2 local: $MNEMO_URL  actor: $ACTOR_ID"
  echo "- v1 AWS:   $AWS_MNEMO_URL"
  echo ""
} > "$OUTPUT_FILE"

for mdir in "${MEETING_DIRS[@]}"; do
  mid=$(basename "$mdir")
  echo "Fetching recall for $mid..."

  v2_resp=$(fetch_v2 "$mid")
  aws_resp=$(fetch_aws "$mid")

  desc=$(jq -r '.description // "(no description)"' "$mdir/meeting.json" 2>/dev/null || echo "(unknown)")
  started=$(jq -r '.started_at // "(unknown)"' "$mdir/meeting.json" 2>/dev/null || echo "(unknown)")

  {
    echo "## $mid"
    echo ""
    echo "- Started:     $started"
    echo "- Description: $desc"
    echo ""
    echo "| | v2 local | v1 AWS |"
    echo "|---|---|---|"
    echo ""
  } >> "$OUTPUT_FILE"

  for cat in "${CATEGORIES[@]}"; do
    v2_text=$(v2_category "$v2_resp" "$cat")
    aws_text=$(aws_category "$aws_resp" "$cat" "$mid")

    {
      echo "### $cat"
      echo ""
      echo "**v2 (local)**"
      echo ""
      if [[ -n "$v2_text" ]]; then
        echo "$v2_text" | sed 's/^/> /'
      else
        echo "_empty / not produced_"
      fi
      echo ""
      echo "**v1 AWS**"
      echo ""
      if [[ -n "$aws_text" ]]; then
        echo "$aws_text" | sed 's/^/> /'
      else
        echo "_empty / not produced_"
      fi
      echo ""
      echo "---"
      echo ""
    } >> "$OUTPUT_FILE"
  done
done

echo ""
echo "Report written to: $OUTPUT_FILE"
wc -l "$OUTPUT_FILE" | awk '{print "  " $1 " lines"}'
