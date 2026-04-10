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
      events: [
        {
          payload: [
            { conversational: { content: { text: 'Use DynamoDB for storage' }, role: 'USER' } },
            { conversational: { content: { text: 'Good choice for single-table design' }, role: 'ASSISTANT' } },
          ],
          metadata: {
            project: { stringValue: 'mnemo' },
          },
        },
      ],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: 'text', text: 'Decision: Use DynamoDB single-table design for storage.' }],
        })
      ),
    });

    mockAgentCoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: 'rec-1', status: 'SUCCEEDED' }],
      failedRecords: [],
    });

    await handler(makeSnsEvent({ bucketName: 'payload-bucket', key: 'payloads/123.json' }));

    expect(mockS3Send).toHaveBeenCalledOnce();
    expect(mockBedrockSend).toHaveBeenCalledOnce();
    expect(mockAgentCoreSend).toHaveBeenCalledOnce();

    const batchCmd = mockAgentCoreSend.mock.calls[0][0];
    expect(batchCmd.input.records[0].namespaces).toContain('/projects/tiago/mnemo/');
  });

  it('skips when no project metadata in events', async () => {
    const s3Payload = {
      events: [
        {
          payload: [{ conversational: { content: { text: 'hello' }, role: 'USER' } }],
          metadata: {},
        },
      ],
    };

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(s3Payload)) },
    });

    await handler(makeSnsEvent({ bucketName: 'bucket', key: 'key.json' }));

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });
});
