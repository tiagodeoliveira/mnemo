import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = vi.fn();

vi.hoisted(() => {
  process.env.MEMORY_ID = 'mem-123';
  process.env.ACTOR_ID = 'tiago';
});

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockSend(...args),
  })),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
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
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
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

  it('returns empty object when no dimensions requested', async () => {
    const result = await handler(makeEvent(null));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(0);
    expect(body).toEqual({});
  });

  it('queries only preferences when requested', async () => {
    const result = await handler(makeEvent({ preferences: 'true' }));
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(body.preferences).toBeDefined();
    expect(body.facts).toBeUndefined();
    expect(body.episodes).toBeUndefined();
  });

  it('queries preferences and facts together', async () => {
    const result = await handler(makeEvent({ preferences: 'true', facts: 'true' }));
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.preferences).toBeDefined();
    expect(body.facts).toBeDefined();
    expect(body.episodes).toBeUndefined();
  });

  it('queries the about namespace when about=true', async () => {
    mockSend.mockImplementation((cmd: Record<string, Record<string, unknown>>) => {
      if ((cmd.input.namespace as string) === '/about/tiago/') {
        return Promise.resolve(mockMemoryResponse([{ text: 'Tiago is a principal engineer.', score: 0.99 }]));
      }
      return Promise.resolve({ memoryRecordSummaries: [] });
    });

    const result = await handler(makeEvent({ about: 'true' }));
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0][0];
    expect(call.input.namespace).toBe('/about/tiago/');
    expect(body.about).toBeDefined();
    expect(body.about[0].content).toBe('Tiago is a principal engineer.');
    expect(body.preferences).toBeUndefined();
  });

  it('queries project namespace when project passed', async () => {
    const result = await handler(makeEvent({ project: 'mnemo' }));
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(body.project).toBeDefined();
    expect(body.project.name).toBe('mnemo');
    expect(body.preferences).toBeUndefined();
  });

  it('formats memory records in response', async () => {
    mockSend.mockResolvedValue(
      mockMemoryResponse([
        { text: 'prefers TypeScript', score: 0.95 },
        { text: 'uses vim', score: 0.8 },
      ])
    );

    const result = await handler(makeEvent({ preferences: 'true' }));
    const body = JSON.parse(result.body);

    expect(body.preferences).toHaveLength(2);
    expect(body.preferences[0].content).toBe('prefers TypeScript');
    expect(body.preferences[0].score).toBe(0.95);
  });

  it('queries project and task together', async () => {
    const result = await handler(makeEvent({ project: 'mnemo', task: 'coding' }));
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.project.name).toBe('mnemo');
    expect(body.tasks.name).toBe('coding');
  });

  it('queries date with summary and log namespaces', async () => {
    const result = await handler(makeEvent({ date: '2026-04-13' }));
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.daily).toBeDefined();
    expect(body.daily.date).toBe('2026-04-13');
  });

  it('queries all dimensions when all flags passed', async () => {
    const result = await handler(
      makeEvent({
        preferences: 'true', facts: 'true', episodes: 'true',
        project: 'mnemo', task: 'coding', date: '2026-04-13',
      })
    );
    const body = JSON.parse(result.body);

    expect(mockSend).toHaveBeenCalledTimes(7);
    expect(body.preferences).toBeDefined();
    expect(body.facts).toBeDefined();
    expect(body.episodes).toBeDefined();
    expect(body.project.name).toBe('mnemo');
    expect(body.tasks.name).toBe('coding');
    expect(body.daily.date).toBe('2026-04-13');
  });

  it('prefers summary over log when both exist', async () => {
    mockSend.mockImplementation((cmd: Record<string, Record<string, unknown>>) => {
      if ((cmd.input.namespace as string)?.includes('/summary/')) {
        return Promise.resolve(mockMemoryResponse([{ text: 'structured digest', score: 0.95 }]));
      }
      if ((cmd.input.namespace as string)?.includes('/log/')) {
        return Promise.resolve(mockMemoryResponse([{ text: 'raw log entry', score: 0.9 }]));
      }
      return Promise.resolve(mockMemoryResponse([{ text: 'other', score: 0.8 }]));
    });

    const result = await handler(makeEvent({ date: '2026-04-13' }));
    const body = JSON.parse(result.body);

    expect(body.daily.memories[0].content).toBe('structured digest');
  });

  it('falls back to log when no summary exists', async () => {
    mockSend.mockImplementation((cmd: Record<string, Record<string, unknown>>) => {
      if ((cmd.input.namespace as string)?.includes('/summary/')) {
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      if ((cmd.input.namespace as string)?.includes('/log/')) {
        return Promise.resolve(mockMemoryResponse([{ text: 'raw log entry', score: 0.9 }]));
      }
      return Promise.resolve(mockMemoryResponse([{ text: 'other', score: 0.8 }]));
    });

    const result = await handler(makeEvent({ date: '2026-04-13' }));
    const body = JSON.parse(result.body);

    expect(body.daily.memories[0].content).toBe('raw log entry');
  });

  it('returns 500 when any sub-query fails (fail-closed)', async () => {
    mockSend.mockRejectedValueOnce(new Error('ThrottlingException: rate exceeded'));

    const result = await handler(makeEvent({ preferences: 'true' }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('Internal server error');
  });

  it('returns 500 on mixed success/failure rather than a partial response', async () => {
    // Preferences succeeds, facts fails. The old behavior would have returned
    // 200 with preferences populated and facts silently empty — that silent
    // empty looks like "no memories found" to a user, which is exactly what
    // fail-closed is meant to prevent.
    mockSend
      .mockResolvedValueOnce(mockMemoryResponse([{ text: 'pref', score: 0.9 }]))
      .mockRejectedValueOnce(new Error('AccessDeniedException'));

    const result = await handler(makeEvent({ preferences: 'true', facts: 'true' }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('Internal server error');
  });

  // --- malformed input tests ---

  it('returns empty object when query params is an empty object', async () => {
    const result = await handler(makeEvent({}));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(0);
    expect(body).toEqual({});
  });

  it('returns empty object when dimension flags are non-truthy strings', async () => {
    const result = await handler(makeEvent({ preferences: 'false', facts: 'yes', episodes: '' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(0);
    expect(body).toEqual({});
  });

  it('passes through an invalid date format and still queries the API', async () => {
    const result = await handler(makeEvent({ date: 'not-a-date' }));
    const body = JSON.parse(result.body);

    // The handler does not validate date format; it forwards it as a namespace
    // segment. The two queries (summary + log) still fire.
    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.daily).toBeDefined();
    expect(body.daily.date).toBe('not-a-date');
  });

  it('passes through a date with extra whitespace in the namespace', async () => {
    const result = await handler(makeEvent({ date: '  2026-04-13  ' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(2);
    // The raw value is forwarded without trimming
    expect(body.daily.date).toBe('  2026-04-13  ');
  });

  it('throws at module level when MEMORY_ID is missing', async () => {
    // The recall module validates env vars at import time (outside the handler).
    // Clearing them and re-importing triggers that guard.
    const saved = { MEMORY_ID: process.env.MEMORY_ID, ACTOR_ID: process.env.ACTOR_ID };
    delete process.env.MEMORY_ID;
    delete process.env.ACTOR_ID;

    await expect(async () => {
      // @ts-expect-error query string cache-buster for re-import
      await import('../../lambda/recall/index?missing_env');
    }).rejects.toThrow('Missing required env vars');

    // Restore so later tests are unaffected
    process.env.MEMORY_ID = saved.MEMORY_ID;
    process.env.ACTOR_ID = saved.ACTOR_ID;
  });

  it('handles a very long project name without error', async () => {
    const longName = 'a'.repeat(5000);
    const result = await handler(makeEvent({ project: longName }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(body.project.name).toBe(longName);
  });

  it('handles a very long task name without error', async () => {
    const longTask = 'z'.repeat(5000);
    const result = await handler(makeEvent({ task: longTask }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(body.tasks.name).toBe(longTask);
  });

  it('sanitizes task param in namespace to prevent injection', async () => {
    const result = await handler(makeEvent({ task: '../../etc/passwd' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const cmd = mockSend.mock.calls[0][0] as { input: { namespace: string } };
    expect(cmd.input.namespace).not.toContain('..');
    expect(cmd.input.namespace).toContain('/tasks/tiago/');
    expect(body.tasks.name).toBe('../../etc/passwd');
  });

  it('handles a very long date string without error', async () => {
    const longDate = '2026-04-13-' + 'x'.repeat(5000);
    const result = await handler(makeEvent({ date: longDate }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(body.daily.date).toBe(longDate);
  });

  it('uses the per-dimension default searchQuery when no q= override is given', async () => {
    await handler(makeEvent({ preferences: 'true' }));

    const cmd = mockSend.mock.calls[0][0] as { input: { searchCriteria: { searchQuery: string } } };
    // Default query for the preferences namespace — not the caller-supplied one
    expect(cmd.input.searchCriteria.searchQuery).toMatch(/preferences/i);
  });

  it('overrides searchQuery on every retrieve call when q= is present', async () => {
    await handler(
      makeEvent({
        preferences: 'true',
        facts: 'true',
        q: 'Rust and async runtimes',
      })
    );

    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const call of mockSend.mock.calls) {
      const cmd = call[0] as { input: { searchCriteria: { searchQuery: string } } };
      expect(cmd.input.searchCriteria.searchQuery).toBe('Rust and async runtimes');
    }
  });

  it('trims surrounding whitespace on q= and treats empty q= as absent', async () => {
    await handler(makeEvent({ preferences: 'true', q: '   ' }));

    const cmd = mockSend.mock.calls[0][0] as { input: { searchCriteria: { searchQuery: string } } };
    // Falls back to the default, not "   "
    expect(cmd.input.searchCriteria.searchQuery).toMatch(/preferences/i);
  });

  it('returns 400 when q= exceeds the length cap', async () => {
    const result = await handler(
      makeEvent({
        preferences: 'true',
        q: 'x'.repeat(1025),
      })
    );

    expect(result.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
