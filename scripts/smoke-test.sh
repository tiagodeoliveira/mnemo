#!/usr/bin/env bash
set -euo pipefail

# mnemo smoke test — multi-dimensional memory verification
# Pushes diverse conversation scenarios (coding, studying, meeting, general),
# waits for AgentCore processing, verifies recall across all dimensions,
# and cleans up memory records afterward.
#
# Usage:
#   ./scripts/smoke-test.sh              # full: push + wait + recall + cleanup
#   ./scripts/smoke-test.sh --push-only  # push only
#   ./scripts/smoke-test.sh --recall-only # recall only
#   ./scripts/smoke-test.sh --cleanup    # cleanup only
#   ./scripts/smoke-test.sh --no-cleanup # full without cleanup
#   ./scripts/smoke-test.sh --tail-logs  # tail Lambda + AgentCore logs

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

CONFIG_FILE="$HOME/.mnemo/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: $CONFIG_FILE not found. Run 'mnemo install' first."
  exit 1
fi

API_URL=$(jq -r '.apiUrl' "$CONFIG_FILE")
API_KEY=$(jq -r '.apiKey' "$CONFIG_FILE")
WORKSTATION=$(jq -r '.workstation // "test"' "$CONFIG_FILE")

TS=$(date +%s)
SESSION_CODING="smoke-coding-$TS"
SESSION_STUDYING="smoke-studying-$TS"
SESSION_MEETING="smoke-meeting-$TS"
SESSION_GENERAL="smoke-general-$TS"
PROJECT="mnemo"
WORKDIR="$PROJECT_DIR"
WAIT_SECONDS="${MNEMO_SMOKE_WAIT:-90}"
TODAY=$(date -u +%Y-%m-%d)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

push_event() {
  local event_num="$1"
  local label="$2"
  local turns="$3"
  local session_id="$4"
  local project_override="${5:-}"

  local payload
  payload=$(jq -n \
    --arg sid "$session_id" \
    --arg project "$project_override" \
    --arg ws "$WORKSTATION" \
    --arg wd "$WORKDIR" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg src "smoke-test" \
    --argjson turns "$turns" \
    '{
      sessionId: $sid,
      turns: $turns,
      context: {
        project: $project,
        workstation: $ws,
        workdir: $wd,
        timestamp: $ts,
        source: $src
      }
    }')

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API_URL/events" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -d "$payload")

  if [[ "$status" == "200" ]]; then
    echo -e "  ${GREEN}[$event_num] $label (HTTP $status)${NC}"
  else
    echo -e "  ${RED}[$event_num] $label FAILED (HTTP $status)${NC}"
    return 1
  fi
}

do_recall() {
  local label="$1"
  local task="${2:-coding}"
  echo -e "\n${CYAN}--- Recall: $label (task=$task, date=$TODAY) ---${NC}"

  local project_param=""
  if [[ "$task" == "coding" ]]; then
    project_param="&project=$PROJECT"
  fi

  local response
  response=$(curl -s \
    -H "x-api-key: $API_KEY" \
    "$API_URL/recall?workstation=$WORKSTATION&preferences=true&facts=true&episodes=true&task=$task&date=$TODAY$project_param")

  local pref_count fact_count ep_count proj_count task_count daily_count
  pref_count=$(echo "$response" | jq '.preferences | length')
  fact_count=$(echo "$response" | jq '.facts | length')
  ep_count=$(echo "$response" | jq '.episodes | length')
  proj_count=$(echo "$response" | jq '.project.memories // [] | length')
  task_count=$(echo "$response" | jq '.tasks.memories // [] | length')
  daily_count=$(echo "$response" | jq '.daily.memories // [] | length')

  echo -e "  Preferences: ${GREEN}$pref_count${NC}"
  echo -e "  Facts:       ${GREEN}$fact_count${NC}"
  echo -e "  Episodes:    ${GREEN}$ep_count${NC}"
  echo -e "  Project:     ${GREEN}$proj_count${NC}"
  echo -e "  Tasks:       ${GREEN}$task_count${NC}"
  echo -e "  Daily:       ${GREEN}$daily_count${NC}"

  if [[ "$pref_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample preferences:${NC}"
    echo "$response" | jq -r '.preferences[:3][] | .content' | while read -r line; do
      local text
      text=$(echo "$line" | jq -r '.preference // empty' 2>/dev/null || echo "$line")
      [[ -z "$text" ]] && text="$line"
      echo "    - $text"
    done
  fi

  if [[ "$fact_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample facts:${NC}"
    echo "$response" | jq -r '.facts[:3][] | .content' | while read -r line; do
      echo "    - $line"
    done
  fi

  if [[ "$task_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample task memories ($task):${NC}"
    echo "$response" | jq -r '.tasks.memories[:3][] | .content' | while read -r line; do
      echo "    - $line"
    done
  fi

  if [[ "$daily_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample daily memories ($TODAY):${NC}"
    echo "$response" | jq -r '.daily.memories[:3][] | .content' | while read -r line; do
      echo "    - $line"
    done
  fi

  if [[ "$proj_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample project memories:${NC}"
    echo "$response" | jq -r '.project.memories[:3][] | .content' | while read -r line; do
      echo "    - $line"
    done
  fi
}

tail_logs() {
  echo -e "${CYAN}Tailing Lambda + AgentCore memory logs (Ctrl+C to stop)...${NC}\n"

  INGEST_LOG=$(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/MnemoStack-LambdasIngestFn" \
    --query 'logGroups[0].logGroupName' --output text 2>/dev/null)

  RECALL_LOG=$(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/MnemoStack-LambdasRecallFn" \
    --query 'logGroups[0].logGroupName' --output text 2>/dev/null)

  EXTRACTOR_LOG=$(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/MnemoStack-LambdasContextExtractorFn" \
    --query 'logGroups[0].logGroupName' --output text 2>/dev/null)

  MEMORY_LOG="/aws/vendedlogs/bedrock-agentcore/memory/mnemo_memory/APPLICATION_LOGS"

  LOG_GROUPS=()
  for lg in "$INGEST_LOG" "$RECALL_LOG" "$EXTRACTOR_LOG" "$MEMORY_LOG"; do
    if [[ "$lg" != "None" && -n "$lg" ]]; then
      LOG_GROUPS+=("$lg")
    fi
  done

  if [[ ${#LOG_GROUPS[@]} -eq 0 ]]; then
    echo -e "${RED}No log groups found. Deploy the stack first.${NC}"
    exit 1
  fi

  echo "Watching log groups:"
  for lg in "${LOG_GROUPS[@]}"; do
    echo "  - $lg"
  done
  echo

  aws logs tail "${LOG_GROUPS[0]}" --follow --since 1m --format short 2>/dev/null &
  local pids=($!)
  for lg in "${LOG_GROUPS[@]:1}"; do
    aws logs tail "$lg" --follow --since 1m --format short 2>/dev/null &
    pids+=($!)
  done

  trap 'kill "${pids[@]}" 2>/dev/null; exit 0' INT TERM
  wait
}

do_push() {
  echo -e "${CYAN}=== mnemo smoke test — multi-dimensional memory ===${NC}"
  echo -e "Sessions: coding=${YELLOW}$SESSION_CODING${NC}"
  echo -e "          studying=${YELLOW}$SESSION_STUDYING${NC}"
  echo -e "          meeting=${YELLOW}$SESSION_MEETING${NC}"
  echo -e "          general=${YELLOW}$SESSION_GENERAL${NC}"
  echo -e "Date:     ${YELLOW}$TODAY${NC}"
  echo

  # ─────────────────────────────────────────────
  # CODING SCENARIO (project=mnemo, task=coding)
  # ─────────────────────────────────────────────
  echo -e "${CYAN}── Coding scenario (project=mnemo) ──${NC}"

  push_event 1 "Architecture discussion" '[
    {"role":"user","content":"I want to build a centralized memory system for Claude Code using Bedrock AgentCore Memory. It should work across multiple workstations."},
    {"role":"assistant","content":"I suggest a REST API architecture: API Gateway with POST /events for ingesting and GET /recall for retrieving. AgentCore Memory automatically extracts user preferences, semantic facts, and episodic memories. For project-specific context, we use a self-managed custom strategy triggered via SNS."},
    {"role":"user","content":"What about infrastructure? I want this fully automated with CDK."},
    {"role":"assistant","content":"CDK is the right choice. We will use CfnMemory for the AgentCore Memory lifecycle. The stack has three constructs: MemoryConstruct, LambdaConstruct, and ApiConstruct."}
  ]' "$SESSION_CODING" "$PROJECT"
  sleep 1

  push_event 2 "TypeScript preferences" '[
    {"role":"user","content":"For the Lambda functions, I want strict TypeScript. Use NodejsFunction with esbuild bundling."},
    {"role":"assistant","content":"All Lambdas will use NodejsFunction with NODEJS_22_X runtime and esbuild bundling."},
    {"role":"user","content":"For testing, I prefer vitest with aws-sdk-client-mock."},
    {"role":"assistant","content":"I will set up vitest for both infra and cli workspaces. CDK tests use Template.fromStack assertions."}
  ]' "$SESSION_CODING" "$PROJECT"
  sleep 1

  push_event 3 "IAM debugging" '[
    {"role":"user","content":"The deploy is failing. AgentCore says the execution role does not have SNS access."},
    {"role":"assistant","content":"The execution role needs both identity-based AND resource-based policies for SNS. The correct service principal is bedrock-agentcore.amazonaws.com, not bedrock.amazonaws.com."},
    {"role":"user","content":"Memory names cannot have hyphens either."},
    {"role":"assistant","content":"Correct. AgentCore Memory names must match [a-zA-Z][a-zA-Z0-9_]{0,47}. Use mnemo_memory instead of mnemo-memory."}
  ]' "$SESSION_CODING" "$PROJECT"
  sleep 2

  # ─────────────────────────────────────────────
  # STUDYING SCENARIO (no project, task=studying)
  # ─────────────────────────────────────────────
  echo -e "\n${CYAN}── Studying scenario ──${NC}"

  push_event 4 "Distributed systems" '[
    {"role":"user","content":"Explain the Raft consensus algorithm and how it differs from Paxos."},
    {"role":"assistant","content":"Raft is designed for understandability. It separates leader election, log replication, and safety. Unlike Paxos which allows any node to be a proposer, Raft uses a strong leader model. Leaders handle all client requests and replicate to followers. This simplifies reasoning about the protocol."},
    {"role":"user","content":"What about the split-brain problem?"},
    {"role":"assistant","content":"Raft prevents split-brain through its term system. Each leader has a unique term number. If a network partition occurs, only the partition with a majority can elect a leader and make progress. The minority partition cannot get enough votes and stalls until the partition heals."}
  ]' "$SESSION_STUDYING" ""
  sleep 1

  push_event 5 "Database internals" '[
    {"role":"user","content":"How do LSM trees work in databases like RocksDB?"},
    {"role":"assistant","content":"LSM trees buffer writes in memory (memtable), flush to sorted files (SSTables) on disk, and periodically compact them. Writes are always sequential, making them fast. Reads may check multiple levels. RocksDB adds bloom filters and block caches to optimize read performance."},
    {"role":"user","content":"When would you choose LSM over B-tree?"},
    {"role":"assistant","content":"LSM trees excel at write-heavy workloads with good sequential I/O. B-trees are better for read-heavy workloads and point lookups. LSM trees have write amplification during compaction but lower write latency. B-trees have more predictable read latency but higher write latency due to random I/O."}
  ]' "$SESSION_STUDYING" ""
  sleep 2

  # ─────────────────────────────────────────────
  # MEETING SCENARIO (no project, task=meeting)
  # ─────────────────────────────────────────────
  echo -e "\n${CYAN}── Meeting scenario ──${NC}"

  push_event 6 "Architecture review meeting" '[
    {"role":"user","content":"Summarize todays architecture review meeting. Attendees: Alice, Bob, and me. We discussed migrating from monolith to microservices."},
    {"role":"assistant","content":"Architecture Review Summary: The team agreed on a strangler fig pattern for the migration. Alice proposed starting with the authentication service since it has the clearest boundaries. Bob raised concerns about distributed transactions in the order processing flow. Decision: authentication service migrates first (target Q3), order processing stays in the monolith until a saga pattern proof-of-concept is completed."},
    {"role":"user","content":"What were the action items?"},
    {"role":"assistant","content":"Action items from the meeting: 1) Alice: draft authentication service API contract by Friday. 2) Bob: prototype saga pattern for order processing, 2-week spike. 3) You: set up the new service mesh infrastructure using Istio. 4) All: review Alice API contract in next weeks meeting."}
  ]' "$SESSION_MEETING" ""
  sleep 1

  push_event 7 "Sprint retrospective" '[
    {"role":"user","content":"Capture the key points from our sprint retrospective. The team felt velocity was good but code review turnaround was slow."},
    {"role":"assistant","content":"Sprint Retrospective: Velocity was 42 points (up from 38). Main bottleneck: code reviews averaging 2 days. Proposal: dedicate first hour each morning to reviews. Team agreed on a 24-hour SLA for initial review feedback. Also discussed adding automated linting to reduce back-and-forth on style issues."}
  ]' "$SESSION_MEETING" ""
  sleep 2

  # ─────────────────────────────────────────────
  # GENERAL SCENARIO (no project, task=general)
  # ─────────────────────────────────────────────
  echo -e "\n${CYAN}── General scenario ──${NC}"

  push_event 8 "Travel planning" '[
    {"role":"user","content":"I am planning a trip to Japan in November. What should I know?"},
    {"role":"assistant","content":"November is excellent for Japan — its autumn foliage season (koyo). Kyoto and Nikko are especially stunning. Weather is mild (10-18C). Key tips: get a Japan Rail Pass for bullet trains, book ryokans early for the foliage season, and visit temples early morning to avoid crowds. The Fushimi Inari shrine is best at dawn."},
    {"role":"user","content":"How about the food scene?"},
    {"role":"assistant","content":"Japan in autumn features seasonal specialties: matsutake mushrooms, sanma (pacific saury), and sweet potatoes. Every region has unique dishes — Osaka for takoyaki and okonomiyaki, Tokyo for sushi and ramen. Budget around 3000-5000 yen per meal at mid-range restaurants. Department store basement food halls (depachika) are incredible for sampling."}
  ]' "$SESSION_GENERAL" ""
  sleep 1

  push_event 9 "Book recommendation" '[
    {"role":"user","content":"Recommend a book on systems thinking for someone with an engineering background."},
    {"role":"assistant","content":"Thinking in Systems by Donella Meadows is the classic introduction. For an engineering perspective, try The Art of Systems Thinking by Joseph O Connor. If you want something more applied to software, Thinking in Systems for Software Engineers covers feedback loops, emergence, and resilience in distributed systems."}
  ]' "$SESSION_GENERAL" ""

  echo -e "\n${GREEN}All 9 events pushed across 4 task domains${NC}"
}

do_wait() {
  echo -e "\n${YELLOW}Waiting ${WAIT_SECONDS}s for AgentCore to process events...${NC}"
  for ((i=WAIT_SECONDS; i>0; i--)); do
    printf "\r  %3ds remaining" "$i"
    sleep 1
  done
  printf "\r  Done!           \n"
}

do_cleanup() {
  echo -e "\n${CYAN}--- Cleaning up memory records ---${NC}"
  cd "$PROJECT_DIR/infra" && npx tsx "$SCRIPT_DIR/cleanup-memory.ts" 2>&1
}

# --- Main ---

MODE="${1:-full}"

case "$MODE" in
  --push-only)
    do_push
    ;;
  --recall-only)
    do_recall "coding dimension" "coding"
    do_recall "studying dimension" "studying"
    do_recall "meeting dimension" "meeting"
    do_recall "general dimension" "general"
    ;;
  --cleanup)
    do_cleanup
    ;;
  --tail-logs)
    tail_logs
    ;;
  --no-cleanup)
    do_push
    do_recall "baseline (before processing)" "coding"
    do_wait
    echo -e "\n${CYAN}=== Recall across all dimensions ===${NC}"
    do_recall "coding" "coding"
    do_recall "studying" "studying"
    do_recall "meeting" "meeting"
    do_recall "general" "general"
    echo -e "\n${CYAN}=== Test complete (no cleanup) ===${NC}"
    echo -e "Sessions: coding=${YELLOW}$SESSION_CODING${NC} studying=${YELLOW}$SESSION_STUDYING${NC}"
    echo -e "          meeting=${YELLOW}$SESSION_MEETING${NC} general=${YELLOW}$SESSION_GENERAL${NC}"
    echo -e "To recall:   ${YELLOW}mnemo recall --project $PROJECT --task coding${NC}"
    echo -e "To cleanup:  ${YELLOW}$0 --cleanup${NC}"
    ;;
  *)
    do_push
    do_recall "baseline (before processing)" "coding"
    do_wait
    echo -e "\n${CYAN}=== Recall across all dimensions ===${NC}"
    do_recall "coding" "coding"
    do_recall "studying" "studying"
    do_recall "meeting" "meeting"
    do_recall "general" "general"
    do_cleanup
    echo -e "\n${CYAN}=== Test complete ===${NC}"
    ;;
esac
