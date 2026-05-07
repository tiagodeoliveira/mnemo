import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface ActorsConstructProps {
  /** Seed actor for the first deploy. Subsequent rows are inserted manually. */
  seedActor: {
    actorId: string;
    email?: string;
    timezone?: string;
  };
}

/**
 * DynamoDB table of actors (one row per identity) plus a one-shot seed of the
 * default actor. Digest dispatcher scans this table to fan out per-actor runs.
 * The seed only inserts if no row for that actorId exists, so future manual
 * edits survive stack updates.
 */
export class ActorsConstruct extends Construct {
  public readonly table: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: ActorsConstructProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'actorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const seedItem: Record<string, { S: string } | { BOOL: boolean }> = {
      actorId: { S: props.seedActor.actorId },
      digestEnabled: { BOOL: true },
      createdAt: { S: new Date().toISOString() },
    };
    if (props.seedActor.email) {
      seedItem.email = { S: props.seedActor.email };
    }
    if (props.seedActor.timezone) {
      seedItem.timezone = { S: props.seedActor.timezone };
    }

    // Conditional put: only seed if the actorId row doesn't already exist.
    // This lets the user edit or delete the row manually without the stack
    // overwriting their changes on every deploy.
    const seed = new cr.AwsCustomResource(this, 'Seed', {
      onCreate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: this.table.tableName,
          Item: seedItem,
          ConditionExpression: 'attribute_not_exists(actorId)',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`actors-seed-${props.seedActor.actorId}`),
        ignoreErrorCodesMatching: 'ConditionalCheckFailedException',
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: this.table.tableName,
          Item: seedItem,
          ConditionExpression: 'attribute_not_exists(actorId)',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`actors-seed-${props.seedActor.actorId}`),
        ignoreErrorCodesMatching: 'ConditionalCheckFailedException',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.table.tableArn],
      }),
    });
    seed.node.addDependency(this.table);
  }
}
