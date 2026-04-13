# mnemo

Centralized AI memory system built on Amazon Bedrock AgentCore Memory. Any AI tool can push conversation turns and recall relevant context through a simple REST API — preferences, facts, project decisions, and daily summaries follow you across sessions and workstations.

Ships with a CLI and Claude Code hooks as the first integration, but the API is client-agnostic.

## How it works

mnemo exposes a REST API backed by Bedrock AgentCore Memory. Clients never touch AWS directly — they push conversation turns and recall memories through `POST /events` and `GET /recall`.

**Write path:** A client sends conversation turns to `POST /events`. The Ingest Lambda maps them to AgentCore's `CreateEvent` API. AgentCore asynchronously extracts memories using its built-in strategies and triggers the context extractor for self-managed ones.

**Read path:** A client calls `GET /recall` with optional project, task, and date parameters. The Recall Lambda queries 3–6 namespace prefixes in parallel and merges the results.

### Memory dimensions

| Dimension | Type | Namespace | What it captures |
|---|---|---|---|
| Preferences | built-in | `/preferences/{actorId}/` | Coding style, standards, tool preferences |
| Facts | built-in | `/facts/{actorId}/` | General knowledge and facts |
| Episodes | built-in | `/episodes/{actorId}/` | Structured episodes with reflections |
| Project | self-managed | `/projects/{actorId}/{projectName}/` | Architecture decisions, tech choices, project state |
| Task | self-managed | `/tasks/{actorId}/{taskDomain}/` | Domain-specific insights (e.g., coding, studying, meeting) |
| Daily | self-managed | `/daily/{actorId}/{YYYY-MM-DD}/` | 1–3 sentence activity summary per day |

Built-in strategies are extracted automatically by AgentCore. The self-managed dimensions (project, task, daily) are handled by the context extractor: AgentCore triggers an SNS notification, a Lambda reads the conversation payload from S3, uses Claude Sonnet to classify the task domain, extract facts, and write a daily summary via `BatchCreateMemoryRecords`.

Task domain classification uses a configurable list of domains (default: `coding`, `studying`, `meeting`, `general`). Project detection uses the git repo folder name. Sessions outside a git repo get global memories only (preferences, facts, episodes) — no project context.

### Architecture

```
Any AI client (hooks, scripts, tools)
      |
   mnemo CLI  or  direct API call
      |
  API Gateway (API key auth)
      |
  +---------+---------+
  |                   |
Ingest Lambda    Recall Lambda
  |                   |
  CreateEvent    RetrieveMemoryRecords (x3-6 parallel)
  |
  AgentCore (async)
  |
  +-----------+-----------+-----------+-----------------------------+
  |           |           |           |                             |
  Prefs    Facts     Episodes    Context Extractor (SNS -> Lambda)
                                      |
                                  Claude Sonnet
                                      |
                            +---------+---------+
                            |         |         |
                         Project    Task      Daily
                      BatchCreate  per dimension
```

## Project structure

```
mnemo/
  infra/                    CDK stack (TypeScript)
    bin/mnemo.ts            CDK app entry point
    lib/
      mnemo-stack.ts        Main stack, wires all constructs
      memory-construct.ts   AgentCore Memory, execution role, SNS, S3, observability
      api-construct.ts      API Gateway + API key
      lambda-construct.ts   Lambda function definitions
    lambda/
      ingest/               POST /events handler
      recall/               GET /recall handler
      context-extractor/    SNS-triggered multi-dimension extractor
      observability-setup/  CloudWatch Logs + X-Ray delivery (custom resource)
      shared/types.ts       Shared TypeScript types
    test/                   Infra unit tests (7 files)
  cli/                      CLI tool (TypeScript)
    src/
      index.ts              Entry point (push, recall, install commands)
      config.ts             Config loader (~/.mnemo/config.json)
      detect-project.ts     Git-based project detection
      commands/
        push.ts             Send turns to API
        recall.ts           Fetch memories from API
        install-hooks.ts    Install config + Claude Code hooks
    test/                   CLI unit tests (5 files)
  hooks/                    Claude Code integration (first supported client)
    session-start.sh        Recall memories at session start
    prompt-submit.sh        Batch and push turns during session
    settings.example.json   Example Claude Code settings
  scripts/
    cleanup-memory.ts       Utility to delete memory records by namespace
    smoke-test.sh           Integration test script
```

## Prerequisites

- Node.js 22+
- AWS account with CDK bootstrapped (`npx cdk bootstrap`)
- AWS CLI configured with credentials
- Bedrock AgentCore Memory access enabled in your region
- `jq` installed (used by the Claude Code hook scripts)

**Important:** The `@aws-sdk/client-bedrock-agentcore` package must be available in the Lambda runtime for the ingest, recall, and context-extractor functions. This package is pre-installed in the Node.js 22 Lambda runtime. The CDK stack uses the native `AWS::BedrockAgentCore::Memory` CloudFormation resource, so no control-plane SDK is needed at deploy time.

## Deploy

### 1. Install dependencies

```bash
git clone <repo-url> && cd mnemo
npm install
```

### 2. Run tests

```bash
cd infra && npx vitest run
cd ../cli && npx vitest run
```

### 3. Deploy the CDK stack

```bash
cd infra
npx cdk deploy --context actorId=<your-name>
```

The `actorId` is your identity in the memory system. Defaults to `tiago` if omitted.

Note the outputs:
- **ApiUrl** — your REST API endpoint (e.g., `https://abc123.execute-api.us-east-1.amazonaws.com/v1`)
- **ApiKeyId** — the API key ID (not the value)

### 4. Get the API key value

List the stack outputs (API URL and API key ID):

```bash
aws cloudformation describe-stacks --stack-name MnemoStack --query 'Stacks[0].Outputs' --output table
```

Then retrieve the actual API key value using the API key ID from the output:

```bash
aws apigateway get-api-key --api-key <API_KEY_ID> --include-value --query 'value' --output text
```

## Configure

### 5. Build the CLI and install

```bash
cd cli && npm run build
npm link -w mnemo-cli
```

Run `npm link` from the monorepo root, or alternatively `cd cli && npm link`.

This makes the `mnemo` command available globally.

### 6. Edit the mnemo config

Open `~/.mnemo/config.json` and fill in the values from the deploy outputs:

```json
{
  "apiUrl": "https://<api-id>.execute-api.<region>.amazonaws.com/v1",
  "apiKey": "<your-api-key-value>",
  "workstation": "personal-laptop",
  "defaults": {
    "visible": true
  }
}
```

- `workstation` — friendly name for this machine. Defaults to hostname if omitted.
- `visible` — when `true`, recalled memories are shown as markdown. When `false`, they're returned as a JSON structure suitable for programmatic injection.

## Usage

### CLI

Push conversation turns:

```bash
mnemo push \
  --session "test-$(date +%s)" \
  --turns '[{"role":"user","content":"I prefer TypeScript with strict mode"},{"role":"assistant","content":"Noted, I will use strict TypeScript."}]' \
  --project mnemo \
  --source my-tool \
  --workdir "$(pwd)"
```

Recall memories:

```bash
mnemo recall --project mnemo --task coding --date "$(date +%Y-%m-%d)"
```

Without `--project`, `--task`, or `--date`, only global memories (preferences, facts, episodes) are returned. Each flag adds one more parallel namespace query.

Use `--no-episodes` to exclude episodic memories (useful in hooks where episodes add noise):

```bash
mnemo recall --project mnemo --format hook --no-episodes
```

Output format is controlled by `--format`:
- `visible` — human-readable markdown
- `hook` — JSON structure for programmatic injection (sets `visible: false` internally)

### Direct API access

Any client can use the REST API directly:

```bash
# Push turns
curl -s -X POST -H "x-api-key: <key>" -H "Content-Type: application/json" \
  "https://<api-url>/v1/events" \
  -d '{"sessionId":"s1","turns":[{"role":"user","content":"hello"}]}'

# Full recall with all dimensions
curl -s -H "x-api-key: <key>" \
  "https://<api-url>/v1/recall?project=mnemo&task=coding&date=2026-04-13" | jq

# Global memories only (no project/task/daily)
curl -s -H "x-api-key: <key>" "https://<api-url>/v1/recall" | jq
```

### Claude Code integration

mnemo ships with hook scripts that wire it into Claude Code automatically.

**Install:**

```bash
mnemo install
```

This creates `~/.mnemo/config.json` (if it doesn't exist) and installs hooks into `~/.claude/settings.json` (SessionStart for recall, UserPromptSubmit for push). If you cloned mnemo to a non-standard location, pass `--hooks-dir /path/to/mnemo/hooks`.

**How it works in practice:**

1. Start a Claude Code session in a git repo
2. The session-start hook detects the project and runs `mnemo recall --project <name> --task coding --date <today> --format hook --no-episodes`
3. Recalled memories are injected as hidden context into the conversation
4. Every 3rd prompt triggers a background push of recent turns (configurable via `MNEMO_BATCH_SIZE`)
5. AgentCore extracts preferences, facts, and episodes; the context extractor writes project, task, and daily memories

Both hooks include a `command -v mnemo` guard — if the CLI isn't installed on a machine, the hooks silently exit without errors.

Next session — on any machine with mnemo configured — those memories are recalled automatically.
