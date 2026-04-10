# mnemo — Centralized AI Memory System

## Problem

CLAUDE.md is static. When working across multiple workstations and Claude Code sessions, context is lost — coding preferences, project decisions, architectural choices all need to be re-explained. There is no portable, dynamic memory that follows you across machines and sessions.

## Solution

mnemo is a centralized, cross-workstation AI memory system. It captures interactions from Claude Code sessions, stores them in Amazon Bedrock AgentCore Memory with intelligent extraction strategies, and recalls relevant context when a new session starts — on any machine.

## Architecture Overview

Three components in a TypeScript monorepo:

1. **`infra/`** — CDK stack: API Gateway + API key auth, Lambda functions, Bedrock AgentCore Memory resource with strategies
2. **`cli/`** — Lightweight CLI installed on each workstation: pushes events and fetches memories via REST API
3. **`hooks/`** — Claude Code hook configurations that wire the CLI into session lifecycle

Clients never interact with AWS resources directly. All communication goes through a REST API authenticated with API keys.

## Memory Strategy Design

Four strategies, each serving a distinct purpose:

### Built-in: User Preferences

- **Type:** `userPreferenceMemoryStrategy`
- **Namespace:** `/preferences/{actorId}/`
- **Captures:** Coding style, standards, tool preferences, workflow habits
- **Extraction:** Automatic by AgentCore

### Built-in: Semantic Facts

- **Type:** `semanticMemoryStrategy`
- **Namespace:** `/facts/{actorId}/`
- **Captures:** General knowledge and facts across all contexts
- **Extraction:** Automatic by AgentCore

### Built-in: Episodic Memory

- **Type:** `episodicMemoryStrategy`
- **Namespace:** `/episodes/{actorId}/`
- **Reflection namespace:** `/reflections/{actorId}/`
- **Captures:** Structured episodes (situation, intent, assessment, justification) with cross-episode reflection
- **Extraction:** Automatic by AgentCore. Fires when episode completion is detected rather than continuously.
- **Why episodic over summarization:** Episodic captures structured context and generates reflections (cross-cutting insights across episodes). Summarization only condenses sessions — episodic subsumes that and adds pattern recognition.

### Self-managed: Project Context

- **Type:** `customMemoryStrategy` with `selfManagedConfiguration`
- **Namespace:** `/projects/{actorId}/{projectName}/`
- **Captures:** Project-specific decisions, architecture choices, current state
- **Extraction:** Triggered by AgentCore (message count or idle timeout) via SNS. A Lambda receives the payload, uses a Bedrock model to extract project-specific information, reads the project name from event metadata, and writes records to the appropriate namespace via `batch_create_memory_records`.

### Why This Structure

- Built-in strategies handle global, actor-level concerns (preferences, facts, episodes) — no project scoping needed
- Namespace templates only support `{actorId}`, `{sessionId}`, `{strategyId}` — there is no `{project}` variable, so project-scoped namespaces require a self-managed strategy
- Retrieval uses namespace prefix matching: querying `/projects/tiago/` returns all projects, `/projects/tiago/mnemo/` returns only mnemo, `/` returns everything
- The hierarchy is extensible — future sources (meeting recordings, other tools) can add namespaces like `/meetings/{actorId}/` without restructuring

## Concept Mapping: mnemo Client to AgentCore

| mnemo concept | AgentCore mapping |
|---|---|
| User identity | `actorId` = fixed value (e.g., `"tiago"`), configured server-side |
| Claude Code session | `sessionId` = UUID generated per session, used for event grouping |
| Project name | Event metadata `project` — the self-managed Lambda reads this to determine the target namespace |
| Workstation | Event metadata `workstation` — hostname with optional friendly alias override |
| Working directory | Event metadata `workdir` — full path for context |

The API abstracts all AgentCore concepts. The mnemo client is unaware of actorId, namespaces, or strategies.

## REST API

**Auth:** API key via `x-api-key` header (API Gateway usage plans).

### POST /events

Push conversation turns with context metadata.

Request:
```json
{
  "sessionId": "uuid",
  "turns": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "context": {
    "project": "mnemo",
    "workstation": "personal-laptop",
    "workdir": "/Users/tiagode/src/github.com/tiagodeoliveira/mnemo",
    "timestamp": "2026-04-10T14:30:00Z"
  }
}
```

The Ingest Lambda:
- Resolves `actorId` from server-side configuration
- Passes `sessionId` through
- Maps `project`, `workstation`, `workdir`, `timestamp` to event metadata
- Converts `turns` to conversational payload
- Calls `CreateEvent`

### GET /recall

Fetch relevant memories for a session start.

Request:
```
GET /recall?project=mnemo&workstation=personal-laptop
```

Both parameters are optional. If `project` is omitted (not in a git repo), project-specific memories are skipped.

The Recall Lambda orchestrates parallel queries:
1. `/preferences/{actorId}/` — always (global preferences)
2. `/facts/{actorId}/` — always (general knowledge)
3. `/episodes/{actorId}/` + `/reflections/{actorId}/` — always (episodic insights)
4. `/projects/{actorId}/{projectName}/` — only if `project` param present

Response:
```json
{
  "preferences": [...],
  "facts": [...],
  "episodes": [...],
  "reflections": [...],
  "project": {
    "name": "mnemo",
    "memories": [...]
  }
}
```

When `project` is omitted, the `project` field is absent from the response.

## AWS Infrastructure (CDK)

- **Bedrock AgentCore Memory resource** with four strategies configured
- **API Gateway (REST)** with API key authentication, single stage
- **Ingest Lambda** — thin pass-through, validates payload, maps to `CreateEvent`
- **Recall Lambda** — smart retrieval, multi-namespace parallel queries, merge and rank results
- **Project Extractor Lambda** — triggered by SNS from self-managed strategy, extracts project context using Bedrock model, writes to `/projects/{actorId}/{projectName}/` via `batch_create_memory_records`
- **SNS Topic** — bridge between AgentCore self-managed trigger and project extractor Lambda
- **S3 Bucket** — payload delivery for self-managed strategy (AgentCore requirement)
- **IAM roles** scoped to the specific memory resource
- **Single region**, single account

All TypeScript.

## CLI (`mnemo`)

Lightweight TypeScript CLI installed on each workstation.

### Commands

```bash
mnemo push --session <id> --turns <json> --project <name> --workdir <path>
mnemo recall --project <name>
```

### Configuration

`~/.mnemo/config.json`:
```json
{
  "apiUrl": "https://{api-id}.execute-api.{region}.amazonaws.com/v1",
  "apiKey": "your-api-key",
  "workstation": "personal-laptop",
  "defaults": {
    "visible": true
  }
}
```

- `workstation` defaults to hostname if not set
- `visible` controls whether recalled memories are shown in the conversation or silently injected (defaults to visible)

### Project Detection

- If the current directory is inside a git repo: project name = folder name of the repo root
- If not in a git repo: no project context (global memories only)

## Claude Code Hooks

Two hooks configured in Claude Code's `settings.json`:

### Session Start Hook

- **Hook event:** `UserPromptSubmit` (fires on the first user message in a session)
- Detects project from git repo folder name
- Runs `mnemo recall --project <name>`
- Output injected into conversation context

### Post-Conversation Hook

- **Hook event:** `PostToolUse` or a periodic trigger — exact hook event to be determined during implementation based on available Claude Code hook events
- Batches recent conversation turns
- Runs `mnemo push` in background (non-blocking)

## Data Flow

### Session Start (Recall)

```
Claude Code starts
  -> session start hook fires
  -> hook detects git repo -> folder name = "mnemo"
  -> runs: mnemo recall --project mnemo
  -> CLI reads ~/.mnemo/config.json
  -> GET /recall?project=mnemo&workstation=personal-laptop
  -> API Gateway validates API key
  -> Recall Lambda queries 4 namespace prefixes in parallel
  -> merges, ranks by relevance, returns JSON
  -> CLI formats output
  -> hook injects into Claude's context
```

### During Session (Push)

```
Every N turns or session end:
  -> post-conversation hook fires
  -> collects last N turns as JSON
  -> runs: mnemo push --session <uuid> --turns <json> --project mnemo --workdir /Users/...
  -> CLI reads config
  -> POST /events
  -> API Gateway validates API key
  -> Ingest Lambda -> CreateEvent
  -> AgentCore asynchronously:
      Built-in strategies extract preferences, facts, episodes
      Self-managed trigger fires -> SNS -> project-extractor Lambda
        -> extracts project decisions using Bedrock model
        -> batch_create_memory_records to /projects/tiago/mnemo/
```

### Cross-Workstation

```
personal-laptop session:
  Push: "decided to use DynamoDB single-table design for mnemo"
  -> stored in /projects/tiago/mnemo/

Next day, work-desktop:
  Claude Code starts -> recall -> GET /recall?project=mnemo
  -> returns: "decided to use DynamoDB single-table design"
  -> Claude knows the decision without re-explanation
```

## Monorepo Structure

```
mnemo/
  infra/                          # CDK stack (TypeScript)
    bin/
      mnemo.ts                    # CDK app entry point
    lib/
      mnemo-stack.ts              # Main stack
      memory-construct.ts         # AgentCore Memory + strategies
      api-construct.ts            # API Gateway + API key
      lambda-construct.ts         # Lambda functions
    lambda/
      ingest/                     # POST /events handler
        index.ts
      recall/                     # GET /recall handler
        index.ts
      project-extractor/          # Self-managed strategy Lambda
        index.ts
  cli/                            # mnemo CLI (TypeScript)
    src/
      index.ts
      commands/
        push.ts
        recall.ts
      config.ts                   # Config loader
    package.json
  hooks/                          # Claude Code hook configs + docs
  package.json                    # Root workspace config
  tsconfig.base.json              # Shared TS config
```

## Out of Scope (v1)

- MCP server (hooks-only for now)
- Multi-user support (single actor)
- Custom UI/dashboard
- Meeting recording integration (namespace structure supports it for later)
- Custom strategy prompt tuning (start with built-in defaults)
- Memory management commands (forget, list, etc.)
- Custom KMS encryption (use AWS-managed)
- Kinesis streaming

All additive — the architecture supports future addition of each.
