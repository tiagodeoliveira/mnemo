import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MemoryConstruct } from '../lib/memory-construct';

describe('MemoryConstruct', () => {
  it('creates custom resource, SNS topic, and S3 bucket', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    // cr.Provider creates a framework handler Lambda, and autoDeleteObjects
    // creates another Lambda for bucket cleanup — 3 total
    template.resourceCountIs('AWS::Lambda::Function', 3);
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('configures the memory provider Lambda with correct properties', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs22.x',
      Timeout: 600,
    });
  });

  it('grants bedrock-agentcore and iam:PassRole permissions', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:CreateMemory',
              'bedrock-agentcore:GetMemory',
              'bedrock-agentcore:UpdateMemory',
              'bedrock-agentcore:DeleteMemory',
            ],
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 'iam:PassRole',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('passes resource properties to the custom resource', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
      actorId: 'test-actor',
      eventExpiryDuration: 30,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      memoryName: 'test-memory',
      description: 'mnemo centralized AI memory',
      eventExpiryDuration: 30,
      actorId: 'test-actor',
    });
  });

  it('uses default eventExpiryDuration of 90 when not specified', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      eventExpiryDuration: 90,
    });
  });

  it('configures S3 bucket with lifecycle and removal policy', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new MemoryConstruct(stack, 'Memory', {
      memoryName: 'test-memory',
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
});
