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

const CREATE_RETRIES = 3;
const CREATE_RETRY_DELAY_MS = 15_000;

async function onCreate(event: CloudFormationCustomResourceEvent): Promise<ProviderResponse> {
  const props = event.ResourceProperties;

  // IAM role policies need time to propagate before AgentCore can validate them
  let lastError: any;
  for (let attempt = 0; attempt < CREATE_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`Retry ${attempt}/${CREATE_RETRIES} after IAM propagation delay...`);
      await new Promise((r) => setTimeout(r, CREATE_RETRY_DELAY_MS));
    }
    try {
      return await createMemory(props);
    } catch (err: any) {
      lastError = err;
      if (err.name === 'ValidationException' && err.message?.includes('Role does not have access')) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function createMemory(props: any): Promise<ProviderResponse> {
  const response = await client.send(
    new CreateMemoryCommand({
      name: props.memoryName,
      description: props.description,
      memoryExecutionRoleArn: props.memoryExecutionRoleArn,
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
              namespaceTemplates: ['/episodes/{actorId}/'],
            },
          },
        },
        {
          customMemoryStrategy: {
            name: 'ProjectContext',
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
