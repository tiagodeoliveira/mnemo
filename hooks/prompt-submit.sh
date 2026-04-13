#!/usr/bin/env bash
set -euo pipefail
command -v mnemo >/dev/null 2>&1 || exit 0

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
BATCH_SIZE="${MNEMO_BATCH_SIZE:-3}"
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

# Extract recent entries from JSONL transcript (last 200 lines).
RECENT=$(tail -200 "$TRANSCRIPT_PATH" 2>/dev/null)

# 1. Conversation turns: user text prompts + assistant text responses.
#    User messages: only include when .message.content is a string (actual human prompt),
#      skip tool_result arrays which are just tool outputs fed back.
#    Assistant messages: extract only text blocks, skip tool_use-only messages.
TURNS=$(echo "$RECENT" | jq -c '
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

# 2. Session activity summary: extract tool_use blocks from assistant messages
#    to capture which files were read/edited/written and what commands ran.
#    This gives the context extractor structural signal about the actual work done.
#    File paths are made relative to the working directory for readability.
ACTIVITY=$(echo "$RECENT" | jq -r --arg cwd "${CWD%/}/" '
  select(.type == "assistant") |
  [.message.content[]? | select(.type == "tool_use") |
    if .name == "Read" then "read:" + (.input.file_path | ltrimstr($cwd))
    elif .name == "Edit" then "edit:" + (.input.file_path | ltrimstr($cwd))
    elif .name == "Write" then "write:" + (.input.file_path | ltrimstr($cwd))
    elif .name == "Bash" then "bash:" + (.input.description // (.input.command | .[0:60]))
    elif .name == "Grep" then "grep:" + .input.pattern
    elif .name == "Glob" then "glob:" + .input.pattern
    else empty
    end
  ] | .[]
' 2>/dev/null | sort -u | jq -Rsc '
  split("\n") | map(select(. != "")) |
  group_by(split(":")[0]) |
  map(
    (.[0] | split(":")[0]) as $op |
    ($op + "=" + (map(split(":")[1:] | join(":")) | join(", ")))
  ) | join(" | ")
' 2>/dev/null || echo '""')

# Prepend activity summary as a tool turn so the extractor sees what happened
if [ "$ACTIVITY" != '""' ] && [ -n "$ACTIVITY" ]; then
  ACTIVITY_TEXT=$(echo "$ACTIVITY" | jq -r '.')
  if [ -n "$ACTIVITY_TEXT" ]; then
    TURNS=$(echo "$TURNS" | jq --arg activity "[session-activity: $ACTIVITY_TEXT]" \
      '[{role: "tool", content: $activity}] + .' 2>/dev/null || echo "$TURNS")
  fi
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
