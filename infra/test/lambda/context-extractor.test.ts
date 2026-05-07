import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

const mockAgentCoreSend = vi.fn();
const mockBedrockSend = vi.fn();
const mockS3Send = vi.fn();

vi.hoisted(() => {
  process.env.MEMORY_ID = 'mem-123';
  process.env.ACTOR_ID = 'tiago';
});

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockAgentCoreSend(...args),
  })),
  BatchCreateMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'BatchCreate', input })),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Retrieve', input })),
  BatchDeleteMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'BatchDelete', input })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockBedrockSend(...args),
  })),
  InvokeModelCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockS3Send(...args),
  })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
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

const LLM_RESPONSE_FULL = `TASK: coding
FACTS:
Chose CDK over SAM for infrastructure
Using CfnMemory for AgentCore lifecycle
DAILY:
Worked on mnemo infrastructure, chose CDK over SAM, set up AgentCore Memory with CfnMemory construct`;

const LLM_RESPONSE_NO_PROJECT = `TASK: studying
FACTS:
Learning about distributed systems consensus protocols
DAILY:
Studied Raft consensus algorithm and compared with Paxos`;

const LLM_RESPONSE_NONE = `TASK: unknown
FACTS: NONE
DAILY: NONE`;

function makeS3Payload(sessionId: string, currentContext: unknown[]) {
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

interface BatchCreateInput {
  records: Array<{ namespaces: string[]; content: { text: string } }>;
}

describe('context-extractor lambda', () => {
  function getBatchCreateCalls(): BatchCreateInput[] {
    return mockAgentCoreSend.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((cmd) => (cmd as Record<string, unknown>)._type === 'BatchCreate')
      .map((cmd) => (cmd as Record<string, unknown>).input) as BatchCreateInput[];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ID = 'mem-123';
    process.env.ACTOR_ID = 'tiago';
    process.env.MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
    process.env.TASK_DOMAINS = 'coding,studying,meeting,general';
    mockAgentCoreSend.mockImplementation((cmd: Record<string, unknown>) => {
      if (cmd._type === 'Retrieve') {
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      return Promise.resolve({
        successfulRecords: [{ memoryRecordId: 'rec-1', status: 'SUCCEEDED' }],
        failedRecords: [],
      });
    });
  });

  it('parses JSON-formatted mnemo-context with commas in values', async () => {
    const meta = { project: 'mnemo, with comma', source: 'claude-code', workstation: 'mac=book', date: '2026-04-13' };
    const payload = makeS3Payload('session-json-meta', [
      { role: 'OTHER', content: { text: `[mnemo-context: ${JSON.stringify(meta)}]` } },
      { role: 'USER', content: { text: 'Working on mnemo' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls() as Array<{ records: Array<{ namespaces: string[] }> }>;
    const namespaces = creates.map((c) => c.records[0].namespaces[0]);
    // Project name "mnemo, with comma" gets sanitized to a filesystem-safe slug,
    // but the extractor must have *recognized* it as a project at all — which
    // the legacy comma-split parser couldn't have done.
    expect(namespaces.some((ns) => ns.startsWith('/projects/tiago/'))).toBe(true);
    expect(namespaces).toContain('/daily/tiago/2026-04-13/log/');
  });

  it('extracts project (from metadata), task, and daily memories', async () => {
    const payload = makeS3Payload('session-1', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=claude-code, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Working on mnemo, chose CDK over SAM' }, eventId: 'e1' },
      { role: 'ASSISTANT', content: { text: 'CDK is the right choice for this' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // 2 retrieves (project+task) + 3 creates (project+task consolidated, daily append-only)
    const creates = getBatchCreateCalls();
    expect(creates).toHaveLength(3);

    const namespaces = creates.map((c) => (c as BatchCreateInput).records[0].namespaces[0]);

    expect(namespaces).toContain('/projects/tiago/mnemo/');
    expect(namespaces).toContain('/tasks/tiago/coding/');
    expect(namespaces).toContain('/daily/tiago/2026-04-13/log/');
  });

  it('skips project write when no project in metadata', async () => {
    const payload = makeS3Payload('session-2', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=claude-code, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Explain the Raft consensus algorithm' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_NO_PROJECT));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // 1 retrieve (task only) + 2 creates (task consolidated, daily append-only)
    const creates = getBatchCreateCalls();
    expect(creates).toHaveLength(2);

    const namespaces = creates.map((c) => (c as BatchCreateInput).records[0].namespaces[0]);

    expect(namespaces).not.toEqual(expect.arrayContaining([expect.stringContaining('/projects/')]));
    expect(namespaces).toContain('/tasks/tiago/studying/');
    expect(namespaces).toEqual(expect.arrayContaining([expect.stringContaining('/daily/tiago/')]));
  });

  it('skips all writes when facts and daily are NONE', async () => {
    const payload = makeS3Payload('session-3', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=test, workstation=mac, date=2026-04-13]' } },
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
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=test, workstation=mac, date=2026-04-13]' } },
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

    const creates = getBatchCreateCalls();
    expect(creates).toHaveLength(3);
  });

  it('falls back to general when LLM returns unlisted task domain', async () => {
    const payload = makeS3Payload('session-fallback', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=test, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Planning a trip to Japan' }, eventId: 'e1' },
    ]);

    const llmResponse = `TASK: planning
FACTS:
Planning a trip to Japan in November
DAILY:
Discussed travel plans for Japan`;

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(llmResponse));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // 1 retrieve (task) + 2 creates (task consolidated, daily append-only)
    const creates = getBatchCreateCalls();
    expect(creates).toHaveLength(2);

    const namespaces = creates.map((c) => (c as BatchCreateInput).records[0].namespaces[0]);

    expect(namespaces).toContain('/tasks/tiago/general/');
    expect(namespaces).not.toEqual(expect.arrayContaining([expect.stringContaining('/planning/')]));
  });

  it('uses metadata date over payload timestamp', async () => {
    const payload = makeS3Payload('session-6', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=test, workstation=mac, date=2026-04-15]' } },
      { role: 'USER', content: { text: 'Working on mnemo' }, eventId: 'e1' },
    ]);
    // Payload timestamp is 2026-04-13, but metadata date is 2026-04-15
    payload.startingTimestamp = 1776081600000;

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    const dailyCall = creates.find((c) => c.records[0].namespaces[0].includes('/daily/')) as BatchCreateInput;
    // Should use metadata date (2026-04-15), not payload timestamp (2026-04-13)
    expect(dailyCall.records[0].namespaces[0]).toBe('/daily/tiago/2026-04-15/log/');
  });

  it('falls back to payload timestamp when no metadata date', async () => {
    const payload = makeS3Payload('session-7', [
      { role: 'USER', content: { text: 'Working on something' }, eventId: 'e1' },
    ]);
    payload.startingTimestamp = 1776081600000; // 2026-04-13

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    const dailyCall = creates.find((c) => c.records[0].namespaces[0].includes('/daily/')) as BatchCreateInput;
    expect(dailyCall.records[0].namespaces[0]).toBe('/daily/tiago/2026-04-13/log/');
  });

  it('logs and swallows permanent S3 errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockS3Send.mockRejectedValue(new Error('NoSuchKey: The specified key does not exist'));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/missing.json')));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Context extraction failed'),
      expect.objectContaining({ error: expect.stringContaining('NoSuchKey') }),
    );
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('rethrows throttling errors for SNS retry', async () => {
    const payload = makeS3Payload('session-throttle', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=test, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Some conversation' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    const throttleError = new Error('Rate exceeded');
    throttleError.name = 'ThrottlingException';
    mockBedrockSend.mockRejectedValue(throttleError);

    await expect(
      handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')))
    ).rejects.toThrow('Rate exceeded');
  });

  it('excludes mnemo-context line from conversation text sent to LLM', async () => {
    const payload = makeS3Payload('session-8', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=test, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Hello' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // Verify LLM was called and conversation doesn't contain mnemo-context
    const llmCall = mockBedrockSend.mock.calls[0][0];
    const llmBody = JSON.parse(llmCall.input.body);
    const llmContent = llmBody.messages[0].content;

    expect(llmContent).not.toContain('[mnemo-context:');
    expect(llmContent).toContain('USER: Hello');
    // But the prompt should include known context from metadata
    expect(llmContent).toContain('Project: mnemo');
  });

  it('parses attributes from mnemo-context JSON metadata', async () => {
    const meta = {
      project: 'mnemo',
      source: 'claude-code',
      workstation: 'mac',
      date: '2026-04-16',
      attributes: { owner: 'tiago', priority: 'high' },
    };
    const payload = makeS3Payload('session-attrs', [
      { role: 'OTHER', content: { text: `[mnemo-context: ${JSON.stringify(meta)}]` } },
      { role: 'USER', content: { text: 'Working on stuff' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await expect(
      handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')))
    ).resolves.toBeUndefined();

    const creates = getBatchCreateCalls();
    const namespaces = creates.map((c) => c.records[0].namespaces[0]);
    expect(namespaces).toContain('/projects/tiago/mnemo/');
  });

  it('consolidates with existing records when present', async () => {
    const existingRecords = [
      { memoryRecordId: 'old-1', content: { text: 'CDK was chosen over SAM' }, score: 0.9 },
      { memoryRecordId: 'old-2', content: { text: 'Using CfnMemory for lifecycle' }, score: 0.8 },
    ];

    mockAgentCoreSend.mockImplementation((cmd: Record<string, unknown>) => {
      if (cmd._type === 'Retrieve') {
        // Only return existing records for project namespace
        const input = cmd.input as Record<string, unknown>;
        if ((input.namespace as string)?.includes('/projects/')) {
          return Promise.resolve({ memoryRecordSummaries: existingRecords });
        }
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      return Promise.resolve({
        successfulRecords: [{ memoryRecordId: 'rec-new', status: 'SUCCEEDED' }],
        failedRecords: [],
      });
    });

    const payload = makeS3Payload('session-consolidate', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=claude-code, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Added memory consolidation to context extractor' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    const CONSOLIDATED_RESPONSE = 'CDK was chosen over SAM\nUsing CfnMemory for lifecycle\nAdded memory consolidation to context extractor';

    // The extractor runs callLlm and callAboutLlm in parallel, so routing by
    // call order is racy. Route by prompt content instead: the about pass
    // identifies itself by its prompt header, main extraction by TASK format,
    // consolidation by the "EXISTING RECORDS" block.
    mockBedrockSend.mockImplementation((cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      if (prompt.includes('biographical facts about the person')) {
        // About pass — return a NONE response so we don't trigger an about write
        return Promise.resolve(mockLlmResponse('ABOUT: NONE'));
      }
      if (prompt.includes('EXISTING RECORDS')) {
        return Promise.resolve(mockLlmResponse(CONSOLIDATED_RESPONSE));
      }
      return Promise.resolve(mockLlmResponse(LLM_RESPONSE_FULL));
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // LLM called: 1 main extraction + 1 about extraction + 1 consolidation
    // (only the project namespace has existing records in this test)
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);

    // Find the consolidation call by prompt content
    const consolidationCall = mockBedrockSend.mock.calls.find((args) => {
      const prompt = JSON.parse((args[0] as { input: { body: string } }).input.body).messages[0].content as string;
      return prompt.includes('EXISTING RECORDS');
    });
    const consolidationContent = JSON.parse((consolidationCall![0] as { input: { body: string } }).input.body).messages[0].content as string;
    expect(consolidationContent).toContain('CDK was chosen over SAM');
    expect(consolidationContent).toContain('Using CfnMemory for lifecycle');
    expect(consolidationContent).toContain('EXISTING RECORDS');

    // Verify old records were deleted
    const deleteCalls = mockAgentCoreSend.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((cmd) => (cmd as Record<string, unknown>)._type === 'BatchDelete') as Array<Record<string, unknown>>;
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0].input as Record<string, unknown>).records).toEqual([
      { memoryRecordId: 'old-1' },
      { memoryRecordId: 'old-2' },
    ]);

    // Verify consolidated content was written
    const creates = getBatchCreateCalls();
    const projectCreate = creates.find((c) => c.records[0].namespaces[0].includes('/projects/')) as BatchCreateInput;
    expect(projectCreate.records[0].content.text).toBe(CONSOLIDATED_RESPONSE);
  });

  it('aborts consolidation write and preserves existing records when LLM output is truncated', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const existingRecords = [
      { memoryRecordId: 'old-1', content: { text: 'Existing important fact' }, score: 0.9 },
    ];

    mockAgentCoreSend.mockImplementation((cmd: Record<string, unknown>) => {
      if (cmd._type === 'Retrieve') {
        const input = cmd.input as Record<string, unknown>;
        if ((input.namespace as string)?.includes('/tasks/')) {
          return Promise.resolve({ memoryRecordSummaries: existingRecords });
        }
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      return Promise.resolve({
        successfulRecords: [{ memoryRecordId: 'rec-new', status: 'SUCCEEDED' }],
        failedRecords: [],
      });
    });

    const payload = makeS3Payload('session-truncated', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=openclaw:telegram, workstation=linux, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'Tell me about Bloom filters' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    let llmCallCount = 0;
    mockBedrockSend.mockImplementation(() => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return Promise.resolve(mockLlmResponse(LLM_RESPONSE_NO_PROJECT));
      }
      // Consolidation response: truncated (stop_reason: max_tokens)
      return Promise.resolve({
        body: new TextEncoder().encode(
          JSON.stringify({
            content: [{ type: 'text', text: 'Truncated content...' }],
            stop_reason: 'max_tokens',
          })
        ),
      });
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // Error should have been logged (triggers alarm)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Context extraction failed'),
      expect.objectContaining({
        error: expect.stringContaining('max_tokens'),
        name: 'ConsolidationTruncatedError',
      }),
    );

    // No deletes should have happened — existing records preserved
    const deleteCalls = mockAgentCoreSend.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((cmd) => (cmd as Record<string, unknown>)._type === 'BatchDelete');
    expect(deleteCalls).toHaveLength(0);

    // No consolidated write to the task namespace should have happened
    const taskCreates = getBatchCreateCalls()
      .filter((c) => c.records[0].namespaces[0].includes('/tasks/'));
    expect(taskCreates).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  it('does not rethrow truncation errors (they are permanent, not retryable)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const existingRecords = [
      { memoryRecordId: 'old-1', content: { text: 'Existing fact' }, score: 0.9 },
    ];

    mockAgentCoreSend.mockImplementation((cmd: Record<string, unknown>) => {
      if (cmd._type === 'Retrieve') {
        return Promise.resolve({ memoryRecordSummaries: existingRecords });
      }
      return Promise.resolve({
        successfulRecords: [{ memoryRecordId: 'rec-new', status: 'SUCCEEDED' }],
        failedRecords: [],
      });
    });

    const payload = makeS3Payload('session-no-rethrow', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=test, workstation=mac, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'Some conversation' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    let llmCallCount = 0;
    mockBedrockSend.mockImplementation(() => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return Promise.resolve(mockLlmResponse(LLM_RESPONSE_FULL));
      }
      return Promise.resolve({
        body: new TextEncoder().encode(
          JSON.stringify({
            content: [{ type: 'text', text: 'Truncated...' }],
            stop_reason: 'max_tokens',
          })
        ),
      });
    });

    // Should NOT throw — truncation is a permanent error, swallowed after logging
    await expect(
      handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')))
    ).resolves.toBeUndefined();
  });

  it('truncates record content that exceeds AgentCore 16K limit', async () => {
    const payload = makeS3Payload('session-large', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=test, workstation=mac, date=2026-04-13]' } },
      { role: 'USER', content: { text: 'Working on something' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    const oversizedFacts = 'x'.repeat(20_000);
    const llmResponse = `TASK: coding\nFACTS:\n${oversizedFacts}\nDAILY:\nWorked on stuff`;
    mockBedrockSend.mockResolvedValue(mockLlmResponse(llmResponse));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    for (const create of creates) {
      expect(create.records[0].content.text.length).toBeLessThanOrEqual(16_000);
    }
  });

  it('uses actorId from the S3 payload (not env) so multiple actors share one stack', async () => {
    const payload = makeS3Payload('session-env', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=test, workstation=mac, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'Working on mnemo' }, eventId: 'e1' },
    ]);
    payload.actorId = 'alice';

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    const namespaces = creates.map((c) => c.records[0].namespaces[0]);
    expect(namespaces.every((ns) => ns.includes('/alice/'))).toBe(true);
    expect(namespaces.some((ns) => ns.includes('/tiago/'))).toBe(false);
  });

  it('skips extraction when payload has no actorId', async () => {
    const payload = makeS3Payload('session-no-actor', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'Working on mnemo' }, eventId: 'e1' },
    ]);
    delete (payload as { actorId?: string }).actorId;

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });
    mockBedrockSend.mockResolvedValue(mockLlmResponse(LLM_RESPONSE_FULL));

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    expect(creates).toHaveLength(0);
  });

  it('writes an about record when the about extractor returns content', async () => {
    const payload = makeS3Payload('session-about', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=claude-code, date=2026-04-16]' } },
      { role: 'USER', content: { text: "I'm a principal engineer at Amazon, working on memory systems." }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    mockBedrockSend.mockImplementation((cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      if (prompt.includes('biographical facts about the person')) {
        return Promise.resolve(mockLlmResponse('ABOUT:\nTiago is a principal engineer at Amazon.\nWorks on memory systems.'));
      }
      return Promise.resolve(mockLlmResponse(LLM_RESPONSE_NO_PROJECT));
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    const aboutWrite = creates.find((c) => c.records[0].namespaces[0] === '/about/tiago/');
    expect(aboutWrite).toBeDefined();
    expect(aboutWrite!.records[0].content.text).toContain('principal engineer');
  });

  it('skips about write when the about extractor returns NONE', async () => {
    const payload = makeS3Payload('session-about-none', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=claude-code, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'Need to fix this bug real quick' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    mockBedrockSend.mockImplementation((cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      if (prompt.includes('biographical facts about the person')) {
        return Promise.resolve(mockLlmResponse('ABOUT: NONE'));
      }
      return Promise.resolve(mockLlmResponse(LLM_RESPONSE_NO_PROJECT));
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    expect(creates.find((c) => c.records[0].namespaces[0].startsWith('/about/'))).toBeUndefined();
  });

  it('skips about write when the response has no ABOUT marker', async () => {
    // Guards against an LLM that ignores the format and spits prose directly.
    const payload = makeS3Payload('session-about-malformed', [
      { role: 'OTHER', content: { text: '[mnemo-context: source=claude-code, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'hello' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    mockBedrockSend.mockImplementation((cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      if (prompt.includes('biographical facts about the person')) {
        return Promise.resolve(mockLlmResponse('I cannot find any biographical information in this conversation.'));
      }
      return Promise.resolve(mockLlmResponse(LLM_RESPONSE_NO_PROJECT));
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    const creates = getBatchCreateCalls();
    expect(creates.find((c) => c.records[0].namespaces[0].startsWith('/about/'))).toBeUndefined();
  });

  it('runs about extraction in parallel with main extraction', async () => {
    const payload = makeS3Payload('session-parallel', [
      { role: 'OTHER', content: { text: '[mnemo-context: project=mnemo, source=claude-code, date=2026-04-16]' } },
      { role: 'USER', content: { text: 'Working on mnemo, also I lead the platform team.' }, eventId: 'e1' },
    ]);

    mockS3Send.mockResolvedValue({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(payload)) },
    });

    mockBedrockSend.mockImplementation((cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      if (prompt.includes('biographical facts about the person')) {
        return Promise.resolve(mockLlmResponse('ABOUT:\nTiago leads the platform team.'));
      }
      return Promise.resolve(mockLlmResponse(LLM_RESPONSE_FULL));
    });

    await handler(makeSnsEvent(makeSnsMessage('s3://bucket/payload.json')));

    // Two extraction calls (one main, one about) both fire before any writes.
    // We assert on the count rather than ordering since parallel scheduling
    // is non-deterministic.
    const bedrockCalls = mockBedrockSend.mock.calls.map((args) => {
      const prompt = JSON.parse((args[0] as { input: { body: string } }).input.body).messages[0].content as string;
      return prompt.includes('biographical facts about the person') ? 'about' : 'main';
    });
    expect(bedrockCalls.filter((c) => c === 'main')).toHaveLength(1);
    expect(bedrockCalls.filter((c) => c === 'about')).toHaveLength(1);

    // Both pipelines produced writes
    const creates = getBatchCreateCalls();
    expect(creates.find((c) => c.records[0].namespaces[0] === '/about/tiago/')).toBeDefined();
    expect(creates.find((c) => c.records[0].namespaces[0] === '/projects/tiago/mnemo/')).toBeDefined();
  });
});
