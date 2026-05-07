import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

if (!process.env.ACTORS_TABLE || !process.env.DIGEST_QUEUE_URL) {
  throw new Error('Missing required env vars: ACTORS_TABLE, DIGEST_QUEUE_URL');
}

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

interface ActorRow {
  actorId: string;
  email?: string;
  timezone?: string;
}

function toActorRow(item: Record<string, AttributeValue>): ActorRow | undefined {
  const actorId = item.actorId?.S;
  if (!actorId) return undefined;
  if (item.digestEnabled?.BOOL === false) return undefined;
  return {
    actorId,
    email: item.email?.S,
    timezone: item.timezone?.S,
  };
}

async function listEnabledActors(tableName: string): Promise<ActorRow[]> {
  const actors: ActorRow[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of response.Items ?? []) {
      const row = toActorRow(item);
      if (row) actors.push(row);
    }
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return actors;
}

async function enqueue(queueUrl: string, actors: ActorRow[]): Promise<void> {
  // SendMessageBatch accepts up to 10 messages per call.
  for (let i = 0; i < actors.length; i += 10) {
    const chunk = actors.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((actor, idx) => ({
          Id: `${i + idx}`,
          MessageBody: JSON.stringify(actor),
        })),
      })
    );
  }
}

export async function handler(): Promise<void> {
  const tableName = process.env.ACTORS_TABLE!;
  const queueUrl = process.env.DIGEST_QUEUE_URL!;

  const actors = await listEnabledActors(tableName);
  if (actors.length === 0) {
    console.log('No digest-enabled actors found, nothing to dispatch');
    return;
  }

  await enqueue(queueUrl, actors);
  console.log(`Dispatched digest jobs for ${actors.length} actors`);
}
