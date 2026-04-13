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

const DEFAULT_TASK_DOMAINS = 'coding,studying,meeting,general';

function getTaskDomains(): string[] {
  const raw = process.env.TASK_DOMAINS || DEFAULT_TASK_DOMAINS;
  const domains = raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.includes('general')) domains.push('general');
  return domains;
}

function buildExtractionPrompt(domains: string[], metadata: Metadata): string {
  const domainList = domains.map((d) => `   - ${d}`).join('\n');
  const metaLines: string[] = [];
  if (metadata.project) metaLines.push(`- Project: ${metadata.project}`);
  if (metadata.source) metaLines.push(`- Source: ${metadata.source}`);
  if (metadata.date) metaLines.push(`- Date: ${metadata.date}`);

  const metaSection = metaLines.length > 0
    ? `\nKnown context:\n${metaLines.join('\n')}\n`
    : '';

  return `You are analyzing a conversation between a user and an AI assistant.
${metaSection}
Perform two analyses:

1. CLASSIFY THE TASK DOMAIN: Categorize the conversation into exactly one of these domains based on the primary topic:
${domainList}
   You MUST pick exactly one domain from the list above. If the conversation doesn't clearly fit any specific domain, use "general".
   If the conversation is too short or vague to classify, output "unknown".

2. EXTRACT INSIGHTS: Pull out domain-specific facts, decisions, and context worth remembering.

3. WRITE A DAILY SUMMARY: A 1-3 sentence summary of what happened in this conversation, suitable for a daily activity log.

Respond in this exact format:
TASK: <task_domain>
FACTS:
<one fact per line, or NONE if nothing meaningful>
DAILY:
<1-3 sentence summary, or NONE if nothing meaningful>`;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const withoutProtocol = uri.replace('s3://', '');
  const slashIndex = withoutProtocol.indexOf('/');
  return {
    bucket: withoutProtocol.slice(0, slashIndex),
    key: withoutProtocol.slice(slashIndex + 1),
  };
}

function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
}

interface Metadata {
  project?: string;
  source?: string;
  workstation?: string;
  date?: string;
}

interface ExtractionResult {
  taskDomain: string;
  facts: string;
  daily: string;
}

/**
 * Parse [mnemo-context: key=value, ...] from conversation turns.
 * The ingest Lambda prepends this as an OTHER role turn.
 */
function parseMetadata(payload: any): Metadata {
  const meta: Metadata = {};
  for (const entry of payload.currentContext || []) {
    const text = entry.content?.text || '';
    const match = text.match(/^\[mnemo-context:\s*(.+)\]$/);
    if (match) {
      for (const pair of match[1].split(',')) {
        const [k, ...vParts] = pair.split('=');
        const key = k.trim();
        const value = vParts.join('=').trim();
        if (key === 'project' && value) meta.project = value;
        if (key === 'source' && value) meta.source = value;
        if (key === 'workstation' && value) meta.workstation = value;
        if (key === 'date' && value) meta.date = value;
      }
      break; // Only one context turn expected
    }
  }
  return meta;
}

function extractConversationText(payload: any): string {
  const lines: string[] = [];
  for (const entry of payload.currentContext || []) {
    const role = entry.role || 'UNKNOWN';
    const text = entry.content?.text || '';
    // Skip the metadata context turn — it's for programmatic use
    if (text.startsWith('[mnemo-context:')) continue;
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n');
}

function parseExtraction(text: string, allowedDomains: string[]): ExtractionResult | undefined {
  const taskMatch = text.match(/^TASK:\s*(.+)$/m);
  const factsMatch = text.match(/^FACTS:\s*\n?([\s\S]*?)(?=^DAILY:)/m);
  const dailyMatch = text.match(/^DAILY:\s*\n?([\s\S]*)$/m);

  if (!taskMatch) return undefined;

  let taskDomain = sanitizeName(taskMatch[1]);
  if (taskDomain !== 'unknown' && !allowedDomains.includes(taskDomain)) {
    console.warn(`LLM returned task domain "${taskDomain}" not in allowed list [${allowedDomains}], falling back to "general"`);
    taskDomain = 'general';
  }

  return {
    taskDomain,
    facts: factsMatch ? factsMatch[1].trim() : '',
    daily: dailyMatch ? dailyMatch[1].trim() : '',
  };
}

async function writeMemoryRecord(
  memoryId: string,
  namespace: string,
  content: string
): Promise<void> {
  await agentcore.send(
    new BatchCreateMemoryRecordsCommand({
      memoryId,
      records: [
        {
          requestIdentifier: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          namespaces: [namespace],
          content: { text: content },
          timestamp: new Date(),
        },
      ],
    })
  );
}

export async function handler(event: SNSEvent): Promise<void> {
  let sessionId: string | undefined;
  try {
    const message = JSON.parse(event.Records[0].Sns.Message);

    const { bucket, key } = parseS3Uri(message.s3PayloadLocation);
    const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const payload = JSON.parse(await s3Response.Body!.transformToString());

    sessionId = payload.sessionId;

    const metadata = parseMetadata(payload);

    const conversationText = extractConversationText(payload);
    if (!conversationText) return;

    const allowedDomains = getTaskDomains();
    const result = await callLlm(conversationText, allowedDomains, metadata);
    if (!result) {
      console.warn(`Failed to parse LLM extraction for session ${sessionId}`);
      return;
    }

    const { taskDomain, facts, daily } = result;
    const actorId = payload.actorId || process.env.ACTOR_ID!;
    const memoryId = payload.memoryId || process.env.MEMORY_ID!;

    const date = metadata.date || deriveDate(payload);
    const projectName = metadata.project ? sanitizeName(metadata.project) : undefined;

    const isNone = (s: string) => !s || s === 'NONE';
    const hasProject = !!projectName && !isNone(facts);
    const hasTask = taskDomain !== 'unknown' && !isNone(facts);
    const hasDaily = !isNone(daily);

    if (!hasProject && !hasTask && !hasDaily) return;

    const writes: Promise<void>[] = [];

    if (hasProject) {
      writes.push(
        writeMemoryRecord(memoryId, `/projects/${actorId}/${projectName}/`, facts)
      );
    }

    if (hasTask) {
      writes.push(
        writeMemoryRecord(memoryId, `/tasks/${actorId}/${taskDomain}/`, facts)
      );
    }

    if (hasDaily) {
      writes.push(
        writeMemoryRecord(memoryId, `/daily/${actorId}/${date}/`, daily)
      );
    }

    await Promise.all(writes);

    const parts = [
      hasProject ? `project="${projectName}"` : null,
      hasTask ? `task="${taskDomain}"` : null,
      hasDaily ? `daily="${date}"` : null,
      metadata.source ? `source="${metadata.source}"` : null,
    ].filter(Boolean).join(', ');
    console.log(`Extracted context (${parts}) from session ${payload.sessionId}`);
  } catch (err: any) {
    console.error('Context extraction failed', {
      error: err.message,
      name: err.name,
      sessionId,
    });

    // Rethrow transient errors so SNS retries
    if (err.name === 'ThrottlingException' || err.name === 'ServiceUnavailableException') {
      throw err;
    }
    // Swallow permanent errors to avoid infinite retry loops
  }
}

function deriveDate(payload: any): string {
  const ts = payload.startingTimestamp || payload.endingTimestamp || Date.now();
  return new Date(ts).toISOString().slice(0, 10);
}

async function callLlm(conversation: string, allowedDomains: string[], metadata: Metadata): Promise<ExtractionResult | undefined> {
  const prompt = buildExtractionPrompt(allowedDomains, metadata);
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.MODEL_ID || 'us.anthropic.claude-sonnet-4-6',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nConversation:\n${conversation}`,
          },
        ],
      }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.content?.[0]?.text || '';
  return parseExtraction(text, allowedDomains);
}
