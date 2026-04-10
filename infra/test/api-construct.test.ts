import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiConstruct } from '../lib/api-construct';

function buildStack() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');

  const dummyFn = new lambda.Function(stack, 'DummyIngest', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = () => {}'),
  });
  const dummyRecall = new lambda.Function(stack, 'DummyRecall', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = () => {}'),
  });
  const key = new kms.Key(stack, 'LogKey');

  new ApiConstruct(stack, 'Api', {
    ingestFunction: dummyFn,
    recallFunction: dummyRecall,
    logEncryptionKey: key,
  });

  return Template.fromStack(stack);
}

describe('ApiConstruct', () => {
  it('creates API Gateway with API key and two routes', () => {
    const template = buildStack();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
    });
  });

  it('configures access logging on the deployment stage', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      AccessLogSetting: {
        DestinationArn: Match.anyValue(),
        Format: Match.anyValue(),
      },
    });
  });

  it('creates a log group for API access logs', () => {
    const template = buildStack();
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  it('encrypts the access log group with the provided KMS key', () => {
    const template = buildStack();
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(logGroups).length).toBe(1);
    for (const [, lg] of Object.entries(logGroups)) {
      const props = lg.Properties as Record<string, unknown>;
      expect(props.KmsKeyId).toBeDefined();
    }
  });

  it('configures usage plan throttling', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      Throttle: {
        RateLimit: 10,
        BurstLimit: 20,
      },
    });
  });
});
