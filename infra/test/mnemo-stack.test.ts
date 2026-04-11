import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MnemoStack } from '../lib/mnemo-stack';

describe('MnemoStack', () => {
  it('synthesizes full stack with all resources', () => {
    const app = new cdk.App();
    const stack = new MnemoStack(app, 'TestStack', {
      actorId: 'test-actor',
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
    // 3 app lambdas + 1 observability-setup + 1 cr.Provider framework + 1 auto-delete-objects = 6 with nodejs22.x
    template.resourcePropertiesCountIs('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    }, 6);
  });
});
