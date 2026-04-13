#!/usr/bin/env bash
set -euo pipefail

# mnemo push hook (UserPromptSubmit)
# Reads hook input from stdin, batches conversation turns, pushes to memory.
# Uses a counter file to batch every N prompts.
#
# Transcript format (JSONL):
#   type:"user"      → message.content is a string
#   type:"assistant"  → message.content is an array of blocks [{type:"text",text:"..."},...]

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

# Extract recent turns from JSONL transcript.
# Take the last 200 lines, filter to user/assistant entries, extract text content.
# User messages: only include when .message.content is a string (actual human prompt),
#   skip tool_result arrays which are just tool outputs fed back.
# Assistant messages: extract only text blocks, skip tool_use-only messages.
TURNS=$(tail -200 "$TRANSCRIPT_PATH" 2>/dev/null | jq -c '
  select(.type == "user" or .type == "assistant") |
  if .type == "user" then
    if (.message.content | type) == "string" then
      { role: "user", content: .message.content }
    else empty
    end
  elif .type == "assistant" then
    { role: "assistant", content: (
      [.message.content[]? | select(.type == "text") | .text] | join("\n")
    ) }
  else empty
  end
' 2>/dev/null | jq -s 'map(select(.content != ""))' 2>/dev/null || echo "[]")

if [ "$TURNS" = "[]" ] || [ -z "$TURNS" ]; then
  exit 0
fi

# Push in background
PUSH_ARGS=(
  --session "$SESSION_ID"
  --turns "$TURNS"
  --workdir "${CWD:-.}"
  --source claude-code
)
if [ -n "$PROJECT" ]; then
  PUSH_ARGS+=(--project "$PROJECT")
fi

mnemo push "${PUSH_ARGS[@]}" >/dev/null 2>&1 &

exit 0
