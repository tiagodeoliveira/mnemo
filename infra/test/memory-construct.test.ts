import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MemoryConstruct } from '../lib/memory-construct';

describe('MemoryConstruct', () => {
  it('creates CfnMemory, SNS topic, and S3 bucket', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
  });

  it('configures all 4 memory strategies', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      MemoryStrategies: Match.arrayWith([
        Match.objectLike({ UserPreferenceMemoryStrategy: { Name: 'UserPreferences' } }),
        Match.objectLike({ SemanticMemoryStrategy: { Name: 'SemanticFacts' } }),
        Match.objectLike({ EpisodicMemoryStrategy: { Name: 'EpisodicMemory' } }),
        Match.objectLike({ CustomMemoryStrategy: { Name: 'ProjectContext' } }),
      ]),
    });
  });

  it('creates execution role with correct trust and permissions', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      },
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                Effect: 'Allow',
              }),
              Match.objectLike({
                Action: ['sns:Publish', 'sns:GetTopicAttributes'],
                Effect: 'Allow',
              }),
            ]),
          },
        }),
      ]),
    });
  });

  it('passes memory properties correctly', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
      eventExpiryDuration: 30,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      Name: 'test_memory',
      EventExpiryDuration: 30,
    });
  });

  it('uses default eventExpiryDuration of 90 when not specified', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      EventExpiryDuration: 90,
    });
  });

  it('retains the payload bucket on destroy by default (production posture)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({ ExpirationInDays: 7, Status: 'Enabled' }),
        ],
      },
    });
    template.hasResource('AWS::S3::Bucket', {
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    });
    // No auto-delete custom resource in the production default.
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('configures S3 bucket with BlockPublicAccess BLOCK_ALL and SSE', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  it('enforces SSL on the S3 bucket via bucket policy', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('encrypts the SNS topic with the AWS-managed SNS key', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([
            Match.stringLikeRegexp('alias/aws/sns'),
          ]),
        ]),
      }),
    });
  });

  it('destroys the payload bucket with the stack when environment=dev', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
      environment: 'dev',
    });

    const template = Template.fromStack(stack);
    template.hasResource('AWS::S3::Bucket', {
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('scopes bedrock permissions on execution role to foundation models', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test_memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    const roles = template.findResources('AWS::IAM::Role');
    for (const [, role] of Object.entries(roles)) {
      const props = role.Properties as Record<string, unknown> | undefined;
      const policies = (props?.Policies as Array<Record<string, unknown>>) || [];
      for (const policy of policies) {
        const policyDoc = policy.PolicyDocument as Record<string, unknown> | undefined;
        const stmts = (policyDoc?.Statement as Array<Record<string, unknown>>) || [];
        for (const stmt of stmts) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          if (actions.includes('bedrock:InvokeModel')) {
            expect(stmt.Resource).not.toBe('*');
          }
        }
      }
    }
  });
});
