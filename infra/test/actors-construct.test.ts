import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ActorsConstruct } from '../lib/actors-construct';

function synth(email?: string, timezone?: string) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  new ActorsConstruct(stack, 'Actors', {
    seedActor: { actorId: 'tiago', email, timezone },
  });
  return Template.fromStack(stack);
}

// The seed custom resource serializes its parameters as a CloudFormation
// Fn::Join, which resolves to a JSON string at deploy time. The resolved
// template lets us assert on the final string rather than the intrinsic.
function resolvedSeedCreate(template: Template): string {
  const resources = template.findResources('Custom::AWS');
  const [props] = Object.values(resources).map((r) => (r as { Properties: { Create: unknown } }).Properties);
  return JSON.stringify(props.Create);
}

describe('ActorsConstruct', () => {
  it('creates a DynamoDB table with actorId as partition key', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'actorId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('retains the table on stack destroy', () => {
    const template = synth();
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('creates a conditional seed custom resource for the default actor', () => {
    const template = synth('tiago@example.com', 'America/Los_Angeles');
    const create = resolvedSeedCreate(template);
    expect(create).toContain('attribute_not_exists(actorId)');
    expect(create).toContain('tiago');
  });

  it('includes email and timezone in the seed payload when provided', () => {
    const template = synth('tiago@example.com', 'America/Los_Angeles');
    const create = resolvedSeedCreate(template);
    expect(create).toContain('tiago@example.com');
    expect(create).toContain('America/Los_Angeles');
  });

  it('omits email and timezone from the seed when not provided', () => {
    const template = synth();
    const create = resolvedSeedCreate(template);
    expect(create).not.toContain('email');
    expect(create).not.toContain('timezone');
  });
});
