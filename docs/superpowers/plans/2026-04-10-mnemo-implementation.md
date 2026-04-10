# mnemo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a centralized AI memory system that captures Claude Code interactions, stores them in Bedrock AgentCore Memory with intelligent extraction, and recalls relevant context at session start across workstations.

**Architecture:** REST API (API Gateway + Lambda) in front of Bedrock AgentCore Memory. Clients use a lightweight TypeScript CLI wired into Claude Code hooks. Four memory strategies: user preferences, semantic facts, episodic (built-in), plus a self-managed project context extractor. No AWS credentials on workstations — API key auth only.

**Tech Stack:** TypeScript throughout. CDK for infrastructure, NodejsFunction for Lambdas, npm workspaces for monorepo, vitest for testing, commander for CLI.

**Key reference:** Design spec at `docs/superpowers/specs/2026-04-10-mnemo-design.md`

**SDK packages:**
- `@aws-sdk/client-bedrock-agentcore` — data plane (CreateEvent, RetrieveMemoryRecords, BatchCreateMemoryRecords)
- `@aws-sdk/client-bedrock-agentcore-control` — control plane (CreateMemory, UpdateMemory, DeleteMemory, GetMemory)
- `@aws-sdk/client-bedrock-runtime` — model invocation (InvokeModel, for project extractor)
- `@aws-sdk/client-s3` — read payload from S3 (for project extractor)

**Note:** If `@aws-sdk/client-bedrock-agentcore*` packages don't exist in npm yet (very new service), check for alternate package names. The Python equivalents are `boto3.client('bedrock-agentcore')` and `boto3.client('bedrock-agentcore-control')`.

---

## File Map

### Root
- `package.json` — npm workspace config
- `tsconfig.base.json` — shared TypeScript config
- `.gitignore`
- `CLAUDE.md` — project conventions for Claude Code

### infra/
- `package.json` — CDK + AWS SDK dependencies
- `tsconfig.json` — extends base
- `cdk.json` — CDK app config
- `bin/mnemo.ts` — CDK app entry point
- `lib/mnemo-stack.ts` — main stack, wires all constructs
- `lib/memory-construct.ts` — AgentCore Memory custom resource + strategy config
- `lib/api-construct.ts` — API Gateway + API key + usage plan
- `lib/lambda-construct.ts` — NodejsFunction definitions for all lambdas
- `lambda/shared/types.ts` — shared types for lambda payloads
- `lambda/memory-provider/index.ts` — custom resource handler for Memory lifecycle
- `lambda/ingest/index.ts` — POST /events handler
- `lambda/recall/index.ts` — GET /recall handler
- `lambda/project-extractor/index.ts` — SNS-triggered project context extractor
- `test/memory-construct.test.ts` — CDK assertion tests
- `test/api-construct.test.ts` — CDK assertion tests
- `test/lambda-construct.test.ts` — CDK assertion tests
- `test/mnemo-stack.test.ts` — full stack assertion test
- `test/lambda/ingest.test.ts` — unit tests for ingest lambda
- `test/lambda/recall.test.ts` — unit tests for recall lambda
- `test/lambda/project-extractor.test.ts` — unit tests for project extractor
- `test/lambda/memory-provider.test.ts` — unit tests for custom resource provider

### cli/
- `package.json` — commander dependencies
- `tsconfig.json` — extends base
- `src/index.ts` — CLI entry point
- `src/config.ts` — config loader (~/.mnemo/config.json)
- `src/commands/push.ts` — push command
- `src/commands/recall.ts` — recall command
- `src/detect-project.ts` — git repo detection + folder name extraction
- `test/config.test.ts`
- `test/push.test.ts`
- `test/recall.test.ts`
- `test/detect-project.test.ts`

### hooks/
- `session-start.sh` — recall hook script
- `prompt-submit.sh` — push hook script
- `settings.example.json` — example Claude Code settings.json with hook config

---

## Task 1: Monorepo Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `CLAUDE.md`

- [ ] **Step 1: Create root package.json with workspaces**

```json
{
  "name": "mnemo",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "infra",
    "cli"
  ]
}
```

- [ ] **Step 2: Create shared tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "strictPropertyInitialization": false,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
cdk.out/
*.js
*.d.ts
*.js.map
!jest.config.js
!vitest.config.ts
.env
```

- [ ] **Step 4: Create CLAUDE.md**

```markdown
# mnemo

Centralized AI memory system using Amazon Bedrock AgentCore Memory.

## Structure

- `infra/` — CDK stack (TypeScript): API Gateway, Lambdas, AgentCore Memory
- `cli/` — CLI tool installed on workstations
- `hooks/` — Claude Code hook scripts

## Commands

- `cd infra && npx cdk synth` — synthesize CloudFormation template
- `cd infra && npx cdk deploy` — deploy stack
- `cd infra && npx vitest` — run infra tests
- `cd cli && npx vitest` — run CLI tests
- `npm install` — install all workspace dependencies

## Conventions

- TypeScript everywhere
- vitest for testing
- CDK assertions for infrastructure tests
- AWS SDK v3 client mocking with aws-sdk-client-mock for Lambda unit tests
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .gitignore CLAUDE.md
git commit -m "feat: initialize mnemo monorepo scaffolding"
```

---

## Task 2: CDK Project Setup

**Files:**
- Create: `infra/package.json`
- Create: `infra/tsconfig.json`
- Create: `infra/cdk.json`
- Create: `infra/bin/mnemo.ts`
- Create: `infra/lib/mnemo-stack.ts`
- Create: `infra/vitest.config.ts`
- Create: `infra/test/mnemo-stack.test.ts`

- [ ] **Step 1: Create infra/package.json**

```json
{
  "name": "mnemo-infra",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "cdk": "cdk"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.170.0",
    "constructs": "^10.4.0",
    "@aws-sdk/client-bedrock-agentcore": "*",
    "@aws-sdk/client-bedrock-agentcore-control": "*",
    "@aws-sdk/client-bedrock-runtime": "^3.700.0",
    "@aws-sdk/client-s3": "^3.700.0"
  },
  "devDependencies": {
    "aws-cdk": "^2.170.0",
    "typescript": "~5.7.0",
    "vitest": "^3.0.0",
    "aws-sdk-client-mock": "^4.0.0",
    "@types/aws-lambda": "^8.10.145",
    "esbuild": "^0.24.0"
  }
}
```

**Note:** If `@aws-sdk/client-bedrock-agentcore*` packages are not yet published, check the AWS SDK v3 changelog for the correct package names. The service endpoint is `bedrock-agentcore` and `bedrock-agentcore-control`.

- [ ] **Step 2: Create infra/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": [
    "bin/**/*.ts",
    "lib/**/*.ts",
    "lambda/**/*.ts",
    "test/**/*.ts"
  ]
}
```

- [ ] **Step 3: Create infra/cdk.json**

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/mnemo.ts",
  "watch": {
    "include": ["**"],
    "exclude": [
      "README.md",
      "cdk*.json",
      "**/*.d.ts",
      "**/*.js",
      "tsconfig.json",
      "package*.json",
      "node_modules",
      "test"
    ]
  },
  "context": {
    "@aws-cdk/core:stackRelativeExports": true
  }
}
```

- [ ] **Step 4: Create infra/vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 5: Create empty stack and app entry point**

`infra/lib/mnemo-stack.ts`:
```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface MnemoStackProps extends cdk.StackProps {
  actorId: string;
}

export class MnemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MnemoStackProps) {
    super(scope, id, props);
  }
}
```

`infra/bin/mnemo.ts`:
```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MnemoStack } from '../lib/mnemo-stack';

const app = new cdk.App();

new MnemoStack(app, 'MnemoStack', {
  actorId: app.node.tryGetContext('actorId') || 'tiago',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

- [ ] **Step 6: Write smoke test for empty stack**

`infra/test/mnemo-stack.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MnemoStack } from '../lib/mnemo-stack';

describe('MnemoStack', () => {
  it('synthesizes without errors', () => {
    const app = new cdk.App();
    const stack = new MnemoStack(app, 'TestStack', {
      actorId: 'test-actor',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });
});
```

- [ ] **Step 7: Install dependencies and run test**

```bash
cd infra && npm install && npx vitest run
```

Expected: 1 test passing.

- [ ] **Step 8: Commit**

```bash
git add infra/
git commit -m "feat: initialize CDK project with empty stack"
```

---

## Task 3: Shared Lambda Types

**Files:**
- Create: `infra/lambda/shared/types.ts`

- [ ] **Step 1: Define shared types used across lambdas and API**

`infra/lambda/shared/types.ts`:
```typescript
export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface EventContext {
  project?: string;
  workstation: string;
  workdir: string;
  timestamp: string;
}

export interface IngestRequest {
  sessionId: string;
  turns: Turn[];
  context: EventContext;
}

export interface MemoryRecord {
  id: string;
  content: string;
  score: number;
  createdAt: string;
}

export interface RecallResponse {
  preferences: MemoryRecord[];
  facts: MemoryRecord[];
  episodes: MemoryRecord[];
  reflections: MemoryRecord[];
  project?: {
    name: string;
    memories: MemoryRecord[];
  };
}

export interface MemoryProviderProperties {
  memoryName: string;
  description: string;
  actorId: string;
  eventExpiryDuration: number;
  strategies: MemoryStrategyConfig;
}

export interface MemoryStrategyConfig {
  userPreference: {
    name: string;
    namespaceTemplates: string[];
  };
  semantic: {
    name: string;
    namespaceTemplates: string[];
  };
  episodic: {
    name: string;
    namespaceTemplates: string[];
    reflectionNamespaceTemplates: string[];
  };
  projectContext: {
    name: string;
    triggerMessageCount: number;
    idleSessionTimeout: number;
    snsTopicArn: string;
    s3BucketName: string;
    historicalContextWindowSize: number;
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/lambda/shared/
git commit -m "feat: add shared types for lambda payloads"
```

---

## Task 4: Memory Custom Resource Provider Lambda

**Files:**
- Create: `infra/lambda/memory-provider/index.ts`
- Create: `infra/test/lambda/memory-provider.test.ts`

This Lambda handles CloudFormation custom resource lifecycle events (CREATE/UPDATE/DELETE) for the AgentCore Memory resource. No CloudFormation native support exists for AgentCore Memory, so we use a Lambda-backed custom resource.

- [ ] **Step 1: Write tests for the memory provider**

`infra/test/lambda/memory-provider.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateMemory = vi.fn();
const mockGetMemory = vi.fn();
const mockDeleteMemory = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((command: any) => {
      if (command.constructor.name === 'CreateMemoryCommand') return mockCreateMemory(command.input);
      if (command.constructor.name === 'GetMemoryCommand') return mockGetMemory(command.input);
      if (command.constructor.name === 'DeleteMemoryCommand') return mockDeleteMemory(command.input);
    }),
  })),
  CreateMemoryCommand: vi.fn().mockImplementation((input: any) => ({ input, constructor: { name: 'CreateMemoryCommand' } })),
  GetMemoryCommand: vi.fn().mockImplementation((input: any) => ({ input, constructor: { name: 'GetMemoryCommand' } })),
  DeleteMemoryCommand: vi.fn().mockImplementation((input: any) => ({ input, constructor: { name: 'DeleteMemoryCommand' } })),
}));

import { handler } from '../../lambda/memory-provider/index';

describe('memory-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AWS_REGION = 'us-east-1';
  });

  it('creates memory with all strategies on CREATE', async () => {
    mockCreateMemory.mockResolvedValue({
      memory: { id: 'mem-123', status: 'CREATING' },
    });
    mockGetMemory.mockResolvedValue({
      memory: { id: 'mem-123', status: 'ACTIVE' },
    });

    const result = await handler({
      RequestType: 'Create',
      ResourceProperties: {
        memoryName: 'mnemo-memory',
        description: 'mnemo memory store',
        eventExpiryDuration: 90,
        snsTopicArn: 'arn:aws:sns:us-east-1:123456789:mnemo-topic',
        s3BucketName: 'mnemo-payload-bucket',
        actorId: 'tiago',
      },
    } as any);

    expect(result.PhysicalResourceId).toBe('mem-123');
    expect(result.Data.MemoryId).toBe('mem-123');
    expect(mockCreateMemory).toHaveBeenCalledOnce();
  });

  it('deletes memory on DELETE', async () => {
    mockDeleteMemory.mockResolvedValue({});

    const result = await handler({
      RequestType: 'Delete',
      PhysicalResourceId: 'mem-123',
      ResourceProperties: {},
    } as any);

    expect(result.PhysicalResourceId).toBe('mem-123');
    expect(mockDeleteMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: 'mem-123' })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd infra && npx vitest run test/lambda/memory-provider.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the memory provider Lambda**

`infra/lambda/memory-provider/index.ts`:
```typescript
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  GetMemoryCommand,
  DeleteMemoryCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const client = new BedrockAgentCoreControlClient({});

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 60;

interface ProviderResponse {
  PhysicalResourceId: string;
  Data: Record<string, string>;
}

async function waitForActive(memoryId: string): Promise<void> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const response = await client.send(new GetMemoryCommand({ memoryId }));
    const status = response.memory?.status;
    if (status === 'ACTIVE') return;
    if (status === 'FAILED') throw new Error(`Memory creation failed for ${memoryId}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timeout waiting for memory ${memoryId} to become ACTIVE`);
}

async function onCreate(event: CloudFormationCustomResourceEvent): Promise<ProviderResponse> {
  const props = event.ResourceProperties;

  const response = await client.send(
    new CreateMemoryCommand({
      name: props.memoryName,
      description: props.description,
      eventExpiryDuration: Number(props.eventExpiryDuration),
      memoryStrategies: [
        {
          userPreferenceMemoryStrategy: {
            name: 'UserPreferences',
            namespaceTemplates: ['/preferences/{actorId}/'],
          },
        },
        {
          semanticMemoryStrategy: {
            name: 'SemanticFacts',
            namespaceTemplates: ['/facts/{actorId}/'],
          },
        },
        {
          episodicMemoryStrategy: {
            name: 'EpisodicMemory',
            namespaceTemplates: ['/episodes/{actorId}/'],
            reflectionConfiguration: {
              namespaceTemplates: ['/reflections/{actorId}/'],
            },
          },
        },
        {
          customMemoryStrategy: {
            name: 'ProjectContext',
            namespaceTemplates: ['/projects/{actorId}/'],
            configuration: {
              selfManagedConfiguration: {
                triggerConditions: [
                  { messageBasedTrigger: { messageCount: 10 } },
                  { timeBasedTrigger: { idleSessionTimeout: 300 } },
                ],
                invocationConfiguration: {
                  topicArn: props.snsTopicArn,
                  payloadDeliveryBucketName: props.s3BucketName,
                },
                historicalContextWindowSize: 50,
              },
            },
          },
        },
      ],
    })
  );

  const memoryId = response.memory!.id!;
  await waitForActive(memoryId);

  return {
    PhysicalResourceId: memoryId,
    Data: { MemoryId: memoryId },
  };
}

async function onDelete(event: CloudFormationCustomResourceEvent): Promise<ProviderResponse> {
  const memoryId = event.PhysicalResourceId;
  try {
    await client.send(new DeleteMemoryCommand({ memoryId }));
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
  return { PhysicalResourceId: memoryId, Data: {} };
}

export async function handler(event: CloudFormationCustomResourceEvent): Promise<ProviderResponse> {
  switch (event.RequestType) {
    case 'Create':
      return onCreate(event);
    case 'Update':
      return onCreate(event);
    case 'Delete':
      return onDelete(event);
    default:
      throw new Error(`Unknown RequestType: ${event.RequestType}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd infra && npx vitest run test/lambda/memory-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/memory-provider/ infra/test/lambda/memory-provider.test.ts
git commit -m "feat: add memory custom resource provider lambda"
```

---

## Task 5: Memory CDK Construct

**Files:**
- Create: `infra/lib/memory-construct.ts`
- Create: `infra/test/memory-construct.test.ts`

- [ ] **Step 1: Write CDK assertion test**

`infra/test/memory-construct.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MemoryConstruct } from '../lib/memory-construct';

describe('MemoryConstruct', () => {
  it('creates custom resource, SNS topic, and S3 bucket', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd infra && npx vitest run test/memory-construct.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Memory construct**

`infra/lib/memory-construct.ts`:
```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface MemoryConstructProps {
  memoryName: string;
  actorId: string;
  eventExpiryDuration?: number;
}

export class MemoryConstruct extends Construct {
  public readonly memoryId: string;
  public readonly snsTopic: sns.Topic;
  public readonly payloadBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: MemoryConstructProps) {
    super(scope, id);

    this.snsTopic = new sns.Topic(this, 'ProjectExtractorTopic', {
      topicName: 'mnemo-project-extractor',
    });

    this.payloadBucket = new s3.Bucket(this, 'PayloadBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    const providerFn = new NodejsFunction(this, 'MemoryProviderFn', {
      entry: path.join(__dirname, '..', 'lambda', 'memory-provider', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(10),
      bundling: {
        externalModules: [],
      },
    });

    providerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateMemory',
          'bedrock-agentcore:GetMemory',
          'bedrock-agentcore:UpdateMemory',
          'bedrock-agentcore:DeleteMemory',
        ],
        resources: ['*'],
      })
    );

    providerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: ['*'],
      })
    );

    const provider = new cr.Provider(this, 'MemoryProvider', {
      onEventHandler: providerFn,
    });

    const memory = new cdk.CustomResource(this, 'Memory', {
      serviceToken: provider.serviceToken,
      properties: {
        memoryName: props.memoryName,
        description: 'mnemo centralized AI memory',
        eventExpiryDuration: props.eventExpiryDuration ?? 90,
        snsTopicArn: this.snsTopic.topicArn,
        s3BucketName: this.payloadBucket.bucketName,
        actorId: props.actorId,
      },
    });

    this.memoryId = memory.getAttString('MemoryId');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd infra && npx vitest run test/memory-construct.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/memory-construct.ts infra/test/memory-construct.test.ts
git commit -m "feat: add Memory CDK construct with custom resource"
```

---

## Task 6: Ingest Lambda

**Files:**
- Create: `infra/lambda/ingest/index.ts`
- Create: `infra/test/lambda/ingest.test.ts`

- [ ] **Step 1: Write tests for the ingest lambda**

`infra/test/lambda/ingest.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  CreateEventCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

import { handler } from '../../lambda/ingest/index';

function makeEvent(body: object): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/events',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    multiValueHeaders: {},
  };
}

describe('ingest lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    mockSend.mockResolvedValue({ event: { eventId: 'evt-1' } });
  });

  it('maps turns to CreateEvent payload', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-1',
        turns: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        context: {
          project: 'mnemo',
          workstation: 'laptop',
          workdir: '/home/user/mnemo',
          timestamp: '2026-04-10T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();

    const command = mockSend.mock.calls[0][0];
    expect(command.input.memoryId).toBe('mem-123');
    expect(command.input.actorId).toBe('tiago');
    expect(command.input.sessionId).toBe('session-1');
    expect(command.input.payload).toHaveLength(2);
    expect(command.input.payload[0].conversational.role).toBe('USER');
    expect(command.input.metadata.project.stringValue).toBe('mnemo');
  });

  it('handles missing optional project', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-2',
        turns: [{ role: 'user', content: 'test' }],
        context: {
          workstation: 'laptop',
          workdir: '/home/user',
          timestamp: '2026-04-10T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.metadata.project).toBeUndefined();
  });

  it('returns 400 on missing turns', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-3',
        context: {
          workstation: 'laptop',
          workdir: '/home',
          timestamp: '2026-04-10T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd infra && npx vitest run test/lambda/ingest.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the ingest lambda**

`infra/lambda/ingest/index.ts`:
```typescript
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { IngestRequest } from '../shared/types';

const client = new BedrockAgentCoreClient({});

const ROLE_MAP: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const body: IngestRequest = JSON.parse(event.body || '{}');

    if (!body.turns || body.turns.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'turns is required and must not be empty' }) };
    }
    if (!body.sessionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'sessionId is required' }) };
    }

    const payload = body.turns.map((turn) => ({
      conversational: {
        content: { text: turn.content },
        role: ROLE_MAP[turn.role] || 'OTHER',
      },
    }));

    const metadata: Record<string, { stringValue: string }> = {
      workstation: { stringValue: body.context.workstation },
      workdir: { stringValue: body.context.workdir },
    };
    if (body.context.project) {
      metadata.project = { stringValue: body.context.project };
    }

    await client.send(
      new CreateEventCommand({
        memoryId: process.env.MEMORY_ID!,
        actorId: process.env.ACTOR_ID!,
        sessionId: body.sessionId,
        eventTimestamp: new Date(body.context.timestamp),
        payload,
        metadata,
      })
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error('Ingest error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd infra && npx vitest run test/lambda/ingest.test.ts
```

Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/ingest/ infra/test/lambda/ingest.test.ts
git commit -m "feat: add ingest lambda for POST /events"
```

---

## Task 7: Recall Lambda

**Files:**
- Create: `infra/lambda/recall/index.ts`
- Create: `infra/test/lambda/recall.test.ts`

- [ ] **Step 1: Write tests for the recall lambda**

`infra/test/lambda/recall.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

import { handler } from '../../lambda/recall/index';

function makeEvent(queryParams: Record<string, string> | null): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/recall',
    pathParameters: null,
    queryStringParameters: queryParams,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    multiValueHeaders: {},
  };
}

const mockMemoryResponse = (records: Array<{ text: string; score: number }>) => ({
  memoryRecordSummaries: records.map((r, i) => ({
    memoryRecordId: `rec-${i}`,
    content: { text: r.text },
    score: r.score,
    createdAt: new Date().toISOString(),
    namespaces: [],
  })),
});

describe('recall lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    mockSend.mockResolvedValue(mockMemoryResponse([{ text: 'test fact', score: 0.9 }]));
  });

  it('queries 4 namespaces without project', async () => {
    const result = await handler(makeEvent(null));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(body.project).toBeUndefined();
    expect(body.preferences).toBeDefined();
    expect(body.facts).toBeDefined();
    expect(body.episodes).toBeDefined();
    expect(body.reflections).toBeDefined();
  });

  it('queries 5 namespaces with project', async () => {
    const result = await handler(makeEvent({ project: 'mnemo' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(5);
    expect(body.project).toBeDefined();
    expect(body.project.name).toBe('mnemo');
  });

  it('formats memory records in response', async () => {
    mockSend.mockResolvedValue(
      mockMemoryResponse([
        { text: 'prefers TypeScript', score: 0.95 },
        { text: 'uses vim', score: 0.8 },
      ])
    );

    const result = await handler(makeEvent(null));
    const body = JSON.parse(result.body);

    expect(body.preferences).toHaveLength(2);
    expect(body.preferences[0].content).toBe('prefers TypeScript');
    expect(body.preferences[0].score).toBe(0.95);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd infra && npx vitest run test/lambda/recall.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the recall lambda**

`infra/lambda/recall/index.ts`:
```typescript
import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { MemoryRecord, RecallResponse } from '../shared/types';

const client = new BedrockAgentCoreClient({});
const TOP_K = 5;

interface NamespaceQuery {
  key: keyof RecallResponse;
  namespace: string;
  searchQuery: string;
}

function buildQueries(actorId: string, project?: string): NamespaceQuery[] {
  const queries: NamespaceQuery[] = [
    {
      key: 'preferences',
      namespace: `/preferences/${actorId}/`,
      searchQuery: 'coding preferences, standards, style, and workflow habits',
    },
    {
      key: 'facts',
      namespace: `/facts/${actorId}/`,
      searchQuery: 'general knowledge, facts, and background information',
    },
    {
      key: 'episodes',
      namespace: `/episodes/${actorId}/`,
      searchQuery: 'recent work episodes, decisions, and context',
    },
    {
      key: 'reflections',
      namespace: `/reflections/${actorId}/`,
      searchQuery: 'insights, patterns, and cross-project observations',
    },
  ];

  if (project) {
    queries.push({
      key: 'project' as keyof RecallResponse,
      namespace: `/projects/${actorId}/${project}/`,
      searchQuery: `project decisions, architecture, and current state for ${project}`,
    });
  }

  return queries;
}

function toMemoryRecords(summaries: any[]): MemoryRecord[] {
  return (summaries || []).map((s: any) => ({
    id: s.memoryRecordId,
    content: s.content?.text || '',
    score: s.score || 0,
    createdAt: s.createdAt || '',
  }));
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const project = event.queryStringParameters?.project;
    const actorId = process.env.ACTOR_ID!;
    const memoryId = process.env.MEMORY_ID!;

    const queries = buildQueries(actorId, project);

    const results = await Promise.all(
      queries.map((q) =>
        client
          .send(
            new RetrieveMemoryRecordsCommand({
              memoryId,
              namespace: q.namespace,
              searchCriteria: {
                searchQuery: q.searchQuery,
                topK: TOP_K,
              },
            })
          )
          .then((r) => ({ key: q.key, records: toMemoryRecords(r.memoryRecordSummaries || []) }))
          .catch((err) => {
            console.warn(`Failed to query ${q.namespace}:`, err.message);
            return { key: q.key, records: [] };
          })
      )
    );

    const response: RecallResponse = {
      preferences: [],
      facts: [],
      episodes: [],
      reflections: [],
    };

    for (const result of results) {
      if (result.key === 'project' && project) {
        response.project = { name: project, memories: result.records };
      } else {
        (response as any)[result.key] = result.records;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify(response),
      headers: { 'Content-Type': 'application/json' },
    };
  } catch (err: any) {
    console.error('Recall error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd infra && npx vitest run test/lambda/recall.test.ts
```

Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/recall/ infra/test/lambda/recall.test.ts
git commit -m "feat: add recall lambda for GET /recall"
```

---

## Task 8: Project Extractor Lambda

**Files:**
- Create: `infra/lambda/project-extractor/index.ts`
- Create: `infra/test/lambda/project-extractor.test.ts`

- [ ] **Step 1: Write tests for the project extractor**

`infra/test/lambda/project-extractor.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

const mockAgentCoreSend = vi.fn();
const mockBedrockSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: mockAgentCoreSend })),
  BatchCreateMemoryRecordsCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

import { handler } from '../../lambda/project-extractor/index';

function makeSnsEvent(message: object): SNSEvent {
  return {
    Records: [
      {
        Sns: {
          Message: JSON.stringify(message),
          MessageId: 'msg-1',
          TopicArn: 'arn:aws:sns:us-east-1:123:topic',
          Timestamp: '2026-04-10T14:00:00Z',
          Subject: '',
          Type: 'Notification',
          SignatureVersion: '1',
          Signature: '',
          SigningCertUrl: '',
          UnsubscribeUrl: '',
          MessageAttributes: {},
        },
        EventSource: 'aws:sns',
        EventSubscriptionArn: '',
        EventVersion: '1.0',
      },
    ],
  };
}

describe('project-extractor lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    process.env.MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
  });

  it('extracts project context and writes memory records', async () => {
    const s3Payload = {
      events: [
        {
          payload: [
            { conversational: { content: { text: 'Use DynamoDB for storage' }, role: 'USER' } },
            { conversational: { content: { text: 'Good choice for single-table design' }, role: 'ASSISTANT' } },
          ],
          metadata: {
            project: { stringValue: 'mnemo' },
          },
        },
      ],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: 'text', text: 'Decision: Use DynamoDB single-table design for storage.' }],
        })
      ),
    });

    mockAgentCoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: 'rec-1', status: 'SUCCEEDED' }],
      failedRecords: [],
    });

    await handler(makeSnsEvent({ bucketName: 'payload-bucket', key: 'payloads/123.json' }));

    expect(mockS3Send).toHaveBeenCalledOnce();
    expect(mockBedrockSend).toHaveBeenCalledOnce();
    expect(mockAgentCoreSend).toHaveBeenCalledOnce();

    const batchCmd = mockAgentCoreSend.mock.calls[0][0];
    expect(batchCmd.input.records[0].namespaces).toContain('/projects/tiago/mnemo/');
  });

  it('skips when no project metadata in events', async () => {
    const s3Payload = {
      events: [
        {
          payload: [{ conversational: { content: { text: 'hello' }, role: 'USER' } }],
          metadata: {},
        },
      ],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    await handler(makeSnsEvent({ bucketName: 'bucket', key: 'key.json' }));

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd infra && npx vitest run test/lambda/project-extractor.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the project extractor lambda**

`infra/lambda/project-extractor/index.ts`:
```typescript
import {
  BedrockAgentCoreClient,
  BatchCreateMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { SNSEvent } from 'aws-lambda';

const agentcore = new BedrockAgentCoreClient({});
const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

const EXTRACTION_PROMPT = `You are analyzing a conversation between a developer and an AI coding assistant.
Extract project-specific information only:
- Architecture decisions and rationale
- Technology choices
- Design patterns adopted
- Current project state and progress
- Open questions or pending decisions

Be concise. Output only the extracted facts, one per line. If there is nothing project-specific, output "NONE".`;

export async function handler(event: SNSEvent): Promise<void> {
  const message = JSON.parse(event.Records[0].Sns.Message);

  const s3Response = await s3.send(
    new GetObjectCommand({
      Bucket: message.bucketName,
      Key: message.key,
    })
  );
  const payload = JSON.parse(await s3Response.Body!.transformToString());

  const projectName = findProjectName(payload);
  if (!projectName) return;

  const conversationText = extractConversationText(payload);
  if (!conversationText) return;

  const extraction = await extractProjectContext(projectName, conversationText);
  if (!extraction || extraction === 'NONE') return;

  const actorId = process.env.ACTOR_ID!;
  const memoryId = process.env.MEMORY_ID!;

  await agentcore.send(
    new BatchCreateMemoryRecordsCommand({
      memoryId,
      records: [
        {
          requestIdentifier: `project-${Date.now()}`,
          namespaces: [`/projects/${actorId}/${projectName}/`],
          content: { text: extraction },
          timestamp: new Date(),
        },
      ],
    })
  );
}

function findProjectName(payload: any): string | undefined {
  for (const event of payload.events || []) {
    const project = event.metadata?.project?.stringValue;
    if (project) return project;
  }
  return undefined;
}

function extractConversationText(payload: any): string {
  const lines: string[] = [];
  for (const event of payload.events || []) {
    for (const item of event.payload || []) {
      if (item.conversational) {
        const role = item.conversational.role || 'UNKNOWN';
        const text = item.conversational.content?.text || '';
        lines.push(`${role}: ${text}`);
      }
    }
  }
  return lines.join('\n');
}

async function extractProjectContext(projectName: string, conversation: string): Promise<string> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\nProject: ${projectName}\n\nConversation:\n${conversation}`,
          },
        ],
      }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content?.[0]?.text || '';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd infra && npx vitest run test/lambda/project-extractor.test.ts
```

Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/project-extractor/ infra/test/lambda/project-extractor.test.ts
git commit -m "feat: add project extractor lambda for self-managed strategy"
```

---

## Task 9: API + Lambda CDK Constructs

**Files:**
- Create: `infra/lib/api-construct.ts`
- Create: `infra/lib/lambda-construct.ts`
- Create: `infra/test/api-construct.test.ts`
- Create: `infra/test/lambda-construct.test.ts`

- [ ] **Step 1: Write CDK assertion tests**

`infra/test/api-construct.test.ts`:
```typescript
import { describe, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiConstruct } from '../lib/api-construct';

describe('ApiConstruct', () => {
  it('creates API Gateway with API key and two routes', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const dummyFn = new lambda.Function(stack, 'DummyIngest', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = () => {}'),
    });
    const dummyRecall = new lambda.Function(stack, 'DummyRecall', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = () => {}'),
    });

    new ApiConstruct(stack, 'Api', {
      ingestFunction: dummyFn,
      recallFunction: dummyRecall,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
    });
  });
});
```

`infra/test/lambda-construct.test.ts`:
```typescript
import { describe, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import { LambdaConstruct } from '../lib/lambda-construct';

describe('LambdaConstruct', () => {
  it('creates three lambda functions', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    const topic = new sns.Topic(stack, 'Topic');
    const bucket = new s3.Bucket(stack, 'Bucket');

    new LambdaConstruct(stack, 'Lambdas', {
      memoryId: 'mem-123',
      actorId: 'tiago',
      snsTopic: topic,
      payloadBucket: bucket,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd infra && npx vitest run test/api-construct.test.ts test/lambda-construct.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement LambdaConstruct**

`infra/lib/lambda-construct.ts`:
```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdaConstructProps {
  memoryId: string;
  actorId: string;
  snsTopic: sns.ITopic;
  payloadBucket: s3.IBucket;
  modelId?: string;
}

export class LambdaConstruct extends Construct {
  public readonly ingestFunction: lambda.IFunction;
  public readonly recallFunction: lambda.IFunction;
  public readonly projectExtractorFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: LambdaConstructProps) {
    super(scope, id);

    const lambdaDir = path.join(__dirname, '..', 'lambda');

    const commonEnv = {
      MEMORY_ID: props.memoryId,
      ACTOR_ID: props.actorId,
    };

    const agentcorePolicy = new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:RetrieveMemoryRecords',
        'bedrock-agentcore:BatchCreateMemoryRecords',
      ],
      resources: ['*'],
    });

    this.ingestFunction = new NodejsFunction(this, 'IngestFn', {
      entry: path.join(lambdaDir, 'ingest', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      bundling: { externalModules: [] },
    });
    (this.ingestFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);

    this.recallFunction = new NodejsFunction(this, 'RecallFn', {
      entry: path.join(lambdaDir, 'recall', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      bundling: { externalModules: [] },
    });
    (this.recallFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);

    this.projectExtractorFunction = new NodejsFunction(this, 'ProjectExtractorFn', {
      entry: path.join(lambdaDir, 'project-extractor', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      environment: {
        ...commonEnv,
        MODEL_ID: props.modelId || 'anthropic.claude-3-haiku-20240307-v1:0',
      },
      bundling: { externalModules: [] },
    });
    (this.projectExtractorFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);
    this.projectExtractorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      })
    );

    props.payloadBucket.grantRead(this.projectExtractorFunction);
    props.snsTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(this.projectExtractorFunction)
    );
  }
}
```

- [ ] **Step 4: Implement ApiConstruct**

`infra/lib/api-construct.ts`:
```typescript
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ApiConstructProps {
  ingestFunction: lambda.IFunction;
  recallFunction: lambda.IFunction;
}

export class ApiConstruct extends Construct {
  public readonly api: apigw.RestApi;
  public readonly apiKey: apigw.IApiKey;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    this.api = new apigw.RestApi(this, 'MnemoApi', {
      restApiName: 'mnemo-api',
      deployOptions: {
        stageName: 'v1',
      },
    });

    const events = this.api.root.addResource('events');
    events.addMethod('POST', new apigw.LambdaIntegration(props.ingestFunction), {
      apiKeyRequired: true,
    });

    const recall = this.api.root.addResource('recall');
    recall.addMethod('GET', new apigw.LambdaIntegration(props.recallFunction), {
      apiKeyRequired: true,
    });

    this.apiKey = this.api.addApiKey('MnemoApiKey', {
      apiKeyName: 'mnemo-key',
    });

    const usagePlan = this.api.addUsagePlan('MnemoUsagePlan', {
      name: 'mnemo-usage-plan',
      throttle: {
        rateLimit: 10,
        burstLimit: 20,
      },
    });

    usagePlan.addApiKey(this.apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    this.apiUrl = this.api.url;

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: this.apiKey.keyId });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd infra && npx vitest run test/api-construct.test.ts test/lambda-construct.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/api-construct.ts infra/lib/lambda-construct.ts infra/test/api-construct.test.ts infra/test/lambda-construct.test.ts
git commit -m "feat: add API Gateway and Lambda CDK constructs"
```

---

## Task 10: Main Stack Assembly

**Files:**
- Modify: `infra/lib/mnemo-stack.ts`
- Modify: `infra/test/mnemo-stack.test.ts`

- [ ] **Step 1: Update the stack test**

`infra/test/mnemo-stack.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MnemoStack } from '../lib/mnemo-stack';

describe('MnemoStack', () => {
  it('synthesizes full stack with all resources', () => {
    const app = new cdk.App();
    const stack = new MnemoStack(app, 'TestStack', {
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
    // 3 app lambdas + 1 memory provider = 4 with nodejs22.x
    // CDK also creates framework and auto-delete-objects lambdas
    template.resourcePropertiesCountIs('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    }, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd infra && npx vitest run test/mnemo-stack.test.ts
```

Expected: FAIL — stack is still empty.

- [ ] **Step 3: Wire all constructs in the main stack**

`infra/lib/mnemo-stack.ts`:
```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MemoryConstruct } from './memory-construct';
import { LambdaConstruct } from './lambda-construct';
import { ApiConstruct } from './api-construct';

export interface MnemoStackProps extends cdk.StackProps {
  actorId: string;
  modelId?: string;
}

export class MnemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MnemoStackProps) {
    super(scope, id, props);

    const memory = new MemoryConstruct(this, 'Memory', {
      memoryName: 'mnemo-memory',
      actorId: props.actorId,
    });

    const lambdas = new LambdaConstruct(this, 'Lambdas', {
      memoryId: memory.memoryId,
      actorId: props.actorId,
      snsTopic: memory.snsTopic,
      payloadBucket: memory.payloadBucket,
      modelId: props.modelId,
    });

    new ApiConstruct(this, 'Api', {
      ingestFunction: lambdas.ingestFunction,
      recallFunction: lambdas.recallFunction,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd infra && npx vitest run test/mnemo-stack.test.ts
```

Expected: PASS. The Lambda count assertion may need adjustment based on CDK-generated functions. Adjust after running.

- [ ] **Step 5: Run full CDK synth to verify**

```bash
cd infra && npx cdk synth --no-staging 2>&1 | head -20
```

Expected: CloudFormation template output without errors.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/mnemo-stack.ts infra/test/mnemo-stack.test.ts
git commit -m "feat: wire all constructs in main stack"
```

---

## Task 11: CLI Project Setup

**Files:**
- Create: `cli/package.json`
- Create: `cli/tsconfig.json`
- Create: `cli/vitest.config.ts`

- [ ] **Step 1: Create cli/package.json**

```json
{
  "name": "mnemo-cli",
  "version": "0.1.0",
  "description": "mnemo CLI - centralized AI memory client",
  "bin": {
    "mnemo": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "commander": "^13.0.0"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create cli/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create cli/vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 4: Install dependencies**

```bash
cd cli && npm install
```

- [ ] **Step 5: Commit**

```bash
git add cli/package.json cli/tsconfig.json cli/vitest.config.ts
git commit -m "feat: initialize CLI project"
```

---

## Task 12: CLI Config Loader + Project Detection

**Files:**
- Create: `cli/src/config.ts`
- Create: `cli/src/detect-project.ts`
- Create: `cli/test/config.test.ts`
- Create: `cli/test/detect-project.test.ts`

- [ ] **Step 1: Write tests for config loader**

`cli/test/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, type MnemoConfig } from '../src/config';

describe('config loader', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-test-' + Date.now());
  const configPath = path.join(tmpDir, '.mnemo', 'config.json');

  beforeEach(() => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config from file', () => {
    const config: MnemoConfig = {
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      workstation: 'my-laptop',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.apiUrl).toBe('https://api.example.com/v1');
    expect(loaded.apiKey).toBe('test-key');
    expect(loaded.workstation).toBe('my-laptop');
  });

  it('uses hostname when workstation not set', () => {
    const config = {
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.workstation).toBe(os.hostname());
  });

  it('throws when config file not found', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow();
  });
});
```

- [ ] **Step 2: Write tests for project detection**

`cli/test/detect-project.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { detectProject } from '../src/detect-project';
import * as childProcess from 'child_process';

vi.mock('child_process');

describe('detectProject', () => {
  it('returns folder name when in a git repo', () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      Buffer.from('/Users/tiago/src/github.com/tiagodeoliveira/mnemo\n')
    );

    const result = detectProject('/Users/tiago/src/github.com/tiagodeoliveira/mnemo/src');
    expect(result).toBe('mnemo');
  });

  it('returns undefined when not in a git repo', () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = detectProject('/tmp/random-dir');
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd cli && npx vitest run
```

Expected: FAIL.

- [ ] **Step 4: Implement config loader**

`cli/src/config.ts`:
```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MnemoConfig {
  apiUrl: string;
  apiKey: string;
  workstation: string;
  defaults: {
    visible: boolean;
  };
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.mnemo', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): MnemoConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run 'mnemo init' to create one.`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  return {
    apiUrl: raw.apiUrl,
    apiKey: raw.apiKey,
    workstation: raw.workstation || os.hostname(),
    defaults: {
      visible: raw.defaults?.visible ?? true,
    },
  };
}
```

- [ ] **Step 5: Implement project detection**

`cli/src/detect-project.ts`:
```typescript
import { execFileSync } from 'child_process';
import * as path from 'path';

export function detectProject(cwd: string = process.cwd()): string | undefined {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return path.basename(gitRoot);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd cli && npx vitest run
```

Expected: PASS — all tests.

- [ ] **Step 7: Commit**

```bash
git add cli/src/config.ts cli/src/detect-project.ts cli/test/
git commit -m "feat: add CLI config loader and project detection"
```

---

## Task 13: CLI Push Command

**Files:**
- Create: `cli/src/commands/push.ts`
- Create: `cli/test/push.test.ts`

- [ ] **Step 1: Write tests for push command**

`cli/test/push.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { executePush } from '../src/commands/push';

describe('push command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  it('sends turns to /events endpoint', async () => {
    await executePush({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      sessionId: 'session-1',
      turns: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      project: 'mnemo',
      workstation: 'laptop',
      workdir: '/home/user/mnemo',
    });

    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/events');
    expect(options.method).toBe('POST');
    expect(options.headers['x-api-key']).toBe('test-key');

    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe('session-1');
    expect(body.turns).toHaveLength(2);
    expect(body.context.project).toBe('mnemo');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(
      executePush({
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        sessionId: 's1',
        turns: [{ role: 'user', content: 'test' }],
        workstation: 'laptop',
        workdir: '/tmp',
      })
    ).rejects.toThrow('500');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cli && npx vitest run test/push.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement push command**

`cli/src/commands/push.ts`:
```typescript
export interface PushOptions {
  apiUrl: string;
  apiKey: string;
  sessionId: string;
  turns: Array<{ role: string; content: string }>;
  project?: string;
  workstation: string;
  workdir: string;
}

export async function executePush(options: PushOptions): Promise<void> {
  const response = await fetch(`${options.apiUrl}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify({
      sessionId: options.sessionId,
      turns: options.turns,
      context: {
        project: options.project,
        workstation: options.workstation,
        workdir: options.workdir,
        timestamp: new Date().toISOString(),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push failed (${response.status}): ${text}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cli && npx vitest run test/push.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/push.ts cli/test/push.test.ts
git commit -m "feat: add CLI push command"
```

---

## Task 14: CLI Recall Command

**Files:**
- Create: `cli/src/commands/recall.ts`
- Create: `cli/test/recall.test.ts`

- [ ] **Step 1: Write tests for recall command**

`cli/test/recall.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { executeRecall, formatRecallOutput } from '../src/commands/recall';

const sampleResponse = {
  preferences: [
    { id: 'r1', content: 'Prefers TypeScript and functional style', score: 0.95, createdAt: '' },
  ],
  facts: [
    { id: 'r2', content: 'Senior engineer working on distributed systems', score: 0.9, createdAt: '' },
  ],
  episodes: [],
  reflections: [],
  project: {
    name: 'mnemo',
    memories: [
      { id: 'r3', content: 'Chose CDK over SAM for infrastructure', score: 0.85, createdAt: '' },
    ],
  },
};

describe('recall command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
  });

  it('calls /recall with project param', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      project: 'mnemo',
      workstation: 'laptop',
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/recall?project=mnemo&workstation=laptop');
    expect(options.headers['x-api-key']).toBe('test-key');
  });

  it('omits project param when not provided', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      workstation: 'laptop',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/recall?workstation=laptop');
  });
});

describe('formatRecallOutput', () => {
  it('formats response for visible mode', () => {
    const output = formatRecallOutput(sampleResponse, true);
    expect(output).toContain('Prefers TypeScript');
    expect(output).toContain('Senior engineer');
    expect(output).toContain('mnemo');
    expect(output).toContain('Chose CDK over SAM');
  });

  it('formats response for silent mode as JSON system message', () => {
    const output = formatRecallOutput(sampleResponse, false);
    const parsed = JSON.parse(output);
    expect(parsed.systemMessage).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cli && npx vitest run test/recall.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement recall command**

`cli/src/commands/recall.ts`:
```typescript
export interface RecallOptions {
  apiUrl: string;
  apiKey: string;
  project?: string;
  workstation: string;
}

interface MemoryRecord {
  id: string;
  content: string;
  score: number;
  createdAt: string;
}

interface RecallResponse {
  preferences: MemoryRecord[];
  facts: MemoryRecord[];
  episodes: MemoryRecord[];
  reflections: MemoryRecord[];
  project?: {
    name: string;
    memories: MemoryRecord[];
  };
}

export async function executeRecall(options: RecallOptions): Promise<RecallResponse> {
  const params = new URLSearchParams();
  if (options.project) params.set('project', options.project);
  params.set('workstation', options.workstation);

  const url = `${options.apiUrl}/recall?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'x-api-key': options.apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Recall failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<RecallResponse>;
}

function formatSection(title: string, records: MemoryRecord[]): string {
  if (records.length === 0) return '';
  const items = records.map((r) => `- ${r.content}`).join('\n');
  return `## ${title}\n${items}\n`;
}

export function formatRecallOutput(response: RecallResponse, visible: boolean): string {
  const sections: string[] = [];

  sections.push(formatSection('Preferences', response.preferences));
  sections.push(formatSection('Facts', response.facts));
  sections.push(formatSection('Episodes', response.episodes));
  sections.push(formatSection('Reflections', response.reflections));

  if (response.project) {
    sections.push(formatSection(`Project: ${response.project.name}`, response.project.memories));
  }

  const content = sections.filter(Boolean).join('\n');

  if (!content) return '';

  if (visible) {
    return `# mnemo — recalled memories\n\n${content}`;
  }

  return JSON.stringify({
    continue: true,
    suppressOutput: true,
    systemMessage: `[mnemo context]\n${content}`,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cli && npx vitest run test/recall.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/recall.ts cli/test/recall.test.ts
git commit -m "feat: add CLI recall command with output formatting"
```

---

## Task 15: CLI Entry Point + Build

**Files:**
- Create: `cli/src/index.ts`

- [ ] **Step 1: Implement CLI entry point**

`cli/src/index.ts`:
```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { executePush } from './commands/push';
import { executeRecall, formatRecallOutput } from './commands/recall';
import { detectProject } from './detect-project';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const program = new Command();

program
  .name('mnemo')
  .description('Centralized AI memory client')
  .version('0.1.0');

program
  .command('push')
  .description('Push conversation turns to memory')
  .requiredOption('--session <id>', 'Session ID')
  .requiredOption('--turns <json>', 'JSON array of conversation turns')
  .option('--project <name>', 'Project name (auto-detected from git)')
  .option('--workdir <path>', 'Working directory', process.cwd())
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const turns = JSON.parse(opts.turns);
      const project = opts.project || detectProject(opts.workdir);

      await executePush({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        sessionId: opts.session,
        turns,
        project,
        workstation: config.workstation,
        workdir: opts.workdir,
      });
    } catch (err: any) {
      process.stderr.write(`mnemo push error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('recall')
  .description('Recall memories for current context')
  .option('--project <name>', 'Project name (auto-detected from git)')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const project = opts.project || detectProject();

      const response = await executeRecall({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        project,
        workstation: config.workstation,
      });

      const output = formatRecallOutput(response, config.defaults.visible);
      if (output) process.stdout.write(output + '\n');
    } catch (err: any) {
      process.stderr.write(`mnemo recall error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Create default config file')
  .action(() => {
    const configDir = path.join(os.homedir(), '.mnemo');
    const configPath = path.join(configDir, 'config.json');

    if (fs.existsSync(configPath)) {
      console.log(`Config already exists at ${configPath}`);
      return;
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          apiUrl: 'https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/v1',
          apiKey: 'YOUR_API_KEY',
          workstation: os.hostname(),
          defaults: { visible: true },
        },
        null,
        2
      )
    );
    console.log(`Config created at ${configPath} — edit it with your API details.`);
  });

program.parse();
```

- [ ] **Step 2: Build and verify**

```bash
cd cli && npx tsc && node dist/index.js --help
```

Expected: Help output showing `push`, `recall`, and `init` commands.

- [ ] **Step 3: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat: add CLI entry point with push, recall, and init commands"
```

---

## Task 16: Claude Code Hook Scripts

**Files:**
- Create: `hooks/session-start.sh`
- Create: `hooks/prompt-submit.sh`
- Create: `hooks/settings.example.json`

- [ ] **Step 1: Create session start hook**

`hooks/session-start.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# mnemo session start hook
# Reads hook input from stdin, detects project, recalls memories

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

# Detect project from git repo
PROJECT=""
if git -C "$CWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  PROJECT=$(basename "$(git -C "$CWD" rev-parse --show-toplevel)")
fi

# Build recall command
RECALL_ARGS=""
if [ -n "$PROJECT" ]; then
  RECALL_ARGS="--project $PROJECT"
fi

# Execute recall and output to stdout (exit 0 = shown in transcript)
mnemo recall $RECALL_ARGS 2>/dev/null || true
```

- [ ] **Step 2: Create prompt submit hook for push batching**

`hooks/prompt-submit.sh`:
```bash
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
```

- [ ] **Step 3: Create example settings.json**

`hooks/settings.example.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/mnemo/hooks/session-start.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/mnemo/hooks/prompt-submit.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Make hook scripts executable**

```bash
chmod +x hooks/session-start.sh hooks/prompt-submit.sh
```

- [ ] **Step 5: Commit**

```bash
git add hooks/
git commit -m "feat: add Claude Code hook scripts for session start and push"
```

---

## Task 17: First Deploy + Smoke Test

**Prerequisites:** AWS credentials configured, CDK bootstrapped in target account/region.

- [ ] **Step 1: Install all workspace dependencies**

```bash
cd /path/to/mnemo && npm install
```

- [ ] **Step 2: Run all tests**

```bash
cd infra && npx vitest run && cd ../cli && npx vitest run
```

Expected: All tests passing.

- [ ] **Step 3: Deploy the stack**

```bash
cd infra && npx cdk deploy --context actorId=tiago
```

Expected: Stack deploys successfully. Note the API URL and API Key ID from the outputs.

- [ ] **Step 4: Retrieve the API key value**

```bash
aws apigateway get-api-key --api-key <API_KEY_ID> --include-value --query 'value' --output text
```

- [ ] **Step 5: Initialize mnemo CLI config**

```bash
cd cli && npx tsc && node dist/index.js init
```

Then edit `~/.mnemo/config.json` with the API URL and API key from the deploy outputs.

- [ ] **Step 6: Smoke test — push an event**

```bash
mnemo push \
  --session "smoke-test-$(date +%s)" \
  --turns '[{"role":"user","content":"testing mnemo"},{"role":"assistant","content":"mnemo is working"}]' \
  --project mnemo \
  --workdir "$(pwd)"
```

Expected: No error output.

- [ ] **Step 7: Smoke test — recall memories**

Note: Long-term memory extraction is asynchronous. Wait 60-90 seconds after push before testing recall.

```bash
mnemo recall --project mnemo
```

Expected: Output showing recalled memories (may be empty initially if strategies haven't processed yet — that's OK for the first run).

- [ ] **Step 8: Commit any adjustments**

```bash
git add -A && git commit -m "feat: deployment adjustments from smoke test"
```

- [ ] **Step 9: Force push to rewrite remote history**

This is the first real commit going to the remote, replacing the old repo content:

```bash
git push origin main --force
```
