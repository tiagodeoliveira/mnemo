# mnemo

Centralized AI memory system that captures Claude Code interactions, stores them in Amazon Bedrock AgentCore Memory, and recalls relevant context when starting new sessions — on any workstation.

CLAUDE.md is static. mnemo makes your coding preferences, project decisions, and architectural choices dynamic and portable across machines.

## How it works

mnemo sits between Claude Code and Bedrock AgentCore Memory through a REST API. Clients never touch AWS directly.

**Write path:** Claude Code hook fires on every Nth prompt, batches recent turns, sends them to `POST /events`. The Ingest Lambda maps turns to AgentCore's `CreateEvent` API. AgentCore asynchronously extracts memories using four strategies.

**Read path:** Claude Code hook fires at session start, calls `GET /recall`. The Recall Lambda queries three namespace prefixes in parallel (four if inside a project) and merges the results.

### Memory strategies

| Strategy | Type | Namespace | What it captures |
|---|---|---|---|
| User Preferences | built-in | `/preferences/{actorId}/` | Coding style, standards, tool preferences |
| Semantic Facts | built-in | `/facts/{actorId}/` | General knowledge and facts |
| Episodic | built-in | `/episodes/{actorId}/` | Structured episodes with reflections (same namespace) |
| Project Context | self-managed | `/projects/{actorId}/{projectName}/` | Architecture decisions, tech choices, project state |

Built-in strategies are extracted automatically by AgentCore. The project context strategy is self-managed: AgentCore triggers an SNS notification, a Lambda reads the conversation payload from S3, uses a Bedrock model to extract project-specific facts, and writes them via `BatchCreateMemoryRecords`.

Project detection uses the git repo folder name. Sessions outside a git repo get global memories only (preferences, facts, episodes) — no project context.

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
  CreateEvent    RetrieveMemoryRecords (x3-4 parallel)
  |
  AgentCore (async)
  |
  +-----------+-----------+-----------+
  |           |           |           |
  UserPref  Semantic  Episodic   Custom (SNS -> Lambda -> BatchCreate)
```

## Project structure

```
mnemo/
  infra/                    CDK stack (TypeScript)
    bin/mnemo.ts            CDK app entry point
    lib/
      mnemo-stack.ts        Main stack, wires all constructs
      memory-construct.ts   AgentCore Memory (CfnMemory), execution role, SNS, S3
      api-construct.ts      API Gateway + API key
      lambda-construct.ts   Lambda function definitions
    lambda/
      ingest/               POST /events handler
      recall/               GET /recall handler
      project-extractor/    SNS-triggered project context extractor
  cli/                      CLI tool (TypeScript)
    src/
      index.ts              Entry point (push, recall, install commands)
      config.ts             Config loader (~/.mnemo/config.json)
      detect-project.ts     Git-based project detection
      commands/
        push.ts             Send turns to API
        recall.ts           Fetch memories from API
        install-hooks.ts    Install config + Claude Code hooks
  hooks/                    Claude Code hook scripts
    session-start.sh        Recall memories at session start
    prompt-submit.sh        Batch and push turns during session
    settings.example.json   Example Claude Code settings
```

## Prerequisites

- Node.js 22+
- AWS account with CDK bootstrapped (`npx cdk bootstrap`)
- AWS CLI configured with credentials
- Bedrock AgentCore Memory access enabled in your region
- `jq` installed (used by hook scripts)

**Important:** The `@aws-sdk/client-bedrock-agentcore` package must be available in the Lambda runtime for the ingest, recall, and project-extractor functions. This package is pre-installed in the Node.js 22 Lambda runtime. The CDK stack uses the native `AWS::BedrockAgentCore::Memory` CloudFormation resource, so no control-plane SDK is needed at deploy time.

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
  --workdir "$(pwd)"
```

Recall memories:

```bash
mnemo recall --project mnemo
```

Without `--project`, only global memories (preferences, facts, episodes) are returned.

### How it looks in practice

Once hooks are configured, mnemo works automatically:

1. Start a Claude Code session in a git repo
2. The session-start hook fires, detects the project from the git folder name, and runs `mnemo recall`
3. Recalled memories appear in the conversation (if `visible: true`)
4. As you work, every 5th prompt triggers a background push of recent turns
5. AgentCore extracts preferences, facts, and episodes from the conversation
6. If the conversation has project metadata, the project extractor writes project-specific memories

Next time you start a session — on any machine with mnemo configured — those memories are recalled automatically.

### Viewing raw API responses

```bash
# All memories for a project
curl -s -H "x-api-key: <key>" "https://<api-url>/v1/recall?project=mnemo" | jq

# Global memories only (no project)
curl -s -H "x-api-key: <key>" "https://<api-url>/v1/recall" | jq
```
