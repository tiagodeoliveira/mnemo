import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdaConstructProps {
  memoryId: string;
  actorId: string;
  snsTopic: sns.ITopic;
  payloadBucket: s3.IBucket;
  modelId?: string;
}

export class LambdaConstruct extends Construct {
  public readonly ingestFunction: lambda.IFunction;
  public readonly recallFunction: lambda.IFunction;
  public readonly projectExtractorFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: LambdaConstructProps) {
    super(scope, id);

    const lambdaDir = path.join(__dirname, '..', 'lambda');

    const commonEnv = {
      MEMORY_ID: props.memoryId,
      ACTOR_ID: props.actorId,
    };

    const agentcorePolicy = new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:RetrieveMemoryRecords',
        'bedrock-agentcore:BatchCreateMemoryRecords',
      ],
      resources: ['*'],
    });

    this.ingestFunction = new NodejsFunction(this, 'IngestFn', {
      entry: path.join(lambdaDir, 'ingest', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      bundling: {
        externalModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.ingestFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);

    this.recallFunction = new NodejsFunction(this, 'RecallFn', {
      entry: path.join(lambdaDir, 'recall', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      bundling: {
        externalModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.recallFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);

    this.projectExtractorFunction = new NodejsFunction(this, 'ProjectExtractorFn', {
      entry: path.join(lambdaDir, 'project-extractor', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      environment: {
        ...commonEnv,
        MODEL_ID: props.modelId || 'anthropic.claude-3-haiku-20240307-v1:0',
      },
      bundling: {
        externalModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.projectExtractorFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);
    this.projectExtractorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      })
    );

    props.payloadBucket.grantRead(this.projectExtractorFunction);
    props.snsTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(this.projectExtractorFunction)
    );
  }
}
