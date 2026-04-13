import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import { LambdaConstruct } from '../lib/lambda-construct';

describe('LambdaConstruct', () => {
  it('creates three lambda functions', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    const topic = new sns.Topic(stack, 'Topic');
    const bucket = new s3.Bucket(stack, 'Bucket');

    new LambdaConstruct(stack, 'Lambdas', {
      memoryId: 'mem-123',
      actorId: 'tiago',
      snsTopic: topic,
      payloadBucket: bucket,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  it('scopes agentcore policy to memory resource', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const topic = new sns.Topic(stack, 'Topic');
    const bucket = new s3.Bucket(stack, 'Bucket');

    new LambdaConstruct(stack, 'Lambdas', {
      memoryId: 'mem-123',
      actorId: 'tiago',
      snsTopic: topic,
      payloadBucket: bucket,
    });

    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');

    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy as any).Properties?.PolicyDocument?.Statement || [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasAgentcore = actions.some((a: string) => a.startsWith('bedrock-agentcore:'));
        if (hasAgentcore) {
          expect(stmt.Resource).not.toBe('*');
        }
      }
    }
  });

  it('scopes bedrock invoke policy to foundation models', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack2', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const topic = new sns.Topic(stack, 'Topic');
    const bucket = new s3.Bucket(stack, 'Bucket');

    new LambdaConstruct(stack, 'Lambdas', {
      memoryId: 'mem-123',
      actorId: 'tiago',
      snsTopic: topic,
      payloadBucket: bucket,
    });

    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');

    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy as any).Properties?.PolicyDocument?.Statement || [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasInvoke = actions.some((a: string) => a === 'bedrock:InvokeModel');
        if (hasInvoke) {
          expect(stmt.Resource).not.toBe('*');
        }
      }
    }
  });
});
