import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  type MemoryRecordSummary,
  type RetrieveMemoryRecordsCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { MemoryRecord, RecallResponse } from '../shared/types';
import { sanitizeName } from '../shared/util';

if (!process.env.MEMORY_ID || !process.env.ACTOR_ID) {
  throw new Error('Missing required env vars: MEMORY_ID, ACTOR_ID');
}

const client = new BedrockAgentCoreClient({});
const TOP_K = 10;
const MAX_QUERY_OVERRIDE_LENGTH = 1024;

type ResponseKey = 'preferences' | 'facts' | 'episodes' | 'about' | 'project' | 'tasks' | 'daily' | 'dailyLog';

interface NamespaceQuery {
  key: ResponseKey;
  namespace: string;
  searchQuery: string;
}

interface RequestedDimensions {
  preferences: boolean;
  facts: boolean;
  episodes: boolean;
  about: boolean;
  project?: string;
  task?: string;
  date?: string;
}

function parseDimensions(params: Record<string, string | undefined>): RequestedDimensions {
  return {
    preferences: params.preferences === 'true' || params.preferences === '1',
    facts: params.facts === 'true' || params.facts === '1',
    episodes: params.episodes === 'true' || params.episodes === '1',
    about: params.about === 'true' || params.about === '1',
    project: params.project,
    task: params.task,
    date: params.date,
  };
}

function buildQueries(actorId: string, dims: RequestedDimensions): NamespaceQuery[] {
  const queries: NamespaceQuery[] = [];

  if (dims.preferences) {
    queries.push({
      key: 'preferences',
      namespace: `/preferences/${actorId}/`,
      searchQuery: 'preferences, standards, style, and workflow habits',
    });
  }

  if (dims.facts) {
    queries.push({
      key: 'facts',
      namespace: `/facts/${actorId}/`,
      searchQuery: 'general knowledge, facts, and background information',
    });
  }

  if (dims.episodes) {
    queries.push({
      key: 'episodes',
      namespace: `/episodes/${actorId}/`,
      searchQuery: 'recent work episodes, decisions, reflections, and context',
    });
  }

  if (dims.about) {
    queries.push({
      key: 'about',
      namespace: `/about/${actorId}/`,
      searchQuery: 'biographical profile: who the actor is, background, role, expertise, interests',
    });
  }

  if (dims.project) {
    const normalizedProject = sanitizeName(dims.project);
    queries.push({
      key: 'project',
      namespace: `/projects/${actorId}/${normalizedProject}/`,
      searchQuery: `project decisions, architecture, and current state for ${dims.project}`,
    });
  }

  if (dims.task) {
    const normalizedTask = sanitizeName(dims.task);
    queries.push({
      key: 'tasks',
      namespace: `/tasks/${actorId}/${normalizedTask}/`,
      searchQuery: `task-specific insights, patterns, and context for ${dims.task}`,
    });
  }

  if (dims.date) {
    queries.push({
      key: 'daily',
      namespace: `/daily/${actorId}/${dims.date}/summary/`,
      searchQuery: `daily digest and reflection for ${dims.date}`,
    });
    queries.push({
      key: 'dailyLog',
      namespace: `/daily/${actorId}/${dims.date}/log/`,
      searchQuery: `daily activity log entries for ${dims.date}`,
    });
  }

  return queries;
}

function toMemoryRecords(summaries: MemoryRecordSummary[]): MemoryRecord[] {
  return summaries.map((s: MemoryRecordSummary) => ({
    id: s.memoryRecordId || '',
    content: s.content?.text || '',
    score: s.score || 0,
    createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt || ''),
  }));
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const params = event.queryStringParameters || {};
    const actorId = process.env.ACTOR_ID!;
    const memoryId = process.env.MEMORY_ID!;

    const dims = parseDimensions(params);
    const queries = buildQueries(actorId, dims);

    // Optional ?q= overrides every namespace's default searchQuery. Trimmed
    // and length-capped so callers can't smuggle oversized prompts through.
    const rawQ = params.q;
    const queryOverride = typeof rawQ === 'string' ? rawQ.trim() : '';
    if (queryOverride.length > MAX_QUERY_OVERRIDE_LENGTH) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `q exceeds maximum of ${MAX_QUERY_OVERRIDE_LENGTH} chars` }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
    const effectiveQueries = queryOverride
      ? queries.map((q) => ({ ...q, searchQuery: queryOverride }))
      : queries;

    if (queries.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      };
    }

    const results = await Promise.all(
      effectiveQueries.map((q) =>
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
          .then((r: RetrieveMemoryRecordsCommandOutput) => ({ key: q.key, records: toMemoryRecords(r.memoryRecordSummaries || []) }))
      )
    );

    const response: RecallResponse = {};

    for (const result of results) {
      if (result.key === 'project' && dims.project) {
        response.project = { name: dims.project, memories: result.records };
      } else if (result.key === 'tasks' && dims.task) {
        response.tasks = { name: dims.task, memories: result.records };
      } else if (result.key === 'daily' && dims.date) {
        if (result.records.length > 0) {
          response.daily = { date: dims.date, memories: result.records };
        }
      } else if (result.key === 'dailyLog' && dims.date) {
        if (!response.daily || response.daily.memories.length === 0) {
          response.daily = { date: dims.date, memories: result.records };
        }
      } else {
        const key = result.key as 'preferences' | 'facts' | 'episodes' | 'about';
        response[key] = result.records;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify(response),
      headers: { 'Content-Type': 'application/json' },
    };
  } catch (err: unknown) {
    console.error('Recall error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }
}
