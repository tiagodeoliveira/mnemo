#!/usr/bin/env bash
set -euo pipefail

# mnemo smoke test — simulates a realistic multi-turn coding session
# Usage:
#   ./scripts/smoke-test.sh              # push + wait + recall
#   ./scripts/smoke-test.sh --push-only  # push only, skip wait/recall
#   ./scripts/smoke-test.sh --recall-only # recall only, skip push
#
# Tail logs in a separate terminal while running:
#   ./scripts/smoke-test.sh --tail-logs

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

SESSION_ID="smoke-test-$(date +%s)"
PROJECT="mnemo"
WORKDIR="$PROJECT_DIR"
WAIT_SECONDS="${MNEMO_SMOKE_WAIT:-90}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

push_event() {
  local event_num="$1"
  local turns="$2"

  local payload
  payload=$(jq -n \
    --arg sid "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg ws "$WORKSTATION" \
    --arg wd "$WORKDIR" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson turns "$turns" \
    '{
      sessionId: $sid,
      turns: $turns,
      context: {
        project: $project,
        workstation: $ws,
        workdir: $wd,
        timestamp: $ts
      }
    }')

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API_URL/events" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -d "$payload")

  if [[ "$status" == "200" ]]; then
    echo -e "  ${GREEN}[$event_num] pushed (HTTP $status)${NC}"
  else
    echo -e "  ${RED}[$event_num] FAILED (HTTP $status)${NC}"
    return 1
  fi
}

do_recall() {
  local label="$1"
  echo -e "\n${CYAN}--- Recall: $label ---${NC}"
  local response
  response=$(curl -s \
    -H "x-api-key: $API_KEY" \
    "$API_URL/recall?project=$PROJECT&workstation=$WORKSTATION")

  local pref_count fact_count ep_count proj_count
  pref_count=$(echo "$response" | jq '.preferences | length')
  fact_count=$(echo "$response" | jq '.facts | length')
  ep_count=$(echo "$response" | jq '.episodes | length')
  proj_count=$(echo "$response" | jq '.project.memories // [] | length')

  echo -e "  Preferences: ${GREEN}$pref_count${NC}"
  echo -e "  Facts:       ${GREEN}$fact_count${NC}"
  echo -e "  Episodes:    ${GREEN}$ep_count${NC}"
  echo -e "  Project:     ${GREEN}$proj_count${NC}"

  if [[ "$pref_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample preferences:${NC}"
    echo "$response" | jq -r '.preferences[:3][] | .content' | while read -r line; do
      # Try to extract plain text from JSON content
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

  if [[ "$ep_count" -gt 0 ]]; then
    echo -e "\n  ${YELLOW}Sample episodes:${NC}"
    echo "$response" | jq -r '.episodes[:3][] | .content' | head -c 500
    echo
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
    --log-group-name-prefix "/aws/lambda/MnemoStack-LambdasProjectExtractorFn" \
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

  # Interleave all log groups into one stream
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
  echo -e "${CYAN}=== mnemo smoke test ===${NC}"
  echo -e "Session: ${YELLOW}$SESSION_ID${NC}"
  echo -e "Project: ${YELLOW}$PROJECT${NC}"
  echo

  # --- Event 1: Project kickoff, architecture discussion ---
  echo -e "${CYAN}[Event 1] Project kickoff — architecture discussion${NC}"
  push_event 1 '[
    {"role":"user","content":"I want to build a centralized memory system for Claude Code. It should capture interactions, store them in Bedrock AgentCore Memory, and recall them in new sessions. The system needs to work across multiple workstations."},
    {"role":"assistant","content":"Great idea. I suggest a REST API architecture: an API Gateway with two endpoints — POST /events for ingesting conversation turns, and GET /recall for retrieving memories. Behind the API, Lambda functions handle the logic. AgentCore Memory does the heavy lifting: it automatically extracts user preferences, semantic facts, and episodic memories from conversation events. For project-specific context, we can use a self-managed custom strategy triggered via SNS."},
    {"role":"user","content":"What about the infrastructure? I want this fully automated with CDK."},
    {"role":"assistant","content":"CDK is the right choice. We will use the native CfnMemory CloudFormation resource for the AgentCore Memory lifecycle — we tried a custom resource Lambda approach first but ran into IAM propagation timing issues. The stack will have three constructs: MemoryConstruct for AgentCore + SNS + S3, LambdaConstruct for the three functions, and ApiConstruct for the REST API with API key authentication."}
  ]'
  sleep 2

  # --- Event 2: Implementation details, coding preferences ---
  echo -e "${CYAN}[Event 2] Implementation details — coding preferences${NC}"
  push_event 2 '[
    {"role":"user","content":"For the Lambda functions, I want strict TypeScript with no-any rules. Use NodejsFunction with esbuild bundling, and mark the AgentCore SDK as external since it is pre-installed in the Node 22 runtime."},
    {"role":"assistant","content":"Understood. All Lambdas will use NodejsFunction with runtime NODEJS_22_X, handler set to handler, and bundling.externalModules including @aws-sdk/client-bedrock-agentcore. The esbuild bundler will handle TypeScript compilation. I will also configure strict TypeScript in tsconfig.json."},
    {"role":"user","content":"For testing, I prefer vitest with aws-sdk-client-mock for mocking AWS SDK calls. No integration tests hitting real AWS services in the unit test suite."},
    {"role":"assistant","content":"Good plan. I will set up vitest as the test runner for both the infra and cli workspaces. AWS SDK calls will be mocked using aws-sdk-client-mock. The CDK tests will use Template.fromStack assertions to verify synthesized CloudFormation templates."}
  ]'
  sleep 2

  # --- Event 3: Debugging session — IAM and SNS issues ---
  echo -e "${CYAN}[Event 3] Debugging session — IAM and SNS permission issues${NC}"
  push_event 3 '[
    {"role":"user","content":"The deploy is failing. AgentCore says the execution role does not have access to required SNS topics."},
    {"role":"assistant","content":"This is a common issue with AgentCore Memory. The execution role needs both identity-based AND resource-based policies for SNS access. Let me add an inline policy on the role with sns:Publish and sns:GetTopicAttributes, plus a resource-based policy on the SNS topic that explicitly allows the execution role ARN."},
    {"role":"user","content":"The trust policy was wrong too — it was using bedrock.amazonaws.com but that got rejected."},
    {"role":"assistant","content":"Right, the correct service principal for AgentCore is bedrock-agentcore.amazonaws.com, not bedrock.amazonaws.com. This is specific to AgentCore resources like Memory. Let me update the execution role trust policy."},
    {"role":"user","content":"Also, memory names cannot have hyphens. I got a pattern validation error."},
    {"role":"assistant","content":"AgentCore Memory names must match the pattern [a-zA-Z][a-zA-Z0-9_]{0,47}. Underscores are allowed but hyphens are not. I will change mnemo-memory to mnemo_memory."}
  ]'
  sleep 2

  # --- Event 4: CLI development and namespace design ---
  echo -e "${CYAN}[Event 4] CLI development — namespace design and recall${NC}"
  push_event 4 '[
    {"role":"user","content":"The recall Lambda should query namespaces in parallel. Three by default: preferences, facts, episodes. If a project parameter is present, add a fourth query for the project-specific namespace."},
    {"role":"assistant","content":"I will use Promise.all to run the namespace queries in parallel. Each query calls RetrieveMemoryRecords with a different namespace prefix and search query. The response object groups results by category. If any single query fails, it returns an empty array for that category instead of failing the entire recall."},
    {"role":"user","content":"For the CLI, I want three commands: push, recall, and install. The install command should create the config file and set up Claude Code hooks automatically."},
    {"role":"assistant","content":"The CLI will use commander for argument parsing. The push command sends turns to POST /events, recall calls GET /recall and formats the output as markdown, and install creates ~/.mnemo/config.json with placeholder values and merges hook entries into ~/.claude/settings.json. The hooks directory path defaults to the mnemo repo location but can be overridden with --hooks-dir."}
  ]'
  sleep 2

  # --- Event 5: Observability and monitoring ---
  echo -e "${CYAN}[Event 5] Observability — CloudWatch logs and X-Ray traces${NC}"
  push_event 5 '[
    {"role":"user","content":"We need observability on the AgentCore Memory resource. Application logs should go to CloudWatch and traces to X-Ray."},
    {"role":"assistant","content":"AgentCore supports vended log delivery through the CloudWatch Logs API. I will create a custom resource Lambda that runs after the memory is created. It calls PutDeliverySource with APPLICATION_LOGS type pointing to the memory ARN, creates a CloudWatch log group as destination, and wires them with CreateDelivery. For traces, same pattern but with TRACES type and an X-Ray delivery destination."},
    {"role":"user","content":"The log group path should follow the convention /aws/vendedlogs/bedrock-agentcore/memory/{name}/APPLICATION_LOGS."},
    {"role":"assistant","content":"I will use that exact path convention. The delivery source name will be mnemo-{memoryName}-app-logs and the trace source mnemo-{memoryName}-traces. Both are idempotent — if they already exist, the setup skips without error."}
  ]'
  sleep 2

  # --- Event 6: Cross-workstation workflow ---
  echo -e "${CYAN}[Event 6] Cross-workstation workflow — config and portability${NC}"
  push_event 6 '[
    {"role":"user","content":"I work on both a personal laptop and an Amazon laptop. The memory system should work the same on both, with the workstation field tracking where each interaction happened."},
    {"role":"assistant","content":"The workstation field in the config identifies which machine pushed the event. It is included as metadata on every CreateEvent call. When recalling, the workstation is passed as a query parameter but does not filter results — all memories are returned regardless of origin workstation. This makes the system fully portable: push from laptop A, recall on laptop B."},
    {"role":"user","content":"The batch size for the push hook should be configurable. Default to every 5 prompts."},
    {"role":"assistant","content":"The prompt-submit hook script uses a counter file at /tmp/mnemo-push-counter-{session}. It increments on each prompt and only calls mnemo push when the counter reaches MNEMO_BATCH_SIZE, which defaults to 5 but can be set as an environment variable."}
  ]'
  sleep 2

  # --- Event 7: Error handling and edge cases ---
  echo -e "${CYAN}[Event 7] Error handling — resilience and edge cases${NC}"
  push_event 7 '[
    {"role":"user","content":"What happens if the push fails? I do not want it to block the Claude Code session."},
    {"role":"assistant","content":"The push hook runs the mnemo push command in the background with output redirected to /dev/null. If it fails, the user session is completely unaffected. The hook script also validates that the config file exists and has the required fields before attempting the push. If any prerequisite is missing, it silently exits."},
    {"role":"user","content":"And if recall fails at session start?"},
    {"role":"assistant","content":"The session-start hook returns a JSON response with continue: true regardless of whether the recall succeeds. If mnemo recall fails, it outputs an empty string and the hook reports no memories. The user session starts normally either way. No error popup, no interruption."}
  ]'

  echo -e "\n${GREEN}All events pushed to session $SESSION_ID${NC}"
}

do_wait() {
  echo -e "\n${YELLOW}Waiting ${WAIT_SECONDS}s for AgentCore to process events...${NC}"
  for ((i=WAIT_SECONDS; i>0; i--)); do
    printf "\r  %3ds remaining" "$i"
    sleep 1
  done
  printf "\r  Done!           \n"
}

# --- Main ---

MODE="${1:-full}"

case "$MODE" in
  --push-only)
    do_push
    ;;
  --recall-only)
    do_recall "on-demand"
    ;;
  --tail-logs)
    tail_logs
    ;;
  *)
    do_push
    do_recall "before processing (baseline)"
    do_wait
    do_recall "after processing"
    echo -e "\n${CYAN}=== Test complete ===${NC}"
    echo -e "Session ID: ${YELLOW}$SESSION_ID${NC}"
    echo -e "To recall again: ${YELLOW}mnemo recall --project $PROJECT${NC}"
    echo -e "To tail logs:    ${YELLOW}$0 --tail-logs${NC}"
    ;;
esac
