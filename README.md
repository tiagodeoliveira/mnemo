# mnemo

Centralized AI memory system that captures Claude Code interactions, stores them in Amazon Bedrock AgentCore Memory, and recalls relevant context when starting new sessions — on any workstation.

CLAUDE.md is static. mnemo makes your coding preferences, project decisions, and architectural choices dynamic and portable across machines.

## How it works

mnemo sits between Claude Code and Bedrock AgentCore Memory through a REST API. Clients never touch AWS directly.

**Write path:** Claude Code hook fires on every Nth prompt, batches recent turns, sends them to `POST /events`. The Ingest Lambda maps turns to AgentCore's `CreateEvent` API. AgentCore asynchronously extracts memories using its built-in strategies and triggers the context extractor for self-managed ones.

**Read path:** Claude Code hook fires at session start, calls `GET /recall`. The Recall Lambda queries 3–6 namespace prefixes in parallel (depending on whether project, task, and date are provided) and merges the results.

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
Claude Code hooks
      |
   mnemo CLI
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
  hooks/                    Claude Code hook scripts
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
- `jq` installed (used by hook scripts)

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

### 6. Run the installer

```bash
mnemo install
```

This does two things:
- Creates `~/.mnemo/config.json` with placeholder values
- Installs Claude Code hooks into `~/.claude/settings.json` (SessionStart for recall, UserPromptSubmit for push)

If you cloned mnemo to a non-standard location, pass the hooks directory explicitly:

```bash
mnemo install --hooks-dir /path/to/mnemo/hooks
```

### 7. Edit the mnemo config

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
- `visible` — when `true`, recalled memories are shown as markdown in the conversation. When `false`, they're injected as a silent JSON system message.

The push hook batches every 5 prompts by default — set `MNEMO_BATCH_SIZE` environment variable to change it.

## Usage

### Manual testing with the CLI

Push a test event:

```bash
mnemo push \
  --session "test-$(date +%s)" \
  --turns '[{"role":"user","content":"I prefer TypeScript with strict mode"},{"role":"assistant","content":"Noted, I will use strict TypeScript."}]' \
  --project mnemo \
  --source claude-code \
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
- `hook` — Claude Code JSON structure for hook injection (sets `visible: false` internally)

### How it looks in practice

Once hooks are configured, mnemo works automatically:

1. Start a Claude Code session in a git repo
2. The session-start hook fires, detects the project from the git folder name, and runs `mnemo recall --project <name> --task coding --date <today> --format hook --no-episodes`
3. Recalled memories are injected as hidden context into the conversation
4. As you work, every 5th prompt triggers a background push of recent turns
5. AgentCore extracts preferences, facts, and episodes from the conversation
6. The context extractor classifies the task domain, extracts project-specific facts, and writes a daily summary

Both hooks include a `command -v mnemo` guard — if the CLI isn't installed on a machine, the hooks silently exit without errors.

Next time you start a session — on any machine with mnemo configured — those memories are recalled automatically.

### Viewing raw API responses

```bash
# Full recall with all dimensions
curl -s -H "x-api-key: <key>" \
  "https://<api-url>/v1/recall?project=mnemo&task=coding&date=2026-04-13" | jq

# Global memories only (no project/task/daily)
curl -s -H "x-api-key: <key>" "https://<api-url>/v1/recall" | jq
```
