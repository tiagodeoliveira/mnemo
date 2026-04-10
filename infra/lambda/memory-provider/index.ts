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
