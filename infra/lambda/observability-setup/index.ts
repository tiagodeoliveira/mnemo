import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutDeliverySourceCommand,
  PutDeliveryDestinationCommand,
  CreateDeliveryCommand,
  DeleteDeliveryCommand,
  DeleteDeliverySourceCommand,
  DescribeDeliveriesCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const logsClient = new CloudWatchLogsClient({});

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, string>;
}

interface CfnResponse {
  PhysicalResourceId: string;
  Data: Record<string, string>;
}

async function ensureLogGroup(logGroupName: string): Promise<void> {
  try {
    await logsClient.send(new CreateLogGroupCommand({ logGroupName }));
  } catch (err: any) {
    if (err.name !== 'ResourceAlreadyExistsException') throw err;
  }
}

async function ensureDeliverySource(
  sourceName: string,
  logType: string,
  resourceArn: string
): Promise<void> {
  try {
    await logsClient.send(new PutDeliverySourceCommand({ name: sourceName, logType, resourceArn }));
  } catch (err: any) {
    if (err.name === 'ConflictException' || err.name === 'ResourceAlreadyExistsException') {
      return;
    }
    throw err;
  }
}

async function ensureDeliveryDestination(
  destName: string,
  logGroupArn: string
): Promise<string> {
  try {
    const resp = await logsClient.send(
      new PutDeliveryDestinationCommand({
        name: destName,
        deliveryDestinationConfiguration: { destinationResourceArn: logGroupArn },
        outputFormat: 'json',
      })
    );
    return resp.deliveryDestination?.arn || '';
  } catch (err: any) {
    if (err.name === 'ConflictException' || err.name === 'ResourceAlreadyExistsException') {
      const region = process.env.AWS_REGION || 'us-east-1';
      const accountId = process.env.AWS_ACCOUNT_ID || '';
      return `arn:aws:logs:${region}:${accountId}:delivery-destination:${destName}`;
    }
    throw err;
  }
}

async function ensureXrayDestination(destName: string): Promise<string> {
  try {
    const resp = await logsClient.send(
      new PutDeliveryDestinationCommand({
        name: destName,
        deliveryDestinationType: 'XRAY',
      })
    );
    return resp.deliveryDestination?.arn || '';
  } catch (err: any) {
    if (err.name === 'ConflictException' || err.name === 'ResourceAlreadyExistsException') {
      const region = process.env.AWS_REGION || 'us-east-1';
      const accountId = process.env.AWS_ACCOUNT_ID || '';
      return `arn:aws:logs:${region}:${accountId}:delivery-destination:${destName}`;
    }
    throw err;
  }
}

async function ensureDelivery(sourceName: string, destArn: string): Promise<void> {
  try {
    await logsClient.send(
      new CreateDeliveryCommand({ deliverySourceName: sourceName, deliveryDestinationArn: destArn })
    );
  } catch (err: any) {
    if (err.name === 'ConflictException' || err.name === 'ResourceAlreadyExistsException') {
      return;
    }
    throw err;
  }
}

async function deleteDeliverySource(sourceName: string): Promise<void> {
  try {
    let nextToken: string | undefined;
    do {
      const page = await logsClient.send(
        new DescribeDeliveriesCommand({ nextToken })
      );
      for (const delivery of page.deliveries || []) {
        if (delivery.deliverySourceName === sourceName && delivery.id) {
          await logsClient.send(new DeleteDeliveryCommand({ id: delivery.id }));
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
    await logsClient.send(new DeleteDeliverySourceCommand({ name: sourceName }));
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
}

async function onCreate(event: CfnEvent): Promise<CfnResponse> {
  const { memoryArn, memoryName } = event.ResourceProperties;
  const prefix = `mnemo-${memoryName}`;
  const logGroupBase = `/aws/vendedlogs/bedrock-agentcore/memory/${memoryName}`;

  const appLogGroup = `${logGroupBase}/APPLICATION_LOGS`;
  await ensureLogGroup(appLogGroup);
  await ensureDeliverySource(`${prefix}-app-logs`, 'APPLICATION_LOGS', memoryArn);
  const region = process.env.AWS_REGION || 'us-east-1';
  const accountId = process.env.AWS_ACCOUNT_ID || '';
  const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:${appLogGroup}`;
  const appDestArn = await ensureDeliveryDestination(`${prefix}-app-logs-dest`, logGroupArn);
  await ensureDelivery(`${prefix}-app-logs`, appDestArn);

  await ensureDeliverySource(`${prefix}-traces`, 'TRACES', memoryArn);
  const tracesDestArn = await ensureXrayDestination(`${prefix}-traces-dest`);
  await ensureDelivery(`${prefix}-traces`, tracesDestArn);

  return {
    PhysicalResourceId: `${memoryName}-observability`,
    Data: { LogGroup: appLogGroup },
  };
}

async function onDelete(event: CfnEvent): Promise<CfnResponse> {
  const { memoryName } = event.ResourceProperties;
  const prefix = `mnemo-${memoryName}`;

  try {
    await deleteDeliverySource(`${prefix}-app-logs`);
    await deleteDeliverySource(`${prefix}-traces`);
  } catch (err: any) {
    console.warn('Cleanup error (non-fatal):', err.message);
  }

  return {
    PhysicalResourceId: event.PhysicalResourceId || `${memoryName}-observability`,
    Data: {},
  };
}

export async function handler(event: CfnEvent): Promise<CfnResponse> {
  console.log('Event:', JSON.stringify(event));
  switch (event.RequestType) {
    case 'Create':
      return onCreate(event);
    case 'Update':
      return onCreate(event);
    case 'Delete':
      return onDelete(event);
    default:
      throw new Error(`Unknown RequestType: ${(event as any).RequestType}`);
  }
}
