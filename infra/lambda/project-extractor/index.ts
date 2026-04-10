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
