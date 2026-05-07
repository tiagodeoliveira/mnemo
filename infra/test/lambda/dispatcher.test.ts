import { describe, it, expect, vi, beforeEach } from 'vitest';

const ddbSend = vi.fn();
const sqsSend = vi.fn();

vi.hoisted(() => {
  process.env.ACTORS_TABLE = 'actors';
  process.env.DIGEST_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/digest';
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({
    send: (cmd: unknown) => ddbSend(cmd),
  })),
  ScanCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'Scan', input })),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: (cmd: unknown) => sqsSend(cmd),
  })),
  SendMessageBatchCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'SendMessageBatch', input })),
}));

import { handler } from '../../lambda/dispatcher/index';

interface ScanCmd {
  __cmd: 'Scan';
  input: { ExclusiveStartKey?: unknown };
}

interface SqsBatchCmd {
  __cmd: 'SendMessageBatch';
  input: {
    QueueUrl: string;
    Entries: Array<{ Id: string; MessageBody: string }>;
  };
}

describe('dispatcher lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fans out one SQS message per digest-enabled actor', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { actorId: { S: 'tiago' }, email: { S: 'tiago@example.com' }, timezone: { S: 'America/Los_Angeles' }, digestEnabled: { BOOL: true } },
        { actorId: { S: 'alice' }, digestEnabled: { BOOL: true } },
      ],
    });

    await handler();

    const batches = sqsSend.mock.calls.map((c) => c[0] as SqsBatchCmd);
    expect(batches).toHaveLength(1);
    const bodies = batches[0].input.Entries.map((e) => JSON.parse(e.MessageBody));
    expect(bodies).toHaveLength(2);
    expect(bodies).toContainEqual({ actorId: 'tiago', email: 'tiago@example.com', timezone: 'America/Los_Angeles' });
    expect(bodies).toContainEqual({ actorId: 'alice' });
  });

  it('skips actors with digestEnabled=false', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { actorId: { S: 'tiago' }, digestEnabled: { BOOL: true } },
        { actorId: { S: 'paused' }, digestEnabled: { BOOL: false } },
      ],
    });

    await handler();

    const batches = sqsSend.mock.calls.map((c) => c[0] as SqsBatchCmd);
    const bodies = batches.flatMap((b) => b.input.Entries.map((e) => JSON.parse(e.MessageBody)));
    expect(bodies.map((b) => b.actorId)).toEqual(['tiago']);
  });

  it('paginates the Scan and batches SQS sends in groups of 10', async () => {
    const firstPage = {
      Items: Array.from({ length: 10 }, (_, i) => ({
        actorId: { S: `a${i}` },
        digestEnabled: { BOOL: true },
      })),
      LastEvaluatedKey: { actorId: { S: 'a9' } },
    };
    const secondPage = {
      Items: Array.from({ length: 3 }, (_, i) => ({
        actorId: { S: `b${i}` },
        digestEnabled: { BOOL: true },
      })),
    };
    ddbSend.mockImplementationOnce(() => Promise.resolve(firstPage));
    ddbSend.mockImplementationOnce(() => Promise.resolve(secondPage));

    await handler();

    // Two ScanCommand calls (first + follow-up) verified by mock call count
    const scans = ddbSend.mock.calls.map((c) => c[0] as ScanCmd);
    expect(scans).toHaveLength(2);
    expect(scans[1].input.ExclusiveStartKey).toEqual({ actorId: { S: 'a9' } });

    // 13 actors → batch of 10 + batch of 3 → 2 SQS sends
    const batches = sqsSend.mock.calls.map((c) => c[0] as SqsBatchCmd);
    expect(batches).toHaveLength(2);
    expect(batches[0].input.Entries).toHaveLength(10);
    expect(batches[1].input.Entries).toHaveLength(3);
  });

  it('does nothing when no actors are enabled', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await handler();

    expect(sqsSend).not.toHaveBeenCalled();
  });
});
