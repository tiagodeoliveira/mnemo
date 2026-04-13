import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
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

    const executionRole = new iam.Role(this, 'MemoryExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      inlinePolicies: {
        MemoryExecution: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              resources: [
                `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/*`,
                `arn:aws:bedrock:*:*:inference-profile/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['sns:Publish', 'sns:GetTopicAttributes'],
              resources: [this.snsTopic.topicArn],
            }),
            new iam.PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject', 's3:GetBucketLocation'],
              resources: [this.payloadBucket.bucketArn, this.payloadBucket.arnForObjects('*')],
            }),
          ],
        }),
      },
    });

    this.snsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish', 'sns:GetTopicAttributes'],
        principals: [new iam.ArnPrincipal(executionRole.roleArn)],
        resources: [this.snsTopic.topicArn],
      })
    );

    const memory = new bedrockagentcore.CfnMemory(this, 'Memory', {
      name: props.memoryName,
      description: 'mnemo centralized AI memory',
      memoryExecutionRoleArn: executionRole.roleArn,
      eventExpiryDuration: props.eventExpiryDuration ?? 90,
      memoryStrategies: [
        {
          userPreferenceMemoryStrategy: {
            name: 'UserPreferences',
            namespaces: [`/preferences/{actorId}/`],
          },
        },
        {
          semanticMemoryStrategy: {
            name: 'SemanticFacts',
            namespaces: [`/facts/{actorId}/`],
          },
        },
        {
          episodicMemoryStrategy: {
            name: 'EpisodicMemory',
            namespaces: [`/episodes/{actorId}/`],
            reflectionConfiguration: {
              namespaces: [`/episodes/{actorId}/`],
            },
          },
        },
        {
          customMemoryStrategy: {
            name: 'ProjectContext',
            configuration: {
              selfManagedConfiguration: {
                triggerConditions: [
                  { messageBasedTrigger: { messageCount: 10 } },
                  { timeBasedTrigger: { idleSessionTimeout: 300 } },
                ],
                invocationConfiguration: {
                  topicArn: this.snsTopic.topicArn,
                  payloadDeliveryBucketName: this.payloadBucket.bucketName,
                },
                historicalContextWindowSize: 50,
              },
            },
          },
        },
      ],
    });

    memory.addDependency(executionRole.node.defaultChild as cdk.CfnResource);

    this.memoryId = memory.attrMemoryId;

    const lambdaDir = path.join(__dirname, '..', 'lambda');

    const observabilityFn = new NodejsFunction(this, 'ObservabilitySetupFn', {
      entry: path.join(lambdaDir, 'observability-setup', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      environment: {
        AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      },
      bundling: {
        externalModules: ['@aws-sdk/client-cloudwatch-logs'],
      },
    });

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    observabilityFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:PutDeliverySource',
          'logs:PutDeliveryDestination',
          'logs:CreateDelivery',
          'logs:GetDelivery',
          'logs:DeleteDeliverySource',
          'logs:DeleteDelivery',
          'logs:DeleteDeliveryDestination',
          'logs:DescribeDeliveries',
        ],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/vendedlogs/bedrock-agentcore/*`,
          `arn:aws:logs:${region}:${account}:delivery:*`,
          `arn:aws:logs:${region}:${account}:delivery-source:*`,
          `arn:aws:logs:${region}:${account}:delivery-destination:*`,
        ],
      })
    );

    observabilityFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:AllowVendedLogDeliveryForResource'],
        resources: [`arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:memory/*`],
      })
    );

    observabilityFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:PutResourcePolicy',
          'xray:ListResourcePolicies',
          'xray:GetTraceSegmentDestination',
        ],
        resources: ['*'],
      })
    );

    new logs.CfnResourcePolicy(this, 'DeliveryLogPolicy', {
      policyName: 'mnemo-agentcore-delivery',
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowDeliveryToAgentCoreLogs',
            Effect: 'Allow',
            Principal: { Service: 'delivery.logs.amazonaws.com' },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: [
              `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/vendedlogs/bedrock-agentcore/*:*`,
            ],
            Condition: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
          },
        ],
      }),
    });

    const observabilityProvider = new cr.Provider(this, 'ObservabilityProvider', {
      onEventHandler: observabilityFn,
    });

    const observability = new cdk.CustomResource(this, 'ObservabilitySetup', {
      serviceToken: observabilityProvider.serviceToken,
      properties: {
        memoryArn: memory.attrMemoryArn,
        memoryName: props.memoryName,
      },
    });

    observability.node.addDependency(memory);
  }
}
