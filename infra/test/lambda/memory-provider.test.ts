import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateMemory = vi.fn();
const mockGetMemory = vi.fn();
const mockDeleteMemory = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((command: any) => {
      if (command.constructor.name === 'CreateMemoryCommand') return mockCreateMemory(command.input);
      if (command.constructor.name === 'GetMemoryCommand') return mockGetMemory(command.input);
      if (command.constructor.name === 'DeleteMemoryCommand') return mockDeleteMemory(command.input);
    }),
  })),
  CreateMemoryCommand: vi.fn().mockImplementation((input: any) => ({ input, constructor: { name: 'CreateMemoryCommand' } })),
  GetMemoryCommand: vi.fn().mockImplementation((input: any) => ({ input, constructor: { name: 'GetMemoryCommand' } })),
  DeleteMemoryCommand: vi.fn().mockImplementation((input: any) => ({ input, constructor: { name: 'DeleteMemoryCommand' } })),
}));

import { handler } from '../../lambda/memory-provider/index';

describe('memory-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AWS_REGION = 'us-east-1';
  });

  it('creates memory with all strategies on CREATE', async () => {
    mockCreateMemory.mockResolvedValue({
      memory: { id: 'mem-123', status: 'CREATING' },
    });
    mockGetMemory.mockResolvedValue({
      memory: { id: 'mem-123', status: 'ACTIVE' },
    });

    const result = await handler({
      RequestType: 'Create',
      ResourceProperties: {
        memoryName: 'mnemo-memory',
        description: 'mnemo memory store',
        eventExpiryDuration: 90,
        snsTopicArn: 'arn:aws:sns:us-east-1:123456789:mnemo-topic',
        s3BucketName: 'mnemo-payload-bucket',
        actorId: 'tiago',
      },
    } as any);

    expect(result.PhysicalResourceId).toBe('mem-123');
    expect(result.Data.MemoryId).toBe('mem-123');
    expect(mockCreateMemory).toHaveBeenCalledOnce();
  });

  it('deletes memory on DELETE', async () => {
    mockDeleteMemory.mockResolvedValue({});

    const result = await handler({
      RequestType: 'Delete',
      PhysicalResourceId: 'mem-123',
      ResourceProperties: {},
    } as any);

    expect(result.PhysicalResourceId).toBe('mem-123');
    expect(mockDeleteMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: 'mem-123' })
    );
  });
});
