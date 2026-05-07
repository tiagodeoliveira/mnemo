import {
  BedrockAgentCoreClient,
  BatchCreateMemoryRecordsCommand,
  BatchDeleteMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
  type MemoryRecordSummary,
} from '@aws-sdk/client-bedrock-agentcore';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

if (!process.env.MEMORY_ID) {
  throw new Error('Missing required env var: MEMORY_ID');
}

const agentcore = new BedrockAgentCoreClient({});
const bedrock = new BedrockRuntimeClient({});
const ses = new SESv2Client({});

function getLocalDate(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

interface LogRecord {
  id: string;
  content: string;
}

async function readLogRecords(memoryId: string, namespace: string): Promise<LogRecord[]> {
  try {
    const response = await agentcore.send(
      new RetrieveMemoryRecordsCommand({
        memoryId,
        namespace,
        searchCriteria: {
          searchQuery: 'all daily activity, work done, decisions, problems, learnings',
          topK: 50,
        },
      })
    );
    return (response.memoryRecordSummaries || [])
      .map((s: MemoryRecordSummary) => ({
        id: s.memoryRecordId || '',
        content: s.content?.text || '',
      }))
      .filter((r: LogRecord) => r.content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to read log records from ${namespace}:`, message);
    return [];
  }
}

async function readExistingSummaryIds(memoryId: string, namespace: string): Promise<string[]> {
  try {
    const response = await agentcore.send(
      new RetrieveMemoryRecordsCommand({
        memoryId,
        namespace,
        searchCriteria: {
          searchQuery: 'daily summary',
          topK: 10,
        },
      })
    );
    return (response.memoryRecordSummaries || [])
      .map((s: MemoryRecordSummary) => s.memoryRecordId)
      .filter((id): id is string => Boolean(id));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to read existing summary ids: ${message}`);
    return [];
  }
}

async function deleteSummaryIds(memoryId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await agentcore.send(
      new BatchDeleteMemoryRecordsCommand({
        memoryId,
        records: ids.map((id: string) => ({ memoryRecordId: id })),
      })
    );
    console.log(`Deleted ${ids.length} stale summary records`);
  } catch (err: unknown) {
    // Duplicates are recoverable on the next run; log and move on.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to delete stale summaries: ${message}`);
  }
}

function buildDigestPrompt(date: string, logEntries: string[]): string {
  const logs = logEntries.map((entry, i) => `Entry ${i + 1}:\n${entry}`).join('\n\n');

  return `You are generating a structured daily digest for ${date} from activity log entries captured throughout the day.

Produce a reflection with these sections:

## Projects
What was worked on, organized by project. Brief description of progress and key changes for each.

## Decisions
Important decisions made and their rationale. Skip trivial choices.

## Learnings
New things discovered, insights, technical knowledge gained.

## Time Allocation
Rough estimate of where effort went (by project or activity type). Use relative terms (most of the day, a couple hours, briefly).

## Blockers & Resolutions
Problems encountered and how they were resolved. Skip if none.

## Carry Forward
Open questions, unfinished work, or things to pick up next.

## Reflection
1-2 sentences on what went well and what could improve.

Rules:
- Write in first person
- Be specific — name projects, tools, files, and technologies
- Skip sections that have no content for the day (except Projects and Reflection, which are always required)
- If the log entries are too sparse for a meaningful digest, still produce Projects and Reflection with what you have

LOG ENTRIES:
${logs}`;
}

async function generateDigest(date: string, logEntries: string[]): Promise<string | undefined> {
  const prompt = buildDigestPrompt(date, logEntries);
  try {
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
      throw new Error(`Digest generation for ${date} hit max_tokens — refusing to write truncated summary`);
    }
    const contentArr = body.content as Record<string, unknown>[] | undefined;
    return (contentArr?.[0]?.text as string | undefined)?.trim() || undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Digest generation failed:', message);
    throw err;
  }
}

const AGENTCORE_RECORD_LIMIT = 16_000;

function truncateToLimit(content: string): string {
  if (content.length <= AGENTCORE_RECORD_LIMIT) return content;
  console.warn(`Summary content (${content.length} chars) exceeds ${AGENTCORE_RECORD_LIMIT} limit, truncating`);
  return content.slice(0, AGENTCORE_RECORD_LIMIT - 4) + '\n...';
}

async function writeSummary(memoryId: string, namespace: string, content: string): Promise<void> {
  await agentcore.send(
    new BatchCreateMemoryRecordsCommand({
      memoryId,
      records: [
        {
          requestIdentifier: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          namespaces: [namespace],
          content: { text: truncateToLimit(content) },
          timestamp: new Date(),
        },
      ],
    })
  );
}

function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const isListItem = /^[-*] /.test(line);

    if (isListItem && !inList) {
      out.push('<ul style="padding-left: 20px; margin: 8px 0;">');
      inList = true;
    } else if (!isListItem && inList) {
      out.push('</ul>');
      inList = false;
    }

    if (isListItem) {
      const content = line.replace(/^[-*] /, '');
      out.push(`<li style="margin: 4px 0;">${inlineFormat(escapeHtml(content))}</li>`);
      continue;
    }

    if (/^### (.+)$/.test(line)) {
      const title = line.replace(/^### /, '');
      out.push(`<h3 style="color: #444; margin: 16px 0 4px 0; font-size: 15px;">${inlineFormat(escapeHtml(title))}</h3>`);
      continue;
    }

    if (/^## (.+)$/.test(line)) {
      const title = line.replace(/^## /, '');
      out.push(`<h2 style="color: #222; border-bottom: 1px solid #eee; padding-bottom: 4px; margin: 24px 0 8px 0; font-size: 18px;">${escapeHtml(title)}</h2>`);
      continue;
    }

    if (line.trim() === '') {
      out.push('<br/>');
      continue;
    }

    out.push(`<p style="margin: 4px 0; line-height: 1.5;">${inlineFormat(escapeHtml(line))}</p>`);
  }

  if (inList) out.push('</ul>');

  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFormat(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code style="background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 13px;">$1</code>');
}

async function sendEmail(from: string, to: string, date: string, digest: string): Promise<void> {
  const htmlBody = markdownToHtml(digest);

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: `mnemo daily digest - ${date}` },
          Body: {
            Html: {
              Data: `<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #333; background: #fff;">
<h1 style="border-bottom: 2px solid #ddd; padding-bottom: 8px; color: #111; font-size: 22px;">Daily Digest: ${date}</h1>
${htmlBody}
<hr style="border: none; border-top: 1px solid #eee; margin-top: 32px;"/>
<p style="color: #999; font-size: 12px;">Generated by mnemo</p>
</body></html>`,
            },
            Text: { Data: `Daily Digest: ${date}\n\n${digest}` },
          },
        },
      },
    })
  );
}

interface DispatchMessage {
  actorId: string;
  email?: string;
  timezone?: string;
  /** Optional YYYY-MM-DD override. When absent, the date is derived from timezone. */
  date?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseMessage(record: SQSRecord): DispatchMessage {
  const msg = JSON.parse(record.body) as Record<string, unknown>;
  if (typeof msg.actorId !== 'string' || !msg.actorId) {
    throw new Error('SQS message missing actorId');
  }
  if (msg.date !== undefined) {
    if (typeof msg.date !== 'string' || !DATE_PATTERN.test(msg.date)) {
      throw new Error(`SQS message date must match YYYY-MM-DD, got "${String(msg.date)}"`);
    }
  }
  return {
    actorId: msg.actorId,
    email: typeof msg.email === 'string' ? msg.email : undefined,
    timezone: typeof msg.timezone === 'string' ? msg.timezone : undefined,
    date: typeof msg.date === 'string' ? msg.date : undefined,
  };
}

async function processActor(memoryId: string, msg: DispatchMessage, emailFrom: string | undefined): Promise<void> {
  const timezone = msg.timezone || 'UTC';
  const date = msg.date || getLocalDate(timezone);
  const logNamespace = `/daily/${msg.actorId}/${date}/log/`;
  const summaryNamespace = `/daily/${msg.actorId}/${date}/summary/`;

  const logs = await readLogRecords(memoryId, logNamespace);
  if (logs.length === 0) {
    console.log(`No log records found for actor=${msg.actorId} date=${date}, skipping`);
    return;
  }

  console.log(`Generating digest for actor=${msg.actorId} date=${date} from ${logs.length} log entries`);

  const digest = await generateDigest(date, logs.map((r) => r.content));
  if (!digest) {
    console.warn(`Digest generation returned empty result for actor=${msg.actorId} date=${date}`);
    return;
  }

  // Capture existing summary ids BEFORE writing so we only delete records
  // that predate the new write. If writeSummary throws, the prior summary
  // stays intact and tomorrow's run (or a manual retry) can overwrite it.
  const staleIds = await readExistingSummaryIds(memoryId, summaryNamespace);
  await writeSummary(memoryId, summaryNamespace, digest);
  await deleteSummaryIds(memoryId, staleIds);
  console.log(`Wrote daily summary for actor=${msg.actorId} date=${date}`);

  if (emailFrom && msg.email) {
    try {
      await sendEmail(emailFrom, msg.email, date, digest);
      console.log(`Sent digest email to ${msg.email}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send digest email to ${msg.email}: ${message}`);
    }
  }

  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'mnemo',
        Dimensions: [['Service']],
        Metrics: [{ Name: 'DigestsGenerated', Unit: 'Count' }],
      }],
    },
    Service: 'digest',
    DigestsGenerated: 1,
  }));
}

export async function handler(event: SQSEvent): Promise<void> {
  const memoryId = process.env.MEMORY_ID!;
  const emailFrom = process.env.DIGEST_EMAIL_FROM;

  for (const record of event.Records) {
    const msg = parseMessage(record);
    await processActor(memoryId, msg, emailFrom);
  }
}
