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
          .then((r: any) => ({ key: q.key, records: toMemoryRecords(r.memoryRecordSummaries || []) }))
          .catch((err: any) => {
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
