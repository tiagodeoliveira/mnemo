import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { MemoryConstruct, StackEnvironment } from './memory-construct';
import { LambdaConstruct } from './lambda-construct';
import { ApiConstruct } from './api-construct';
import { ObservabilityConstruct } from './observability-construct';

export interface MnemoStackProps extends cdk.StackProps {
  actorId: string;
  modelId?: string;
  notificationEmail?: string;
  digestSchedule?: string;
  digestTimezone?: string;
  environment?: StackEnvironment;
}

export class MnemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MnemoStackProps) {
    super(scope, id, props);

    const environment: StackEnvironment = props.environment ?? 'production';

    const logEncryptionKey = new kms.Key(this, 'LogEncryptionKey', {
      description: 'Encrypts all CloudWatch Log Groups in the mnemo stack',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    logEncryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
          },
        },
      })
    );

    const memory = new MemoryConstruct(this, 'Memory', {
      memoryName: 'mnemo_memory',
      actorId: props.actorId,
      environment,
    });

    new cdk.CfnOutput(this, 'Environment', {
      value: environment,
      description: 'Stack environment mode (controls payload bucket retention on destroy)',
    });

    const lambdas = new LambdaConstruct(this, 'Lambdas', {
      memoryId: memory.memoryId,
      actorId: props.actorId,
      snsTopic: memory.snsTopic,
      payloadBucket: memory.payloadBucket,
      logEncryptionKey,
      modelId: props.modelId,
      digestEmailFrom: props.notificationEmail,
      digestEmailTo: props.notificationEmail,
      digestTimezone: props.digestTimezone,
    });

    const api = new ApiConstruct(this, 'Api', {
      ingestFunction: lambdas.ingestFunction,
      recallFunction: lambdas.recallFunction,
      logEncryptionKey,
    });

    const schedulerDlq = new sqs.Queue(this, 'DigestSchedulerDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    new ObservabilityConstruct(this, 'Observability', {
      ingestFunction: lambdas.ingestFunction,
      recallFunction: lambdas.recallFunction,
      contextExtractorFunction: lambdas.contextExtractorFunction,
      digestFunction: lambdas.digestFunction,
      ingestLogGroup: lambdas.ingestLogGroup,
      recallLogGroup: lambdas.recallLogGroup,
      contextExtractorLogGroup: lambdas.contextExtractorLogGroup,
      digestLogGroup: lambdas.digestLogGroup,
      api: api.api,
      deadLetterQueues: [lambdas.contextExtractorDlq, schedulerDlq],
      alarmEmail: props.notificationEmail,
    });

    const schedulerRole = new iam.Role(this, 'DigestSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    lambdas.digestFunction.grantInvoke(schedulerRole);
    schedulerDlq.grantSendMessages(schedulerRole);

    new scheduler.CfnSchedule(this, 'DigestSchedule', {
      scheduleExpression: props.digestSchedule || 'cron(0 23 * * ? *)',
      scheduleExpressionTimezone: props.digestTimezone || 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: lambdas.digestFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 3600,
        },
        deadLetterConfig: {
          arn: schedulerDlq.queueArn,
        },
      },
    });
  }
}
