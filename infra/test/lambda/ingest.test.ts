import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  return {
    BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
      send: (...args: any[]) => mockSend(...args),
    })),
    CreateEventCommand: vi.fn().mockImplementation((input: any) => ({ input })),
  };
});

import { handler } from '../../lambda/ingest/index';

function makeEvent(body: object): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/events',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    multiValueHeaders: {},
  };
}

describe('ingest lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    mockSend.mockResolvedValue({ event: { eventId: 'evt-1' } });
  });

  it('maps turns to CreateEvent payload', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-1',
        turns: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        context: {
          project: 'mnemo',
          workstation: 'laptop',
          workdir: '/home/user/mnemo',
          timestamp: '2026-04-10T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();

    const command = mockSend.mock.calls[0][0];
    expect(command.input.memoryId).toBe('mem-123');
    expect(command.input.actorId).toBe('tiago');
    expect(command.input.sessionId).toBe('session-1');
    expect(command.input.payload).toHaveLength(2);
    expect(command.input.payload[0].conversational.role).toBe('USER');
    expect(command.input.metadata.project.stringValue).toBe('mnemo');
  });

  it('handles missing optional project', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-2',
        turns: [{ role: 'user', content: 'test' }],
        context: {
          workstation: 'laptop',
          workdir: '/home/user',
          timestamp: '2026-04-10T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.metadata.project).toBeUndefined();
  });

  it('returns 400 on missing turns', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-3',
        context: {
          workstation: 'laptop',
          workdir: '/home',
          timestamp: '2026-04-10T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(400);
  });

  it('passes source metadata when provided', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-4',
        turns: [{ role: 'user', content: 'hello' }],
        context: {
          workstation: 'laptop',
          workdir: '/home/user',
          timestamp: '2026-04-13T14:00:00Z',
          source: 'claude-code',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.metadata.source.stringValue).toBe('claude-code');
  });

  it('derives date from timestamp and includes in metadata', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-5',
        turns: [{ role: 'user', content: 'hello' }],
        context: {
          workstation: 'laptop',
          workdir: '/home/user',
          timestamp: '2026-04-13T14:30:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.metadata.date.stringValue).toBe('2026-04-13');
  });
});
