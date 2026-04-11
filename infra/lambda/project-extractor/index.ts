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

First, identify the project name being discussed. Look for repository names, package names, or how the developer refers to the project.

Then extract project-specific information only:
- Architecture decisions and rationale
- Technology choices
- Design patterns adopted
- Current project state and progress
- Open questions or pending decisions

Respond in this exact format:
PROJECT: <project_name>
FACTS:
<one fact per line>

If you cannot identify a project name, use "unknown".
If there is nothing project-specific to extract, output:
PROJECT: <project_name>
FACTS: NONE`;

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const withoutProtocol = uri.replace('s3://', '');
  const slashIndex = withoutProtocol.indexOf('/');
  return {
    bucket: withoutProtocol.slice(0, slashIndex),
    key: withoutProtocol.slice(slashIndex + 1),
  };
}

export async function handler(event: SNSEvent): Promise<void> {
  const message = JSON.parse(event.Records[0].Sns.Message);

  const { bucket, key } = parseS3Uri(message.s3PayloadLocation);
  const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const payload = JSON.parse(await s3Response.Body!.transformToString());

  const conversationText = extractConversationText(payload);
  if (!conversationText) return;

  const result = await extractProjectContext(conversationText);
  if (!result) return;

  const { projectName, facts } = result;
  if (facts === 'NONE' || !facts.trim()) return;

  const actorId = payload.actorId || process.env.ACTOR_ID!;
  const memoryId = payload.memoryId || process.env.MEMORY_ID!;

  await agentcore.send(
    new BatchCreateMemoryRecordsCommand({
      memoryId,
      records: [
        {
          requestIdentifier: `project-${Date.now()}`,
          namespaces: [`/projects/${actorId}/${projectName}/`],
          content: { text: facts },
          timestamp: new Date(),
        },
      ],
    })
  );

  console.log(`Extracted project context for "${projectName}" from session ${payload.sessionId}`);
}

function extractConversationText(payload: any): string {
  const lines: string[] = [];
  for (const entry of payload.currentContext || []) {
    const role = entry.role || 'UNKNOWN';
    const text = entry.content?.text || '';
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n');
}

function parseExtraction(text: string): { projectName: string; facts: string } | undefined {
  const projectMatch = text.match(/^PROJECT:\s*(.+)$/m);
  const factsMatch = text.match(/^FACTS:\s*\n?([\s\S]*)$/m);

  if (!projectMatch) return undefined;

  return {
    projectName: projectMatch[1].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_'),
    facts: factsMatch ? factsMatch[1].trim() : '',
  };
}

async function extractProjectContext(
  conversation: string
): Promise<{ projectName: string; facts: string } | undefined> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\nConversation:\n${conversation}`,
          },
        ],
      }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.content?.[0]?.text || '';
  return parseExtraction(text);
}
