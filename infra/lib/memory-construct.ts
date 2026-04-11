import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

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
              resources: ['*'],
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
  }
}
