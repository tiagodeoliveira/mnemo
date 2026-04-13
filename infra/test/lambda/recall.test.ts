import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (...args: any[]) => mockSend(...args),
  })),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

import { handler } from '../../lambda/recall/index';

function makeEvent(queryParams: Record<string, string> | null): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/recall',
    pathParameters: null,
    queryStringParameters: queryParams,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    multiValueHeaders: {},
  };
}

const mockMemoryResponse = (records: Array<{ text: string; score: number }>) => ({
  memoryRecordSummaries: records.map((r, i) => ({
    memoryRecordId: `rec-${i}`,
    content: { text: r.text },
    score: r.score,
    createdAt: new Date().toISOString(),
    namespaces: [],
  })),
});

describe('recall lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    mockSend.mockResolvedValue(mockMemoryResponse([{ text: 'test fact', score: 0.9 }]));
  });

  it('queries 3 namespaces without project', async () => {
    const result = await handler(makeEvent(null));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(body.project).toBeUndefined();
    expect(body.preferences).toBeDefined();
    expect(body.facts).toBeDefined();
    expect(body.episodes).toBeDefined();
  });

  it('queries 4 namespaces with project', async () => {
    const result = await handler(makeEvent({ project: 'mnemo' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(body.project).toBeDefined();
    expect(body.project.name).toBe('mnemo');
  });

  it('formats memory records in response', async () => {
    mockSend.mockResolvedValue(
      mockMemoryResponse([
        { text: 'prefers TypeScript', score: 0.95 },
        { text: 'uses vim', score: 0.8 },
      ])
    );

    const result = await handler(makeEvent(null));
    const body = JSON.parse(result.body);

    expect(body.preferences).toHaveLength(2);
    expect(body.preferences[0].content).toBe('prefers TypeScript');
    expect(body.preferences[0].score).toBe(0.95);
  });

  it('queries 5 namespaces with project and task', async () => {
    const result = await handler(makeEvent({ project: 'mnemo', task: 'coding' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(5);
    expect(body.project).toBeDefined();
    expect(body.project.name).toBe('mnemo');
    expect(body.tasks).toBeDefined();
    expect(body.tasks.name).toBe('coding');
  });

  it('queries 4 namespaces with date only', async () => {
    const result = await handler(makeEvent({ date: '2026-04-13' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(body.daily).toBeDefined();
    expect(body.daily.date).toBe('2026-04-13');
  });

  it('queries all 6 namespaces with project, task, and date', async () => {
    const result = await handler(
      makeEvent({ project: 'mnemo', task: 'coding', date: '2026-04-13' })
    );
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(6);
    expect(body.project.name).toBe('mnemo');
    expect(body.tasks.name).toBe('coding');
    expect(body.daily.date).toBe('2026-04-13');
  });
});
