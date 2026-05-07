import { describe, it } from 'vitest';
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
    template.resourceCountIs('AWS::SNS::Topic', 2);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    // 4 app lambdas + dispatcher + observability-setup + cr.Provider framework
    // + actor-seed custom-resource lambda = 8. The auto-delete-objects lambda
    // only exists when environment=dev.
    template.resourcePropertiesCountIs('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    }, 8);
  });
});
