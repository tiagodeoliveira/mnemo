import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ObservabilityConstruct } from '../lib/observability-construct';
import type { AlarmThresholds } from '../lib/observability-construct';

interface BuildOptions {
  alarmEmail?: string;
  alarmThresholds?: AlarmThresholds;
  dlqCount?: number;
}

function buildStack(opts: BuildOptions = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');

  const fn1 = new lambda.Function(stack, 'Fn1', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {}'),
  });
  const fn2 = new lambda.Function(stack, 'Fn2', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {}'),
  });
  const fn3 = new lambda.Function(stack, 'Fn3', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {}'),
  });
  const fn4 = new lambda.Function(stack, 'Fn4', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {}'),
  });

  const lg1 = new logs.LogGroup(stack, 'Lg1');
  const lg2 = new logs.LogGroup(stack, 'Lg2');
  const lg3 = new logs.LogGroup(stack, 'Lg3');
  const lg4 = new logs.LogGroup(stack, 'Lg4');

  const dlqs: sqs.IQueue[] = [];
  for (let i = 0; i < (opts.dlqCount ?? 0); i++) {
    dlqs.push(new sqs.Queue(stack, `Dlq${i}`));
  }

  const api = new apigw.RestApi(stack, 'Api');
  api.root.addMethod('GET');

  new ObservabilityConstruct(stack, 'Obs', {
    ingestFunction: fn1,
    recallFunction: fn2,
    contextExtractorFunction: fn3,
    digestFunction: fn4,
    ingestLogGroup: lg1,
    recallLogGroup: lg2,
    contextExtractorLogGroup: lg3,
    digestLogGroup: lg4,
    api,
    deadLetterQueues: dlqs.length > 0 ? dlqs : undefined,
    alarmEmail: opts.alarmEmail,
    alarmThresholds: opts.alarmThresholds,
  });

  return Template.fromStack(stack);
}

describe('ObservabilityConstruct', () => {
  it('creates alarms for each lambda plus API 5xx', () => {
    const template = buildStack();
    // 4 lambdas x 4 alarms (errors, duration, throttles, app-errors) + 1 API 5xx = 17
    template.resourceCountIs('AWS::CloudWatch::Alarm', 17);
  });

  it('creates a dashboard', () => {
    const template = buildStack();
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'teststack',
    });
  });

  it('creates an SNS alarm topic', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'teststack-alarms',
    });
  });

  it('adds email subscription when alarmEmail is provided', () => {
    const template = buildStack({ alarmEmail: 'ops@example.com' });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  it('does not add email subscription when alarmEmail is omitted', () => {
    const template = buildStack();
    const subscriptions = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({ Protocol: 'email' }),
    });
    expect(Object.keys(subscriptions)).toHaveLength(0);
  });

  it('configures higher duration threshold for context extractor and digest', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-contextextractor-duration-p99',
      Threshold: 120000,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-digest-duration-p99',
      Threshold: 120000,
    });
  });

  it('configures standard duration threshold for ingest and recall', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-ingest-duration-p99',
      Threshold: 10000,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-recall-duration-p99',
      Threshold: 10000,
    });
  });

  it('creates DLQ alarms when dead letter queues are provided', () => {
    const template = buildStack({ dlqCount: 2 });
    // 17 base alarms + 2 DLQ alarms = 19
    template.resourceCountIs('AWS::CloudWatch::Alarm', 19);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-dlq-0-not-empty',
      Threshold: 1,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-dlq-1-not-empty',
      Threshold: 1,
    });
  });

  it('allows overriding alarm thresholds via alarmThresholds prop', () => {
    const template = buildStack({
      alarmThresholds: {
        lambdaErrorCount: 10,
        lambdaAppErrorCount: 5,
        ingestDurationP99Ms: 20000,
        extractorDurationP99Ms: 300000,
        throttleCount: 3,
        api5xxCount: 20,
      },
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-ingest-errors',
      Threshold: 10,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-ingest-app-errors',
      Threshold: 5,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-ingest-duration-p99',
      Threshold: 20000,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-contextextractor-duration-p99',
      Threshold: 300000,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-digest-duration-p99',
      Threshold: 300000,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-ingest-throttles',
      Threshold: 3,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'teststack-api-5xx',
      Threshold: 20,
    });
  });
});
