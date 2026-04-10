import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = vi.fn();

vi.hoisted(() => {
  process.env.MEMORY_ID = 'mem-123';
  process.env.ACTOR_ID = 'tiago';
});

vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  return {
    BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
      send: (...args: unknown[]) => mockSend(...args),
    })),
    CreateEventCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  };
});

import { handler } from '../../lambda/ingest/index';

function makeEvent(body: object): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/events',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
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
    expect(command.input.payload).toHaveLength(3); // context turn + 2 conversation turns
    expect(command.input.payload[0].conversational.role).toBe('OTHER');
    expect(command.input.payload[0].conversational.content.text).toMatch(/^\[mnemo-context:\s*\{.+\}\]$/);
    const metaJson = command.input.payload[0].conversational.content.text.match(/^\[mnemo-context:\s*(\{.+\})\]$/)[1];
    expect(JSON.parse(metaJson)).toMatchObject({ project: 'mnemo', workstation: 'laptop' });
    expect(command.input.payload[1].conversational.role).toBe('USER');
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

  it('preserves commas and equals signs in metadata values through JSON encoding', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'session-tricky',
        turns: [{ role: 'user', content: 'hello' }],
        context: {
          project: 'foo, bar = baz',
          workstation: 'laptop',
          workdir: '/home/user',
          timestamp: '2026-04-13T14:00:00Z',
        },
      })
    );

    expect(result.statusCode).toBe(200);
    const command = mockSend.mock.calls[0][0];
    const text = command.input.payload[0].conversational.content.text;
    const metaJson = text.match(/^\[mnemo-context:\s*(\{.+\})\]$/)[1];
    expect(JSON.parse(metaJson).project).toBe('foo, bar = baz');
  });

  it('returns 415 when Content-Type is not JSON', async () => {
    const event = makeEvent({ sessionId: 's', turns: [{ role: 'user', content: 'hi' }], context: { workstation: 'w', workdir: '/w', timestamp: '2026-04-10T14:00:00Z' } });
    event.headers = { 'content-type': 'text/plain' };
    const result = await handler(event);
    expect(result.statusCode).toBe(415);
  });

  it('returns 400 on invalid JSON body', async () => {
    const event = makeEvent({});
    event.body = '{not json';
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Invalid JSON');
  });

  it('returns 400 when sessionId exceeds max length', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 'x'.repeat(300),
        turns: [{ role: 'user', content: 'hi' }],
        context: { workstation: 'w', workdir: '/w', timestamp: '2026-04-10T14:00:00Z' },
      })
    );
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when turns exceed maximum count', async () => {
    const turns = Array.from({ length: 201 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    const result = await handler(
      makeEvent({
        sessionId: 's',
        turns,
        context: { workstation: 'w', workdir: '/w', timestamp: '2026-04-10T14:00:00Z' },
      })
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('200');
  });

  it('returns 400 on invalid turn role', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 's',
        turns: [{ role: 'system', content: 'hi' }],
        context: { workstation: 'w', workdir: '/w', timestamp: '2026-04-10T14:00:00Z' },
      })
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('role');
  });

  it('returns 400 on invalid timestamp', async () => {
    const result = await handler(
      makeEvent({
        sessionId: 's',
        turns: [{ role: 'user', content: 'hi' }],
        context: { workstation: 'w', workdir: '/w', timestamp: 'not-a-date' },
      })
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('timestamp');
  });

  it('returns generic error on internal failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('ServiceUnavailableException'));
    const result = await handler(
      makeEvent({
        sessionId: 's',
        turns: [{ role: 'user', content: 'hi' }],
        context: { workstation: 'w', workdir: '/w', timestamp: '2026-04-10T14:00:00Z' },
      })
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('Internal server error');
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
