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

  it('configures S3 bucket with lifecycle and removal policy', () => {
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
          Match.objectLike({
            ExpirationInDays: 7,
            Status: 'Enabled',
          }),
        ],
      },
    });
    template.hasResource('AWS::S3::Bucket', {
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    });
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
      const policies = (role as any).Properties?.Policies || [];
      for (const policy of policies) {
        const stmts = policy.PolicyDocument?.Statement || [];
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
