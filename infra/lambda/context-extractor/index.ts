import {
  BedrockAgentCoreClient,
  BatchCreateMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
  BatchDeleteMemoryRecordsCommand,
  type MemoryRecordSummary,
} from '@aws-sdk/client-bedrock-agentcore';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { SNSEvent } from 'aws-lambda';
import { sanitizeName } from '../shared/util';

class ConsolidationTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsolidationTruncatedError';
  }
}

if (!process.env.MEMORY_ID || !process.env.ACTOR_ID) {
  throw new Error('Missing required env vars: MEMORY_ID, ACTOR_ID');
}

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

const MAX_META_LENGTH = 128;

function sanitizeMetaValue(value: string): string {
  return value.replace(/[\n\r]/g, ' ').slice(0, MAX_META_LENGTH);
}

function buildExtractionPrompt(domains: string[], metadata: Metadata): string {
  const domainList = domains.map((d) => `   - ${d}`).join('\n');
  const metaLines: string[] = [];
  if (metadata.project) metaLines.push(`- Project: ${sanitizeMetaValue(metadata.project)}`);
  if (metadata.source) metaLines.push(`- Source: ${sanitizeMetaValue(metadata.source)}`);
  if (metadata.date) metaLines.push(`- Date: ${sanitizeMetaValue(metadata.date)}`);

  const metaSection = metaLines.length > 0
    ? `\nKnown context:\n${metaLines.join('\n')}\n`
    : '';

  return `You are analyzing a conversation to extract durable knowledge — things a future session would benefit from knowing.
${metaSection}
1. CLASSIFY THE TASK DOMAIN: Pick exactly one:
${domainList}
   If unclear, use "general". If too short to classify, output "unknown".

2. EXTRACT KEY INSIGHTS: Distill the conversation into facts that will still be relevant weeks from now. Focus on the "why" behind decisions, not the "what" of implementation steps. A good fact reads like a design doc, not a commit log. If nothing is worth remembering long-term, output NONE.

3. WRITE A DAILY LOG ENTRY: A detailed paragraph covering what was worked on, decisions made, problems encountered and how they were resolved, tools and technologies used, and any notable learnings. Be comprehensive — this will be consolidated into a daily digest later. Write 3-8 sentences.

Respond in this exact format:
TASK: <task_domain>
FACTS:
<one fact per line, or NONE if nothing meaningful>
DAILY:
<3-8 sentence detailed log entry, or NONE if nothing meaningful>`;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const withoutProtocol = uri.replace('s3://', '');
  const slashIndex = withoutProtocol.indexOf('/');
  return {
    bucket: withoutProtocol.slice(0, slashIndex),
    key: withoutProtocol.slice(slashIndex + 1),
  };
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
 * Parse [mnemo-context: <payload>] from conversation turns. Current ingest
 * emits JSON; we still accept the legacy key=value,... format so records
 * written before the JSON switchover keep round-tripping.
 */
function parseMetadata(payload: Record<string, unknown>): Metadata {
  const meta: Metadata = {};
  const currentContext = Array.isArray(payload.currentContext) ? payload.currentContext as Record<string, unknown>[] : [];
  for (const entry of currentContext) {
    const content = entry.content as Record<string, unknown> | undefined;
    const text = (content?.text as string) || '';
    const match = text.match(/^\[mnemo-context:\s*(.+)\]$/);
    if (!match) continue;
    const body = match[1].trim();
    const parsed = body.startsWith('{') ? parseJsonMetadata(body) : parseLegacyMetadata(body);
    if (parsed.project) meta.project = parsed.project;
    if (parsed.source) meta.source = parsed.source;
    if (parsed.workstation) meta.workstation = parsed.workstation;
    if (parsed.date) meta.date = parsed.date;
    break; // Only one context turn expected
  }
  return meta;
}

function parseJsonMetadata(body: string): Metadata {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    const out: Metadata = {};
    if (typeof obj.project === 'string') out.project = obj.project;
    if (typeof obj.source === 'string') out.source = obj.source;
    if (typeof obj.workstation === 'string') out.workstation = obj.workstation;
    if (typeof obj.date === 'string') out.date = obj.date;
    return out;
  } catch {
    return {};
  }
}

function parseLegacyMetadata(body: string): Metadata {
  const out: Metadata = {};
  for (const pair of body.split(',')) {
    const [k, ...vParts] = pair.split('=');
    const key = k.trim();
    const value = vParts.join('=').trim();
    if (key === 'project' && value) out.project = value;
    if (key === 'source' && value) out.source = value;
    if (key === 'workstation' && value) out.workstation = value;
    if (key === 'date' && value) out.date = value;
  }
  return out;
}

const MAX_CONTEXT_ENTRIES = 200;
const MAX_CONVERSATION_CHARS = 500_000;

function extractConversationText(payload: Record<string, unknown>): string {
  const currentContext = Array.isArray(payload.currentContext) ? payload.currentContext as Record<string, unknown>[] : [];
  const entries = currentContext.slice(0, MAX_CONTEXT_ENTRIES);
  const lines: string[] = [];
  let totalChars = 0;
  for (const entry of entries) {
    const role = (entry.role as string) || 'UNKNOWN';
    const content = entry.content as Record<string, unknown> | undefined;
    const text = (content?.text as string) || '';
    if (text.startsWith('[mnemo-context:')) continue;
    const line = `${role}: ${text}`;
    if (totalChars + line.length > MAX_CONVERSATION_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }
  return lines.join('\n');
}

function parseExtraction(text: string, allowedDomains: string[]): ExtractionResult | undefined {
  const taskMatch = text.match(/^TASK:\s*(.+)$/im);
  const factsMatch = text.match(/^FACTS:\s*\n?([\s\S]*?)(?=^DAILY:)/im);
  const dailyMatch = text.match(/^DAILY:\s*\n?([\s\S]*)$/im);

  if (!taskMatch) {
    console.warn(`LLM output parse failure, no TASK line found. Output snippet: ${text.slice(0, 200)}`);
    return undefined;
  }

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

type DimensionType = 'project' | 'task';

interface ExistingRecord {
  id: string;
  content: string;
}

async function readExistingRecords(
  memoryId: string,
  namespace: string,
): Promise<ExistingRecord[]> {
  try {
    const response = await agentcore.send(
      new RetrieveMemoryRecordsCommand({
        memoryId,
        namespace,
        searchCriteria: {
          searchQuery: 'all facts, decisions, context, insights, and summaries',
          topK: 20,
        },
      })
    );
    return (response.memoryRecordSummaries || []).map((s: MemoryRecordSummary) => ({
      id: s.memoryRecordId || '',
      content: s.content?.text || '',
    })).filter((r: ExistingRecord) => r.content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to read existing records for ${namespace}:`, message);
    return [];
  }
}

async function deleteRecords(memoryId: string, recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) return;
  try {
    await agentcore.send(
      new BatchDeleteMemoryRecordsCommand({
        memoryId,
        records: recordIds.map((id) => ({ memoryRecordId: id })),
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to delete ${recordIds.length} old records:`, message);
  }
}

function buildConsolidationPrompt(
  dimensionType: DimensionType,
  existing: ExistingRecord[],
  newContent: string,
  metadata: Metadata,
): string {
  const existingText = existing
    .map((r, i) => `Record ${i + 1}:\n${r.content}`)
    .join('\n\n');

  const typeInstructions = dimensionType === 'project'
    ? `This is a PROJECT memory for "${sanitizeMetaValue(metadata.project || 'unknown')}". Keep architecture decisions, design rationale, and system constraints. Drop implementation specifics that belong in the code itself.`
    : `This is a TASK memory for transferable domain insights. Keep patterns and lessons that apply beyond a single session. Drop session-specific details.`;

  return `You are consolidating memory records into a single distilled record that supersedes all inputs.

${typeInstructions}

Rules:
- Merge overlapping statements — keep only the most complete version of each fact
- When facts conflict, keep the most recent version
- Write concisely — a good record reads like a design doc, not a changelog
- Drop anything that won't be useful in a future session

EXISTING RECORDS:
${existingText}

NEW INFORMATION TO INCORPORATE:
${newContent}

Output ONLY the merged content — no headers, labels, or explanations.`;
}

async function consolidateRecords(
  dimensionType: DimensionType,
  existing: ExistingRecord[],
  newContent: string,
  metadata: Metadata,
): Promise<string | undefined> {
  try {
    const prompt = buildConsolidationPrompt(dimensionType, existing, newContent, metadata);
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: process.env.MODEL_ID || 'us.anthropic.claude-sonnet-4-6',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
    );
    const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    if (body.stop_reason === 'max_tokens') {
      throw new ConsolidationTruncatedError(
        `Consolidation for ${dimensionType} hit max_tokens — refusing to write truncated record (data would be lost)`
      );
    }
    const contentArr = body.content as Record<string, unknown>[] | undefined;
    const text = (contentArr?.[0]?.text as string | undefined)?.trim();
    return text || undefined;
  } catch (err: unknown) {
    if (err instanceof ConsolidationTruncatedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Consolidation failed for ${dimensionType}:`, message);
    return undefined;
  }
}

async function writeConsolidatedRecord(
  memoryId: string,
  namespace: string,
  dimensionType: DimensionType,
  newContent: string,
  metadata: Metadata,
): Promise<void> {
  const existing = await readExistingRecords(memoryId, namespace);

  let finalContent = newContent;
  if (existing.length > 0) {
    const consolidated = await consolidateRecords(dimensionType, existing, newContent, metadata);
    if (consolidated) {
      finalContent = consolidated;
    }
  }

  await writeMemoryRecord(memoryId, namespace, finalContent);

  if (existing.length > 0) {
    await deleteRecords(memoryId, existing.map((r) => r.id));
  }
}

export async function handler(event: SNSEvent): Promise<void> {
  let sessionId: string | undefined;
  try {
    const message = JSON.parse(event.Records[0].Sns.Message) as Record<string, unknown>;

    const { bucket, key } = parseS3Uri(message.s3PayloadLocation as string);
    const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const payload = JSON.parse(await s3Response.Body!.transformToString()) as Record<string, unknown>;

    sessionId = payload.sessionId as string | undefined;

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
    const actorId = process.env.ACTOR_ID!;
    const memoryId = process.env.MEMORY_ID!;

    const date = metadata.date || deriveDate(payload);
    const projectName = metadata.project ? sanitizeName(metadata.project) : undefined;

    const isNone = (s: string) => !s || s === 'NONE';
    const hasProject = !!projectName && !isNone(facts);
    const hasTask = taskDomain !== 'unknown' && !isNone(facts);
    const hasDaily = !isNone(daily);

    if (!hasProject && !hasTask && !hasDaily) return;

    const writes: Array<{ label: string; promise: Promise<void> }> = [];

    if (hasProject) {
      writes.push({
        label: `project="${projectName}"`,
        promise: writeConsolidatedRecord(memoryId, `/projects/${actorId}/${projectName}/`, 'project', facts, metadata),
      });
    }

    if (hasTask) {
      writes.push({
        label: `task="${taskDomain}"`,
        promise: writeConsolidatedRecord(memoryId, `/tasks/${actorId}/${taskDomain}/`, 'task', facts, metadata),
      });
    }

    if (hasDaily) {
      writes.push({
        label: `daily="${date}"`,
        promise: writeMemoryRecord(memoryId, `/daily/${actorId}/${date}/log/`, daily),
      });
    }

    const results = await Promise.allSettled(writes.map((w) => w.promise));
    const failures = results
      .map((r, i) => ({ ...r, label: writes[i].label }))
      .filter((r): r is PromiseRejectedResult & { label: string } => r.status === 'rejected');

    if (failures.length > 0) {
      for (const f of failures) {
        const err = f.reason instanceof Error ? f.reason : new Error(String(f.reason));
        console.error(`Write failed for ${f.label}:`, err.message);
        if (err instanceof ConsolidationTruncatedError) throw err;
      }
    }

    const parts = [
      hasProject ? `project="${projectName}"` : null,
      hasTask ? `task="${taskDomain}"` : null,
      hasDaily ? `daily="${date}"` : null,
      metadata.source ? `source="${metadata.source}"` : null,
    ].filter(Boolean).join(', ');
    console.log(`Extracted context (${parts}) from session ${sessionId}`);
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : 'Unknown';
    const message = err instanceof Error ? err.message : String(err);
    console.error('Context extraction failed', {
      error: message,
      name,
      sessionId,
    });

    // Rethrow transient errors so SNS retries
    if (name === 'ThrottlingException' || name === 'ServiceUnavailableException') {
      throw err;
    }
    // Swallow permanent errors to avoid infinite retry loops
  }
}

function deriveDate(payload: Record<string, unknown>): string {
  const ts = (payload.startingTimestamp || payload.endingTimestamp || Date.now()) as string | number;
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

  const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  if (body.stop_reason === 'max_tokens') {
    console.warn('Extraction LLM hit max_tokens — output may be incomplete');
  }
  const contentArr = body.content as Record<string, unknown>[] | undefined;
  const text = (contentArr?.[0]?.text as string) || '';
  return parseExtraction(text, allowedDomains);
}
