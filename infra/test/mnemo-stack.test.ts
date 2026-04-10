import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MnemoStack } from '../lib/mnemo-stack';

describe('MnemoStack', () => {
  it('synthesizes without errors', () => {
    const app = new cdk.App();
    const stack = new MnemoStack(app, 'TestStack', {
      actorId: 'test-actor',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });
});
