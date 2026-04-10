import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.hoisted(() => {
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCOUNT_ID = '123456789012';
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockSend(...args),
  })),
  CreateLogGroupCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'CreateLogGroup', input })),
  PutDeliverySourceCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'PutDeliverySource', input })),
  PutDeliveryDestinationCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'PutDeliveryDestination', input })),
  CreateDeliveryCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'CreateDelivery', input })),
  DeleteDeliveryCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'DeleteDelivery', input })),
  DeleteDeliverySourceCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'DeleteDeliverySource', input })),
  DescribeDeliveriesCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'DescribeDeliveries', input })),
}));

import { handler } from '../../lambda/observability-setup/index';

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, string>;
}

function makeEvent(overrides: Partial<CfnEvent> & Pick<CfnEvent, 'RequestType'>): CfnEvent {
  return {
    ResourceProperties: {
      memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-abc',
      memoryName: 'test-memory',
    },
    ...overrides,
  };
}

function cmdType(call: unknown[]): string {
  return (call[0] as Record<string, unknown>)._type as string;
}

function cmdInput(call: unknown[]): Record<string, unknown> {
  return (call[0] as Record<string, unknown>).input as Record<string, unknown>;
}

describe('observability-setup lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';

    mockSend.mockImplementation((cmd: Record<string, unknown>) => {
      switch (cmd._type) {
        case 'PutDeliveryDestination':
          return Promise.resolve({
            deliveryDestination: {
              arn: 'arn:aws:logs:us-east-1:123456789012:delivery-destination:test-dest',
            },
          });
        case 'DescribeDeliveries':
          return Promise.resolve({ deliveries: [], nextToken: undefined });
        default:
          return Promise.resolve({});
      }
    });
  });

  describe('Create event', () => {
    it('creates log group, delivery sources, destinations, and deliveries', async () => {
      const result = await handler(makeEvent({ RequestType: 'Create' }));

      expect(result.PhysicalResourceId).toBe('test-memory-observability');
      expect(result.Data.LogGroup).toBe(
        '/aws/vendedlogs/bedrock-agentcore/memory/test-memory/APPLICATION_LOGS'
      );

      const types = mockSend.mock.calls.map(cmdType);

      // Should create log group
      expect(types.filter((t) => t === 'CreateLogGroup')).toHaveLength(1);
      // Should create two delivery sources (app-logs + traces)
      expect(types.filter((t) => t === 'PutDeliverySource')).toHaveLength(2);
      // Should create two delivery destinations (app-logs-dest + traces-dest)
      expect(types.filter((t) => t === 'PutDeliveryDestination')).toHaveLength(2);
      // Should create two deliveries
      expect(types.filter((t) => t === 'CreateDelivery')).toHaveLength(2);
    });

    it('passes correct parameters to delivery source commands', async () => {
      await handler(makeEvent({ RequestType: 'Create' }));

      const sourceCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'PutDeliverySource')
        .map(cmdInput);

      expect(sourceCalls[0]).toEqual({
        name: 'mnemo-test-memory-app-logs',
        logType: 'APPLICATION_LOGS',
        resourceArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-abc',
      });
      expect(sourceCalls[1]).toEqual({
        name: 'mnemo-test-memory-traces',
        logType: 'TRACES',
        resourceArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-abc',
      });
    });

    it('passes correct parameters to delivery destination for app logs', async () => {
      await handler(makeEvent({ RequestType: 'Create' }));

      const destCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'PutDeliveryDestination')
        .map(cmdInput);

      // First destination: app logs to CloudWatch log group
      expect(destCalls[0]).toEqual({
        name: 'mnemo-test-memory-app-logs-dest',
        deliveryDestinationConfiguration: {
          destinationResourceArn:
            'arn:aws:logs:us-east-1:123456789012:log-group:/aws/vendedlogs/bedrock-agentcore/memory/test-memory/APPLICATION_LOGS',
        },
        outputFormat: 'json',
      });

      // Second destination: traces to X-Ray
      expect(destCalls[1]).toEqual({
        name: 'mnemo-test-memory-traces-dest',
        deliveryDestinationType: 'XRAY',
      });
    });

    it('tolerates ResourceAlreadyExistsException on log group creation', async () => {
      const alreadyExistsErr = new Error('Log group already exists');
      alreadyExistsErr.name = 'ResourceAlreadyExistsException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'CreateLogGroup') {
          return Promise.reject(alreadyExistsErr);
        }
        if (cmd._type === 'PutDeliveryDestination') {
          return Promise.resolve({
            deliveryDestination: {
              arn: 'arn:aws:logs:us-east-1:123456789012:delivery-destination:test-dest',
            },
          });
        }
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.resolve({ deliveries: [] });
        }
        return Promise.resolve({});
      });

      const result = await handler(makeEvent({ RequestType: 'Create' }));
      expect(result.PhysicalResourceId).toBe('test-memory-observability');
    });

    it('tolerates ConflictException on delivery source', async () => {
      const conflictErr = new Error('Conflict');
      conflictErr.name = 'ConflictException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'PutDeliverySource') {
          return Promise.reject(conflictErr);
        }
        if (cmd._type === 'PutDeliveryDestination') {
          return Promise.resolve({
            deliveryDestination: {
              arn: 'arn:aws:logs:us-east-1:123456789012:delivery-destination:test-dest',
            },
          });
        }
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.resolve({ deliveries: [] });
        }
        return Promise.resolve({});
      });

      const result = await handler(makeEvent({ RequestType: 'Create' }));
      expect(result.PhysicalResourceId).toBe('test-memory-observability');
    });

    it('tolerates ConflictException on delivery destination and builds fallback ARN', async () => {
      const conflictErr = new Error('Conflict');
      conflictErr.name = 'ConflictException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'PutDeliveryDestination') {
          return Promise.reject(conflictErr);
        }
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.resolve({ deliveries: [] });
        }
        return Promise.resolve({});
      });

      const result = await handler(makeEvent({ RequestType: 'Create' }));
      expect(result.PhysicalResourceId).toBe('test-memory-observability');

      // Verify CreateDelivery was called with fallback ARN
      const deliveryCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'CreateDelivery')
        .map(cmdInput);

      expect(deliveryCalls[0].deliveryDestinationArn).toBe(
        'arn:aws:logs:us-east-1:123456789012:delivery-destination:mnemo-test-memory-app-logs-dest'
      );
      expect(deliveryCalls[1].deliveryDestinationArn).toBe(
        'arn:aws:logs:us-east-1:123456789012:delivery-destination:mnemo-test-memory-traces-dest'
      );
    });

    it('tolerates ConflictException on delivery creation', async () => {
      const conflictErr = new Error('Conflict');
      conflictErr.name = 'ConflictException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'CreateDelivery') {
          return Promise.reject(conflictErr);
        }
        if (cmd._type === 'PutDeliveryDestination') {
          return Promise.resolve({
            deliveryDestination: {
              arn: 'arn:aws:logs:us-east-1:123456789012:delivery-destination:test-dest',
            },
          });
        }
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.resolve({ deliveries: [] });
        }
        return Promise.resolve({});
      });

      const result = await handler(makeEvent({ RequestType: 'Create' }));
      expect(result.PhysicalResourceId).toBe('test-memory-observability');
    });

    it('returns empty string when destination response has no ARN', async () => {
      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'PutDeliveryDestination') {
          return Promise.resolve({ deliveryDestination: {} });
        }
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.resolve({ deliveries: [] });
        }
        return Promise.resolve({});
      });

      const result = await handler(makeEvent({ RequestType: 'Create' }));
      expect(result.PhysicalResourceId).toBe('test-memory-observability');

      // CreateDelivery should have been called with empty string ARN
      const deliveryCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'CreateDelivery')
        .map(cmdInput);
      expect(deliveryCalls[0].deliveryDestinationArn).toBe('');
    });

    it('throws on non-idempotent log group errors', async () => {
      const accessDenied = new Error('Access denied');
      accessDenied.name = 'AccessDeniedException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'CreateLogGroup') {
          return Promise.reject(accessDenied);
        }
        return Promise.resolve({});
      });

      await expect(handler(makeEvent({ RequestType: 'Create' }))).rejects.toThrow('Access denied');
    });

    it('throws on non-idempotent delivery source errors', async () => {
      const serviceErr = new Error('Service unavailable');
      serviceErr.name = 'ServiceUnavailableException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'PutDeliverySource') {
          return Promise.reject(serviceErr);
        }
        return Promise.resolve({});
      });

      await expect(handler(makeEvent({ RequestType: 'Create' }))).rejects.toThrow(
        'Service unavailable'
      );
    });
  });

  describe('Update event', () => {
    it('delegates to the same logic as Create', async () => {
      const result = await handler(
        makeEvent({
          RequestType: 'Update',
          PhysicalResourceId: 'test-memory-observability',
        })
      );

      expect(result.PhysicalResourceId).toBe('test-memory-observability');
      expect(result.Data.LogGroup).toBe(
        '/aws/vendedlogs/bedrock-agentcore/memory/test-memory/APPLICATION_LOGS'
      );

      const types = mockSend.mock.calls.map(cmdType);
      expect(types).toContain('CreateLogGroup');
      expect(types).toContain('PutDeliverySource');
      expect(types).toContain('PutDeliveryDestination');
      expect(types).toContain('CreateDelivery');
    });
  });

  describe('Delete event', () => {
    it('deletes deliveries and delivery sources', async () => {
      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'DescribeDeliveries') {
          const input = cmd.input as Record<string, unknown>;
          if (!input.nextToken) {
            return Promise.resolve({
              deliveries: [
                { deliverySourceName: 'mnemo-test-memory-app-logs', id: 'del-1' },
                { deliverySourceName: 'mnemo-test-memory-traces', id: 'del-2' },
                { deliverySourceName: 'other-source', id: 'del-3' },
              ],
              nextToken: undefined,
            });
          }
          return Promise.resolve({ deliveries: [] });
        }
        return Promise.resolve({});
      });

      const result = await handler(
        makeEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'test-memory-observability',
        })
      );

      expect(result.PhysicalResourceId).toBe('test-memory-observability');
      expect(result.Data).toEqual({});

      // Should have called DescribeDeliveries twice (once per source)
      const describeCalls = mockSend.mock.calls.filter(
        (c) => cmdType(c) === 'DescribeDeliveries'
      );
      expect(describeCalls).toHaveLength(2);

      // Should have deleted only matching deliveries (del-1 for app-logs, del-2 for traces)
      const deleteCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'DeleteDelivery')
        .map(cmdInput);
      expect(deleteCalls).toHaveLength(2);
      expect(deleteCalls[0].id).toBe('del-1');
      expect(deleteCalls[1].id).toBe('del-2');

      // Should have deleted both delivery sources
      const deleteSourceCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'DeleteDeliverySource')
        .map(cmdInput);
      expect(deleteSourceCalls).toHaveLength(2);
      expect(deleteSourceCalls[0].name).toBe('mnemo-test-memory-app-logs');
      expect(deleteSourceCalls[1].name).toBe('mnemo-test-memory-traces');
    });

    it('paginates through deliveries', async () => {
      let appLogsCallCount = 0;

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'DescribeDeliveries') {
          const input = cmd.input as Record<string, unknown>;
          // First source (app-logs) will paginate; second source (traces) won't
          if (!input.nextToken) {
            appLogsCallCount++;
            if (appLogsCallCount === 1) {
              return Promise.resolve({
                deliveries: [
                  { deliverySourceName: 'mnemo-test-memory-app-logs', id: 'del-page1' },
                ],
                nextToken: 'page2',
              });
            }
            // traces call (no pagination)
            return Promise.resolve({
              deliveries: [
                { deliverySourceName: 'mnemo-test-memory-traces', id: 'del-traces' },
              ],
            });
          }
          // Second page for app-logs
          return Promise.resolve({
            deliveries: [
              { deliverySourceName: 'mnemo-test-memory-app-logs', id: 'del-page2' },
            ],
            nextToken: undefined,
          });
        }
        return Promise.resolve({});
      });

      const result = await handler(
        makeEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'test-memory-observability',
        })
      );

      expect(result.PhysicalResourceId).toBe('test-memory-observability');

      const deleteCalls = mockSend.mock.calls
        .filter((c) => cmdType(c) === 'DeleteDelivery')
        .map(cmdInput);
      expect(deleteCalls).toHaveLength(3);
      expect(deleteCalls.map((c) => c.id)).toEqual(['del-page1', 'del-page2', 'del-traces']);
    });

    it('tolerates ResourceNotFoundException during cleanup', async () => {
      const notFoundErr = new Error('Not found');
      notFoundErr.name = 'ResourceNotFoundException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.reject(notFoundErr);
        }
        return Promise.resolve({});
      });

      const result = await handler(
        makeEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'test-memory-observability',
        })
      );

      expect(result.PhysicalResourceId).toBe('test-memory-observability');
      expect(result.Data).toEqual({});
    });

    it('swallows non-ResourceNotFound errors as non-fatal warnings', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const accessDenied = new Error('Access denied');
      accessDenied.name = 'AccessDeniedException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'DescribeDeliveries') {
          return Promise.reject(accessDenied);
        }
        return Promise.resolve({});
      });

      const result = await handler(
        makeEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'test-memory-observability',
        })
      );

      expect(result.PhysicalResourceId).toBe('test-memory-observability');
      expect(warnSpy).toHaveBeenCalledWith(
        'Cleanup error (non-fatal):',
        'Access denied'
      );

      warnSpy.mockRestore();
    });

    it('uses PhysicalResourceId from event when present', async () => {
      const result = await handler(
        makeEvent({
          RequestType: 'Delete',
          PhysicalResourceId: 'custom-physical-id',
        })
      );

      expect(result.PhysicalResourceId).toBe('custom-physical-id');
    });

    it('falls back to memoryName-based PhysicalResourceId when none in event', async () => {
      const result = await handler(
        makeEvent({
          RequestType: 'Delete',
        })
      );

      expect(result.PhysicalResourceId).toBe('test-memory-observability');
    });
  });

  describe('error handling', () => {
    it('propagates unexpected errors from Create', async () => {
      const fatalErr = new Error('Something went very wrong');
      fatalErr.name = 'InternalServiceException';

      mockSend.mockImplementation((cmd: Record<string, unknown>) => {
        if (cmd._type === 'PutDeliveryDestination') {
          return Promise.reject(fatalErr);
        }
        return Promise.resolve({});
      });

      await expect(handler(makeEvent({ RequestType: 'Create' }))).rejects.toThrow(
        'Something went very wrong'
      );
    });

    it('logs the event on every invocation', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handler(makeEvent({ RequestType: 'Create' }));

      expect(logSpy).toHaveBeenCalledWith('Event:', expect.any(String));
      const logged = JSON.parse(logSpy.mock.calls[0][1] as string);
      expect(logged.RequestType).toBe('Create');

      logSpy.mockRestore();
    });
  });
});
