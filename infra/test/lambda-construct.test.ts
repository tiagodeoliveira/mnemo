import { describe, it } from 'vitest';
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
});
