import { describe, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiConstruct } from '../lib/api-construct';

describe('ApiConstruct', () => {
  it('creates API Gateway with API key and two routes', () => {
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

    new ApiConstruct(stack, 'Api', {
      ingestFunction: dummyFn,
      recallFunction: dummyRecall,
    });

    const template = Template.fromStack(stack);
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
});
