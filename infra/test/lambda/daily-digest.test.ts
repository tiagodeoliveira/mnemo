import { describe, it, expect, vi, beforeEach } from 'vitest';

const agentcoreSend = vi.fn();
const bedrockSend = vi.fn();
const sesSend = vi.fn();

vi.hoisted(() => {
  process.env.MEMORY_ID = 'mem-123';
  process.env.ACTOR_ID = 'tiago';
});

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (cmd: unknown) => agentcoreSend(cmd),
  })),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'Retrieve', input })),
  BatchCreateMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'BatchCreate', input })),
  BatchDeleteMemoryRecordsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'BatchDelete', input })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: (cmd: unknown) => bedrockSend(cmd),
  })),
  InvokeModelCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'InvokeModel', input })),
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({
    send: (cmd: unknown) => sesSend(cmd),
  })),
  SendEmailCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'SendEmail', input })),
}));

import { handler } from '../../lambda/daily-digest/index';

interface MockCmd {
  __cmd: 'Retrieve' | 'BatchCreate' | 'BatchDelete' | 'InvokeModel' | 'SendEmail';
  input: {
    namespace?: string;
    records?: Array<{ memoryRecordId: string }>;
  };
}

function mockBedrockDigest(text: string): void {
  const body = new TextEncoder().encode(JSON.stringify({ content: [{ text }] }));
  bedrockSend.mockResolvedValueOnce({ body });
}

describe('daily-digest write-then-delete ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACTOR_ID = 'tiago';
    process.env.MEMORY_ID = 'mem-123';
    process.env.DIGEST_TIMEZONE = 'UTC';
    delete process.env.DIGEST_EMAIL_FROM;
    delete process.env.DIGEST_EMAIL_TO;
  });

  it('does not delete stale summaries when the write fails, preserving prior day', async () => {
    agentcoreSend.mockImplementation((cmd: MockCmd) => {
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/log/')) {
        return Promise.resolve({
          memoryRecordSummaries: [
            { memoryRecordId: 'log-1', content: { text: 'worked on thing A' }, createdAt: '2026-04-15T10:00:00Z' },
          ],
        });
      }
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/summary/')) {
        return Promise.resolve({
          memoryRecordSummaries: [{ memoryRecordId: 'old-summary-1' }],
        });
      }
      if (cmd.__cmd === 'BatchCreate') {
        return Promise.reject(new Error('ThrottlingException: too many writes'));
      }
      if (cmd.__cmd === 'BatchDelete') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockBedrockDigest('## Today\n- did work');

    await expect(handler()).rejects.toThrow('ThrottlingException');

    const deleteCalls = agentcoreSend.mock.calls.filter((args) => (args[0] as MockCmd).__cmd === 'BatchDelete');
    expect(deleteCalls).toHaveLength(0);
  });

  it('SES email failure still writes summary to memory and does not crash', async () => {
    process.env.DIGEST_EMAIL_FROM = 'from@example.com';
    process.env.DIGEST_EMAIL_TO = 'to@example.com';

    const callOrder: string[] = [];
    agentcoreSend.mockImplementation((cmd: MockCmd) => {
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/log/')) {
        return Promise.resolve({
          memoryRecordSummaries: [
            { memoryRecordId: 'log-1', content: { text: 'shipped feature X' }, createdAt: '2026-04-16T09:00:00Z' },
          ],
        });
      }
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/summary/')) {
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      if (cmd.__cmd === 'BatchCreate') {
        callOrder.push('BatchCreate');
        return Promise.resolve({});
      }
      if (cmd.__cmd === 'BatchDelete') {
        callOrder.push('BatchDelete');
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    sesSend.mockRejectedValueOnce(new Error('MessageRejected: Email address not verified'));

    mockBedrockDigest('## Projects\n- shipped feature X');

    // handler must NOT throw even though SES failed
    await handler();

    // Summary was written to memory
    expect(callOrder).toContain('BatchCreate');

    // SES was called (and failed)
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it('handles empty digest gracefully when no log entries exist', async () => {
    agentcoreSend.mockImplementation((cmd: MockCmd) => {
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/log/')) {
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      return Promise.resolve({});
    });

    await handler();

    // No Bedrock call for digest generation
    expect(bedrockSend).not.toHaveBeenCalled();

    // No summary write or delete
    const batchCalls = agentcoreSend.mock.calls.filter(
      (args) => (args[0] as MockCmd).__cmd === 'BatchCreate' || (args[0] as MockCmd).__cmd === 'BatchDelete'
    );
    expect(batchCalls).toHaveLength(0);
  });

  it('throws when digest generation hits max_tokens to prevent truncated summaries', async () => {
    agentcoreSend.mockImplementation((cmd: MockCmd) => {
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/log/')) {
        return Promise.resolve({
          memoryRecordSummaries: [
            { memoryRecordId: 'log-1', content: { text: 'worked on thing A' }, createdAt: '2026-04-16T10:00:00Z' },
          ],
        });
      }
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/summary/')) {
        return Promise.resolve({ memoryRecordSummaries: [] });
      }
      return Promise.resolve({});
    });

    const body = new TextEncoder().encode(JSON.stringify({
      content: [{ text: 'Truncated digest...' }],
      stop_reason: 'max_tokens',
    }));
    bedrockSend.mockResolvedValueOnce({ body });

    await expect(handler()).rejects.toThrow('max_tokens');

    const batchCalls = agentcoreSend.mock.calls.filter(
      (args) => (args[0] as MockCmd).__cmd === 'BatchCreate' || (args[0] as MockCmd).__cmd === 'BatchDelete'
    );
    expect(batchCalls).toHaveLength(0);
  });

  it('handles AgentCore read failure gracefully and skips digest', async () => {
    agentcoreSend.mockImplementation((cmd: MockCmd) => {
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/log/')) {
        return Promise.reject(new Error('ServiceUnavailableException: internal error'));
      }
      return Promise.resolve({});
    });

    // Should not throw; readLogRecords catches and returns []
    await handler();

    // No digest generated because logs came back empty after the catch
    expect(bedrockSend).not.toHaveBeenCalled();

    // No summary write or delete
    const batchCalls = agentcoreSend.mock.calls.filter(
      (args) => (args[0] as MockCmd).__cmd === 'BatchCreate' || (args[0] as MockCmd).__cmd === 'BatchDelete'
    );
    expect(batchCalls).toHaveLength(0);
  });

  it('deletes stale summaries only after a successful write', async () => {
    const callOrder: string[] = [];
    agentcoreSend.mockImplementation((cmd: MockCmd) => {
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/log/')) {
        return Promise.resolve({
          memoryRecordSummaries: [
            { memoryRecordId: 'log-1', content: { text: 'worked on thing A' }, createdAt: '2026-04-15T10:00:00Z' },
          ],
        });
      }
      if (cmd.__cmd === 'Retrieve' && cmd.input.namespace?.endsWith('/summary/')) {
        return Promise.resolve({
          memoryRecordSummaries: [{ memoryRecordId: 'old-summary-1' }],
        });
      }
      if (cmd.__cmd === 'BatchCreate') {
        callOrder.push('BatchCreate');
        return Promise.resolve({});
      }
      if (cmd.__cmd === 'BatchDelete') {
        callOrder.push('BatchDelete');
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockBedrockDigest('## Today\n- did work');

    await handler();

    expect(callOrder).toEqual(['BatchCreate', 'BatchDelete']);
    const deleteCall = agentcoreSend.mock.calls.find((args) => (args[0] as MockCmd).__cmd === 'BatchDelete');
    expect((deleteCall?.[0] as MockCmd | undefined)?.input.records).toEqual([{ memoryRecordId: 'old-summary-1' }]);
  });
});
