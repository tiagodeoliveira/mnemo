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

import { handler } from '../../lambda/context-extractor/index';

function makeSnsEvent(message: object): SNSEvent {
  return {
    Records: [
      {
        Sns: {
          Message: JSON.stringify(message),
          MessageId: 'msg-1',
          TopicArn: 'arn:aws:sns:us-east-1:123:topic',
          Timestamp: '2026-04-13T14:00:00Z',
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

const LLM_RESPONSE_FULL = `PROJECT: mnemo
TASK: coding
FACTS:
Chose CDK over SAM for infrastructure
Using CfnMemory for AgentCore lifecycle
DAILY:
Worked on mnemo infrastructure, chose CDK over SAM, set up AgentCore Memory with CfnMemory construct`;

const LLM_RESPONSE_NO_PROJECT = `PROJECT: unknown
TASK: studying
FACTS:
Learning about distributed systems consensus protocols
DAILY:
Studied Raft consensus algorithm and compared with Paxos`;

const LLM_RESPONSE_NONE = `PROJECT: unknown
TASK: unknown
FACTS: NONE
DAILY: NONE`;

function makeS3Payload(sessionId: string, currentContext: any[]) {
  return {
    requestId: 'req-1',
    accountId: '123456789',
    memoryId: 'mem-123',
    actorId: 'tiago',
    sessionId,
    strategyId: 'ProjectContext-abc',
    startingTimestamp: 1776081600000,
    endingTimestamp: 1776081612000,
    currentContext,
  };
}

function mockLlmResponse(text: string) {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({ content: [{ type: 'text', text }] })
    ),
  };
}

function makeSnsMessage(s3Uri: string) {
  return {
    jobId: 'job-1',
    s3PayloadLocation: s3Uri,
    memoryId: 'mem-123',
    strategyId: 'strat-1',
  };
}

describe('context-extractor lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    process.env.MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
    mockAgentCoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: 'rec-1', status: 'SUCCEEDED' }],
      failedRecords: [],
    });
  });

  it('extracts project, task, and daily memories from conversation', async () => {
    const payload = makeS3Payload('session-1', [
      { role: 'USER', content: { text: 'Working on mnemo, chose CDK over SAM' }, eventId: 'e1' },
      { role: 'ASSISTANT', content: { text: 'CDK is the right choice for this' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // Should write 3 records: project, task, daily
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(3);

    const calls = mockAgentCoreSend.mock.calls.map((c: any) => c[0].input);
    const namespaces = calls.map((c: any) => c.records[0].namespaces[0]);

    expect(namespaces).toContain('/projects/tiago/mnemo/');
    expect(namespaces).toContain('/tasks/tiago/coding/');
    expect(namespaces).toContain('/daily/tiago/2026-04-13/');
  });

  it('skips project write when project is unknown', async () => {
    const payload = makeS3Payload('session-2', [
      { role: 'USER', content: { text: 'Explain the Raft consensus algorithm' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_NO_PROJECT));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // Should write 2 records: task + daily (no project)
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(2);

    const calls = mockAgentCoreSend.mock.calls.map((c: any) => c[0].input);
    const namespaces = calls.map((c: any) => c.records[0].namespaces[0]);

    expect(namespaces).not.toEqual(expect.arrayContaining([expect.stringContaining('/projects/')]));
    expect(namespaces).toContain('/tasks/tiago/studying/');
    expect(namespaces).toEqual(expect.arrayContaining([expect.stringContaining('/daily/tiago/')]));
  });

  it('skips all writes when facts and daily are NONE', async () => {
    const payload = makeS3Payload('session-3', [
      { role: 'USER', content: { text: 'hello' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_NONE));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  it('skips when conversation is empty', async () => {
    const payload = makeS3Payload('session-4', []);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
  });

  it('parses S3 URI correctly', async () => {
    const payload = makeS3Payload('session-5', [
      { role: 'USER', content: { text: 'Working on mnemo CDK stack' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://my-bucket/path/to/payload.json')));

    const s3Cmd = mockS3Send.mock.calls[0][0];
    expect(s3Cmd.input.Bucket).toBe('my-bucket');
    expect(s3Cmd.input.Key).toBe('path/to/payload.json');
  });

  it('derives date from payload timestamps', async () => {
    const payload = makeS3Payload('session-6', [
      { role: 'USER', content: { text: 'Working on mnemo' }, eventId: 'e1' },
    ]);
    payload.startingTimestamp = 1776081600000; // 2026-04-13T12:00:00Z

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const calls = mockAgentCoreSend.mock.calls.map((c: any) => c[0].input);
    const dailyCall = calls.find((c: any) => c.records[0].namespaces[0].includes('/daily/'));
    expect(dailyCall.records[0].namespaces[0]).toBe('/daily/tiago/2026-04-13/');
  });
});
