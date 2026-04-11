import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

const mockAgentCoreSend = vi.fn();
const mockBedrockSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (...args: any[]) => mockAgentCoreSend(...args),
  })),
  BatchCreateMemoryRecordsCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: (...args: any[]) => mockBedrockSend(...args),
  })),
  InvokeModelCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: (...args: any[]) => mockS3Send(...args),
  })),
  GetObjectCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

import { handler } from '../../lambda/project-extractor/index';

function makeSnsEvent(message: object): SNSEvent {
  return {
    Records: [
      {
        Sns: {
          Message: JSON.stringify(message),
          MessageId: 'msg-1',
          TopicArn: 'arn:aws:sns:us-east-1:123:topic',
          Timestamp: '2026-04-10T14:00:00Z',
          Subject: '',
          Type: 'Notification',
          SignatureVersion: '1',
          Signature: '',
          SigningCertUrl: '',
          UnsubscribeUrl: '',
          MessageAttributes: {},
        },
        EventSource: 'aws:sns',
        EventSubscriptionArn: '',
        EventVersion: '1.0',
      },
    ],
  };
}

describe('project-extractor lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    process.env.MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
  });

  it('extracts project context and writes memory records', async () => {
    const s3Payload = {
      requestId: 'req-1',
      accountId: '123456789',
      memoryId: 'mem-123',
      actorId: 'tiago',
      sessionId: 'session-1',
      strategyId: 'ProjectContext-abc',
      currentContext: [
        { role: 'USER', content: { text: 'Use DynamoDB for storage in the mnemo project' }, eventId: 'e1' },
        { role: 'ASSISTANT', content: { text: 'Good choice for single-table design' }, eventId: 'e1' },
      ],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'PROJECT: mnemo\nFACTS:\nDecision: Use DynamoDB single-table design for storage.',
            },
          ],
        })
      ),
    });

    mockAgentCoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: 'rec-1', status: 'SUCCEEDED' }],
      failedRecords: [],
    });

    await handler(
      makeSnsEvent({
        jobId: 'mem-123/ProjectContext-abc/tiago/session-1/123_req.json',
        s3PayloadLocation: 's3://payload-bucket/payloads/123.json',
        memoryId: 'mem-123',
        strategyId: 'ProjectContext-abc',
      })
    );

    expect(mockS3Send).toHaveBeenCalledOnce();
    expect(mockBedrockSend).toHaveBeenCalledOnce();
    expect(mockAgentCoreSend).toHaveBeenCalledOnce();

    const batchCmd = mockAgentCoreSend.mock.calls[0][0];
    expect(batchCmd.input.records[0].namespaces).toContain('/projects/tiago/mnemo/');
  });

  it('skips when LLM returns NONE for facts', async () => {
    const s3Payload = {
      actorId: 'tiago',
      memoryId: 'mem-123',
      sessionId: 'session-1',
      currentContext: [{ role: 'USER', content: { text: 'hello' }, eventId: 'e1' }],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: 'text', text: 'PROJECT: unknown\nFACTS: NONE' }],
        })
      ),
    });

    await handler(
      makeSnsEvent({
        jobId: 'job-1',
        s3PayloadLocation: 's3://bucket/key.json',
        memoryId: 'mem-123',
        strategyId: 'strat-1',
      })
    );

    expect(mockBedrockSend).toHaveBeenCalledOnce();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  it('skips when conversation is empty', async () => {
    const s3Payload = {
      actorId: 'tiago',
      memoryId: 'mem-123',
      sessionId: 'session-1',
      currentContext: [],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    await handler(
      makeSnsEvent({
        jobId: 'job-1',
        s3PayloadLocation: 's3://bucket/key.json',
        memoryId: 'mem-123',
        strategyId: 'strat-1',
      })
    );

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  it('parses S3 URI correctly from SNS message', async () => {
    const s3Payload = {
      actorId: 'tiago',
      memoryId: 'mem-123',
      sessionId: 'session-1',
      currentContext: [
        { role: 'USER', content: { text: 'Working on mnemo, chose CDK over SAM' }, eventId: 'e1' },
      ],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: 'text', text: 'PROJECT: mnemo\nFACTS:\nChose CDK over SAM for infrastructure' }],
        })
      ),
    });

    mockAgentCoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: 'rec-1', status: 'SUCCEEDED' }],
      failedRecords: [],
    });

    await handler(
      makeSnsEvent({
        jobId: 'job-1',
        s3PayloadLocation: 's3://my-bucket/path/to/payload.json',
        memoryId: 'mem-123',
        strategyId: 'strat-1',
      })
    );

    const s3Cmd = mockS3Send.mock.calls[0][0];
    expect(s3Cmd.input.Bucket).toBe('my-bucket');
    expect(s3Cmd.input.Key).toBe('path/to/payload.json');
  });
});
