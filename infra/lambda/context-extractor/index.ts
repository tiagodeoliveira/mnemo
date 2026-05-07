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

if (!process.env.MEMORY_ID) {
  throw new Error('Missing required env var: MEMORY_ID');
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

const AGENTCORE_RECORD_LIMIT = 16_000;
const MAX_META_LENGTH = 128;
const CONSOLIDATION_TOP_K = parseInt(process.env.CONSOLIDATION_TOP_K || '5', 10);

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
  attributes?: Record<string, string>;
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
    if (obj.attributes && typeof obj.attributes === 'object' && !Array.isArray(obj.attributes)) {
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.attributes as Record<string, unknown>)) {
        if (typeof v === 'string') attrs[k] = v;
      }
      if (Object.keys(attrs).length > 0) out.attributes = attrs;
    }
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

function truncateToLimit(content: string): string {
  if (content.length <= AGENTCORE_RECORD_LIMIT) return content;
  console.warn(`Record content (${content.length} chars) exceeds ${AGENTCORE_RECORD_LIMIT} limit, truncating`);
  return content.slice(0, AGENTCORE_RECORD_LIMIT - 4) + '\n...';
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
          content: { text: truncateToLimit(content) },
          timestamp: new Date(),
        },
      ],
    })
  );
}

type DimensionType = 'project' | 'task' | 'about';

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
          topK: CONSOLIDATION_TOP_K,
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

  if (dimensionType === 'about') {
    return `You are maintaining a living biographical profile of a person, updated over time as new information surfaces about them.

This is an ABOUT memory — who the actor is as a person: background, role, expertise, ongoing interests, identity attributes. Think of it as a short "About" section on someone's personal site.

Rules:
- Write as ONE flowing narrative paragraph (or two short paragraphs if needed). NOT a bullet list.
- Merge the new information with the existing bio. Drop outdated or contradicted facts — keep the most recent version.
- Stay under ~800 words. A good bio is dense and specific.
- Do not invent facts. Only include what the existing bio or new observations clearly establish.
- Write in third person ("Tiago is a...") for consistency.
- HARD LIMIT: output must be under ${AGENTCORE_RECORD_LIMIT} characters.

EXISTING BIO:
${existingText || '(none yet)'}

NEW OBSERVATIONS TO INCORPORATE:
${newContent}

Output ONLY the merged bio text — no headers, labels, or explanations.`;
  }

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
- HARD LIMIT: output must be under ${AGENTCORE_RECORD_LIMIT} characters. Prioritize the most important facts and cut aggressively if needed

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
    // Run the standard extraction and the about extraction in parallel.
    // Each hits Bedrock once; combined latency is max(standard, about).
    const [result, aboutContent] = await Promise.all([
      callLlm(conversationText, allowedDomains, metadata),
      callAboutLlm(conversationText).catch((err: unknown) => {
        // About extraction is best-effort — a failure here shouldn't block
        // project/task/daily. Log and move on.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`About extraction failed for session ${sessionId}: ${message}`);
        return undefined;
      }),
    ]);
    if (!result) {
      console.warn(`Failed to parse LLM extraction for session ${sessionId}`);
      return;
    }

    const { taskDomain, facts, daily } = result;
    // AgentCore stamps actorId on each event and propagates it into the S3
    // payload. Since ingest is the only writer and sets this field, trusting
    // the payload lets a single mnemo deployment serve multiple actors.
    const actorId = payload.actorId as string | undefined;
    if (!actorId) {
      console.warn(`Payload missing actorId, skipping session ${sessionId}`);
      return;
    }
    const memoryId = process.env.MEMORY_ID!;

    const date = metadata.date || deriveDate(payload);
    const projectName = metadata.project ? sanitizeName(metadata.project) : undefined;

    const isNone = (s: string) => !s || s === 'NONE';
    const hasProject = !!projectName && !isNone(facts);
    const hasTask = taskDomain !== 'unknown' && !isNone(facts);
    const hasDaily = !isNone(daily);
    const hasAbout = !!aboutContent && !isNone(aboutContent);

    if (!hasProject && !hasTask && !hasDaily && !hasAbout) return;

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

    if (hasAbout) {
      console.log(`about extracted: ${aboutContent!.slice(0, 500)}`);
      writes.push({
        label: `about`,
        promise: writeConsolidatedRecord(memoryId, `/about/${actorId}/`, 'about', aboutContent!, metadata),
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
      hasAbout ? `about=yes` : null,
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

function buildAboutPrompt(): string {
  return `You are extracting biographical facts about the person (the "actor") who is participating in this conversation.

WHAT COUNTS AS ABOUT-ME CONTENT:
- Who they are: role, profession, background, experience, expertise areas
- What they're doing: active projects, responsibilities, long-running goals
- Where they come from: career history, education, notable past work
- Their domain: tools they use daily, technologies they specialize in, industries they work in
- People in their orbit: team, collaborators, family roles (only if explicitly stated)

STRICT ATTRIBUTION RULES:
- Extract from USER turns (first-person testimony): "I'm a principal engineer", "I work on mnemo", "I live in California".
- Extract from ASSISTANT turns ONLY when the assistant is responding to user-supplied content: the user shared a resume, pasted a bio, uploaded a profile, or asked the assistant to analyze something they provided. In that case the assistant's claims are grounded in the user's own material and are trustworthy.
- DO NOT extract assistant statements that are not grounded in something the user provided. Ignore generic advice, persona statements, or guesses.
- DO NOT infer. If a fact is not clearly stated, skip it.

WHAT TO SKIP:
- Transient state ("I'm tired today", "I'm annoyed at this bug")
- Opinions the user holds about tools, unless they define their identity (e.g., "I'm a Rust zealot" is about identity; "I don't like Java" is just an opinion)
- Operational preferences like coding style or communication style — those live elsewhere

OUTPUT FORMAT:
ABOUT:
<one short factual statement per line, or NONE if nothing biographical surfaced>`;
}

async function callAboutLlm(conversation: string): Promise<string | undefined> {
  const prompt = buildAboutPrompt();
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
    console.warn('About LLM hit max_tokens — output may be incomplete');
  }
  const contentArr = body.content as Record<string, unknown>[] | undefined;
  const text = (contentArr?.[0]?.text as string) || '';
  // Require an explicit ABOUT: marker. If the LLM emitted a response that
  // doesn't conform, treat it as no signal rather than writing noise to the
  // bio namespace.
  const match = text.match(/^ABOUT:\s*\n?([\s\S]*)$/im);
  if (!match) return undefined;
  const extracted = match[1].trim();
  if (!extracted || extracted === 'NONE') return undefined;
  return extracted;
}
