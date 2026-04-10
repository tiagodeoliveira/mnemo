import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface MemoryConstructProps {
  memoryName: string;
  actorId: string;
  eventExpiryDuration?: number;
}

export class MemoryConstruct extends Construct {
  public readonly memoryId: string;
  public readonly snsTopic: sns.Topic;
  public readonly payloadBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: MemoryConstructProps) {
    super(scope, id);

    this.snsTopic = new sns.Topic(this, 'ProjectExtractorTopic', {
      topicName: 'mnemo-project-extractor',
    });

    this.payloadBucket = new s3.Bucket(this, 'PayloadBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    const providerFn = new NodejsFunction(this, 'MemoryProviderFn', {
      entry: path.join(__dirname, '..', 'lambda', 'memory-provider', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(10),
      bundling: {
        externalModules: ['@aws-sdk/client-bedrock-agentcore-control'],
      },
    });

    providerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateMemory',
          'bedrock-agentcore:GetMemory',
          'bedrock-agentcore:UpdateMemory',
          'bedrock-agentcore:DeleteMemory',
        ],
        resources: ['*'],
      })
    );

    providerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: ['*'],
      })
    );

    const provider = new cr.Provider(this, 'MemoryProvider', {
      onEventHandler: providerFn,
    });

    const memory = new cdk.CustomResource(this, 'Memory', {
      serviceToken: provider.serviceToken,
      properties: {
        memoryName: props.memoryName,
        description: 'mnemo centralized AI memory',
        eventExpiryDuration: props.eventExpiryDuration ?? 90,
        snsTopicArn: this.snsTopic.topicArn,
        s3BucketName: this.payloadBucket.bucketName,
        actorId: props.actorId,
      },
    });

    this.memoryId = memory.getAttString('MemoryId');
  }
}
