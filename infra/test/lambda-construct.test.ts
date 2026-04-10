import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LambdaConstruct } from '../lib/lambda-construct';

function buildStack(stackName = 'TestStack', env?: { account: string; region: string }) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, stackName, env ? { env } : undefined);
  const topic = new sns.Topic(stack, 'Topic');
  const bucket = new s3.Bucket(stack, 'Bucket');
  const key = new kms.Key(stack, 'LogKey');

  new LambdaConstruct(stack, 'Lambdas', {
    memoryId: 'mem-123',
    actorId: 'tiago',
    snsTopic: topic,
    payloadBucket: bucket,
    logEncryptionKey: key,
  });

  return Template.fromStack(stack);
}

describe('LambdaConstruct', () => {
  it('creates four lambda functions', () => {
    const template = buildStack();
    template.resourceCountIs('AWS::Lambda::Function', 4);
  });

  it('encrypts all log groups with the provided KMS key', () => {
    const template = buildStack();
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(logGroups).length).toBe(4);
    for (const [, lg] of Object.entries(logGroups)) {
      const props = lg.Properties as Record<string, unknown>;
      expect(props.KmsKeyId).toBeDefined();
    }
  });

  it('scopes agentcore policy to memory resource', () => {
    const template = buildStack('TestStack', { account: '123456789012', region: 'us-east-1' });
    const policies = template.findResources('AWS::IAM::Policy');

    for (const [, policy] of Object.entries(policies)) {
      const props = policy.Properties as Record<string, unknown> | undefined;
      const policyDoc = props?.PolicyDocument as Record<string, unknown> | undefined;
      const statements = (policyDoc?.Statement as Array<Record<string, unknown>>) || [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasAgentcore = actions.some((a: string) => a.startsWith('bedrock-agentcore:'));
        if (hasAgentcore) {
          expect(stmt.Resource).not.toBe('*');
        }
      }
    }
  });

  it('sets reserved concurrency on each lambda', () => {
    const template = buildStack();
    // ingest = 10, recall = 10
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 10,
      TracingConfig: { Mode: 'Active' },
    });
    // context-extractor = 5
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 5,
      TracingConfig: { Mode: 'Active' },
    });
    // digest = 2
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 2,
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('enables X-Ray active tracing on all lambdas', () => {
    const template = buildStack();
    const functions = template.findResources('AWS::Lambda::Function');
    const fnEntries = Object.entries(functions);
    // All 4 lambdas must have active tracing
    const tracedFns = fnEntries.filter(([, resource]) => {
      const props = resource.Properties as Record<string, unknown>;
      const tracingConfig = props.TracingConfig as Record<string, string> | undefined;
      return tracingConfig?.Mode === 'Active';
    });
    expect(tracedFns).toHaveLength(4);
  });

  it('creates SQS DLQ with enforceSSL and 14-day retention', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    });
    // enforceSSL produces a queue policy that denies non-SSL access
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
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

  it('scopes bedrock invoke policy to foundation models', () => {
    const template = buildStack('TestStack2', { account: '123456789012', region: 'us-east-1' });
    const policies = template.findResources('AWS::IAM::Policy');

    for (const [, policy] of Object.entries(policies)) {
      const props = policy.Properties as Record<string, unknown> | undefined;
      const policyDoc = props?.PolicyDocument as Record<string, unknown> | undefined;
      const statements = (policyDoc?.Statement as Array<Record<string, unknown>>) || [];
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
