import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
  logEncryptionKey: kms.IKey;
  modelId?: string;
  taskDomains?: string[];
  digestEmailFrom?: string;
  digestEmailTo?: string;
  digestTimezone?: string;
}

export class LambdaConstruct extends Construct {
  public readonly ingestFunction: lambda.IFunction;
  public readonly recallFunction: lambda.IFunction;
  public readonly contextExtractorFunction: lambda.IFunction;
  public readonly digestFunction: lambda.IFunction;
  public readonly contextExtractorDlq: sqs.IQueue;
  public readonly ingestLogGroup: logs.ILogGroup;
  public readonly recallLogGroup: logs.ILogGroup;
  public readonly contextExtractorLogGroup: logs.ILogGroup;
  public readonly digestLogGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: LambdaConstructProps) {
    super(scope, id);

    const lambdaDir = path.join(__dirname, '..', 'lambda');

    const commonEnv = {
      MEMORY_ID: props.memoryId,
      ACTOR_ID: props.actorId,
    };

    const memoryArn = `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/${props.memoryId}`;

    const agentcorePolicy = new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:RetrieveMemoryRecords',
        'bedrock-agentcore:BatchCreateMemoryRecords',
        'bedrock-agentcore:BatchDeleteMemoryRecords',
      ],
      resources: [memoryArn],
    });

    this.ingestLogGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.logEncryptionKey,
    });

    this.ingestFunction = new NodejsFunction(this, 'IngestFn', {
      entry: path.join(lambdaDir, 'ingest', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      logGroup: this.ingestLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 10,
      bundling: {
        externalModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.ingestFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);

    this.recallLogGroup = new logs.LogGroup(this, 'RecallLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.logEncryptionKey,
    });

    this.recallFunction = new NodejsFunction(this, 'RecallFn', {
      entry: path.join(lambdaDir, 'recall', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      logGroup: this.recallLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 10,
      bundling: {
        externalModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.recallFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);

    const taskDomains = props.taskDomains || ['coding', 'studying', 'meeting', 'general'];

    this.contextExtractorLogGroup = new logs.LogGroup(this, 'ContextExtractorLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.logEncryptionKey,
    });

    this.contextExtractorFunction = new NodejsFunction(this, 'ContextExtractorFn', {
      entry: path.join(lambdaDir, 'context-extractor', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        ...commonEnv,
        MODEL_ID: props.modelId || 'us.anthropic.claude-sonnet-4-6',
        TASK_DOMAINS: taskDomains.join(','),
      },
      logGroup: this.contextExtractorLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 5,
      bundling: {
        nodeModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.contextExtractorFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);
    this.contextExtractorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          // Cross-region inference profiles (us.*) route to models in any US region,
          // so foundation-model ARNs must use wildcard region.
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/*`,
        ],
      })
    );

    props.payloadBucket.grantRead(this.contextExtractorFunction);

    this.contextExtractorDlq = new sqs.Queue(this, 'ContextExtractorDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    props.snsTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(this.contextExtractorFunction, {
        deadLetterQueue: this.contextExtractorDlq,
      })
    );

    const digestEnv: Record<string, string> = {
      ...commonEnv,
      MODEL_ID: props.modelId || 'us.anthropic.claude-sonnet-4-6',
      DIGEST_TIMEZONE: props.digestTimezone || 'UTC',
    };
    if (props.digestEmailFrom) digestEnv.DIGEST_EMAIL_FROM = props.digestEmailFrom;
    if (props.digestEmailTo) digestEnv.DIGEST_EMAIL_TO = props.digestEmailTo;

    this.digestLogGroup = new logs.LogGroup(this, 'DigestLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.logEncryptionKey,
    });

    this.digestFunction = new NodejsFunction(this, 'DigestFn', {
      entry: path.join(lambdaDir, 'daily-digest', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: digestEnv,
      logGroup: this.digestLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 2,
      bundling: {
        nodeModules: ['@aws-sdk/client-bedrock-agentcore'],
      },
    });
    (this.digestFunction as NodejsFunction).addToRolePolicy(agentcorePolicy);
    this.digestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/*`,
        ],
      })
    );
    if (props.digestEmailFrom || props.digestEmailTo) {
      const sesResources: string[] = [];
      const region = cdk.Stack.of(this).region;
      const account = cdk.Stack.of(this).account;
      if (props.digestEmailFrom) {
        sesResources.push(`arn:aws:ses:${region}:${account}:identity/${props.digestEmailFrom}`);
      }
      if (props.digestEmailTo) {
        sesResources.push(`arn:aws:ses:${region}:${account}:identity/${props.digestEmailTo}`);
      }
      this.digestFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: sesResources,
        })
      );
    }
  }
}
