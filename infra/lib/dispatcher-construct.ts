import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface DispatcherConstructProps {
  actorsTable: dynamodb.ITable;
  digestFunction: lambda.IFunction;
  logEncryptionKey: kms.IKey;
  digestSchedule?: string;
  digestScheduleTimezone?: string;
}

/**
 * The dispatcher reads the actors table and fans out one SQS message per
 * digest-enabled actor. The digest Lambda consumes the queue.
 *
 * EventBridge Scheduler invokes the dispatcher on a single global schedule.
 * Per-actor timezone is handled inside the digest Lambda when it computes
 * the local date for that actor's namespaces.
 */
export class DispatcherConstruct extends Construct {
  public readonly dispatcherFunction: lambda.IFunction;
  public readonly dispatcherLogGroup: logs.ILogGroup;
  public readonly digestQueue: sqs.IQueue;
  public readonly digestDlq: sqs.IQueue;
  public readonly schedulerDlq: sqs.IQueue;

  constructor(scope: Construct, id: string, props: DispatcherConstructProps) {
    super(scope, id);

    this.digestDlq = new sqs.Queue(this, 'DigestDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.digestQueue = new sqs.Queue(this, 'DigestQueue', {
      retentionPeriod: cdk.Duration.days(4),
      visibilityTimeout: cdk.Duration.minutes(6),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.digestDlq,
        maxReceiveCount: 3,
      },
    });

    // Let the digest Lambda consume the queue. No need for props.digestFunction
    // to know about the queue at construction time; we attach an event source
    // mapping from here.
    new lambda.EventSourceMapping(this, 'DigestQueueBinding', {
      target: props.digestFunction,
      eventSourceArn: this.digestQueue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });
    this.digestQueue.grantConsumeMessages(props.digestFunction);

    this.dispatcherLogGroup = new logs.LogGroup(this, 'DispatcherLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.logEncryptionKey,
    });

    const lambdaDir = path.join(__dirname, '..', 'lambda');
    this.dispatcherFunction = new NodejsFunction(this, 'DispatcherFn', {
      entry: path.join(lambdaDir, 'dispatcher', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ACTORS_TABLE: props.actorsTable.tableName,
        DIGEST_QUEUE_URL: this.digestQueue.queueUrl,
      },
      logGroup: this.dispatcherLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 1,
    });
    props.actorsTable.grantReadData(this.dispatcherFunction);
    this.digestQueue.grantSendMessages(this.dispatcherFunction);

    this.schedulerDlq = new sqs.Queue(this, 'SchedulerDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    this.dispatcherFunction.grantInvoke(schedulerRole);
    this.schedulerDlq.grantSendMessages(schedulerRole);

    new scheduler.CfnSchedule(this, 'DispatcherSchedule', {
      scheduleExpression: props.digestSchedule || 'cron(0 23 * * ? *)',
      scheduleExpressionTimezone: props.digestScheduleTimezone || 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: this.dispatcherFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 3600,
        },
        deadLetterConfig: {
          arn: this.schedulerDlq.queueArn,
        },
      },
    });
  }
}
