#!/usr/bin/env bash
set -euo pipefail

# mnemo push hook
# Reads hook input from stdin, batches conversation turns, pushes to memory
# Uses a counter file to batch every N prompts

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# Batch every N user prompts
BATCH_SIZE="${MNEMO_BATCH_SIZE:-5}"
COUNTER_DIR="/tmp/mnemo"
COUNTER_FILE="$COUNTER_DIR/$SESSION_ID.count"

mkdir -p "$COUNTER_DIR"

# Increment counter
COUNT=0
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Only push every BATCH_SIZE prompts
if [ $((COUNT % BATCH_SIZE)) -ne 0 ]; then
  exit 0
fi

# Detect project
PROJECT=""
if [ -n "$CWD" ] && git -C "$CWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  PROJECT=$(basename "$(git -C "$CWD" rev-parse --show-toplevel)")
fi

# Extract recent turns from transcript (last 100 lines, simplified)
TURNS=$(tail -100 "$TRANSCRIPT_PATH" 2>/dev/null | jq -Rs '
  split("\n") |
  map(select(length > 0)) |
  map(
    if startswith("User:") or startswith("Human:") then
      { role: "user", content: (ltrimstr("User: ") | ltrimstr("Human: ")) }
    elif startswith("Assistant:") or startswith("Claude:") then
      { role: "assistant", content: (ltrimstr("Assistant: ") | ltrimstr("Claude: ")) }
    else
      empty
    end
  )
' 2>/dev/null || echo "[]")

if [ "$TURNS" = "[]" ] || [ -z "$TURNS" ]; then
  exit 0
fi

# Push in background
PROJECT_ARG=""
if [ -n "$PROJECT" ]; then
  PROJECT_ARG="--project $PROJECT"
fi

mnemo push \
  --session "$SESSION_ID" \
  --turns "$TURNS" \
  --workdir "${CWD:-.}" \
  $PROJECT_ARG \
  >/dev/null 2>&1 &

exit 0
