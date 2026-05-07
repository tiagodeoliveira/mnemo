import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { MemoryConstruct, StackEnvironment } from './memory-construct';
import { LambdaConstruct } from './lambda-construct';
import { ApiConstruct } from './api-construct';
import { ObservabilityConstruct } from './observability-construct';
import { ActorsConstruct } from './actors-construct';
import { DispatcherConstruct } from './dispatcher-construct';

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
    });

    const api = new ApiConstruct(this, 'Api', {
      ingestFunction: lambdas.ingestFunction,
      recallFunction: lambdas.recallFunction,
      logEncryptionKey,
    });

    const actors = new ActorsConstruct(this, 'Actors', {
      seedActor: {
        actorId: props.actorId,
        email: props.notificationEmail,
        timezone: props.digestTimezone,
      },
    });

    const dispatcher = new DispatcherConstruct(this, 'Dispatcher', {
      actorsTable: actors.table,
      digestFunction: lambdas.digestFunction,
      logEncryptionKey,
      digestSchedule: props.digestSchedule,
      digestScheduleTimezone: props.digestTimezone,
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
      deadLetterQueues: [lambdas.contextExtractorDlq, dispatcher.digestDlq, dispatcher.schedulerDlq],
      alarmEmail: props.notificationEmail,
    });
  }
}
