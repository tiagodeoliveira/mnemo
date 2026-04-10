import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface AlarmThresholds {
  /** Lambda invocation error count threshold (default 3). */
  lambdaErrorCount?: number;
  /** Application-level (log-based) error count threshold (default 1). */
  lambdaAppErrorCount?: number;
  /** P99 duration threshold in ms for ingest and recall (default 10000). */
  ingestDurationP99Ms?: number;
  /** P99 duration threshold in ms for context extractor and digest (default 120000). */
  extractorDurationP99Ms?: number;
  /** Lambda throttle count threshold (default 1). */
  throttleCount?: number;
  /** API Gateway 5xx error count threshold (default 5). */
  api5xxCount?: number;
}

export interface ObservabilityConstructProps {
  ingestFunction: lambda.IFunction;
  recallFunction: lambda.IFunction;
  contextExtractorFunction: lambda.IFunction;
  digestFunction: lambda.IFunction;
  ingestLogGroup: logs.ILogGroup;
  recallLogGroup: logs.ILogGroup;
  contextExtractorLogGroup: logs.ILogGroup;
  digestLogGroup: logs.ILogGroup;
  api: apigw.RestApi;
  deadLetterQueues?: sqs.IQueue[];
  alarmEmail?: string;
  alarmThresholds?: AlarmThresholds;
}

export class ObservabilityConstruct extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);

    const prefix = cdk.Stack.of(this).stackName.toLowerCase();

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${prefix}-alarms`,
    });

    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.alarmEmail)
      );
    }

    const thresholds = props.alarmThresholds ?? {};
    const lambdaErrorCount = thresholds.lambdaErrorCount ?? 3;
    const lambdaAppErrorCount = thresholds.lambdaAppErrorCount ?? 1;
    const ingestDurationP99Ms = thresholds.ingestDurationP99Ms ?? 10000;
    const extractorDurationP99Ms = thresholds.extractorDurationP99Ms ?? 120000;
    const throttleCount = thresholds.throttleCount ?? 1;
    const api5xxCount = thresholds.api5xxCount ?? 5;

    const fns = [
      { name: 'Ingest', fn: props.ingestFunction, logGroup: props.ingestLogGroup },
      { name: 'Recall', fn: props.recallFunction, logGroup: props.recallLogGroup },
      { name: 'ContextExtractor', fn: props.contextExtractorFunction, logGroup: props.contextExtractorLogGroup },
      { name: 'Digest', fn: props.digestFunction, logGroup: props.digestLogGroup },
    ];

    const alarms: cloudwatch.Alarm[] = [];

    for (const { name, fn, logGroup } of fns) {
      const errorAlarm = fn.metricErrors({ period: cdk.Duration.minutes(5) })
        .createAlarm(this, `${name}ErrorAlarm`, {
          alarmName: `${prefix}-${name.toLowerCase()}-errors`,
          evaluationPeriods: 2,
          threshold: lambdaErrorCount,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
      alarms.push(errorAlarm);

      const durationAlarm = fn.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99' })
        .createAlarm(this, `${name}DurationAlarm`, {
          alarmName: `${prefix}-${name.toLowerCase()}-duration-p99`,
          evaluationPeriods: 2,
          threshold: (name === 'ContextExtractor' || name === 'Digest') ? extractorDurationP99Ms : ingestDurationP99Ms,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
      alarms.push(durationAlarm);

      const throttleAlarm = fn.metricThrottles({ period: cdk.Duration.minutes(5) })
        .createAlarm(this, `${name}ThrottleAlarm`, {
          alarmName: `${prefix}-${name.toLowerCase()}-throttles`,
          evaluationPeriods: 1,
          threshold: throttleCount,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
      alarms.push(throttleAlarm);

      const metricFilter = new logs.MetricFilter(this, `${name}AppErrorFilter`, {
        logGroup,
        filterPattern: logs.FilterPattern.literal('ERROR'),
        metricNamespace: 'mnemo',
        metricName: `${name}AppErrors`,
        metricValue: '1',
        defaultValue: 0,
      });
      const appErrorAlarm = new cloudwatch.Alarm(this, `${name}AppErrorAlarm`, {
        alarmName: `${prefix}-${name.toLowerCase()}-app-errors`,
        metric: metricFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        evaluationPeriods: 1,
        threshold: lambdaAppErrorCount,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarms.push(appErrorAlarm);
    }

    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: `${prefix}-api-5xx`,
      metric: props.api.metricServerError({ period: cdk.Duration.minutes(5) }),
      evaluationPeriods: 2,
      threshold: api5xxCount,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarms.push(api5xxAlarm);

    for (const [i, dlq] of (props.deadLetterQueues ?? []).entries()) {
      const dlqAlarm = new cloudwatch.Alarm(this, `DlqAlarm${i}`, {
        alarmName: `${prefix}-dlq-${i}-not-empty`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarms.push(dlqAlarm);
    }

    for (const alarm of alarms) {
      alarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));
      alarm.addOkAction(new cw_actions.SnsAction(this.alarmTopic));
    }

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: prefix,
    });

    const totalEvents = new cloudwatch.Metric({
      namespace: 'mnemo',
      metricName: 'EventsIngested',
      dimensionsMap: { Service: 'ingest' },
      statistic: 'Sum',
    });

    const totalTurns = new cloudwatch.Metric({
      namespace: 'mnemo',
      metricName: 'TurnsIngested',
      dimensionsMap: { Service: 'ingest' },
      statistic: 'Sum',
    });

    const totalDigests = new cloudwatch.Metric({
      namespace: 'mnemo',
      metricName: 'DigestsGenerated',
      dimensionsMap: { Service: 'digest' },
      statistic: 'Sum',
    });

    this.dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Events Ingested',
        metrics: [totalEvents],
        setPeriodToTimeRange: true,
        width: 5,
        height: 3,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Turns Ingested',
        metrics: [totalTurns],
        setPeriodToTimeRange: true,
        width: 5,
        height: 3,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Digests Generated',
        metrics: [totalDigests],
        setPeriodToTimeRange: true,
        width: 4,
        height: 3,
      }),
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarm Status',
        alarms,
        width: 10,
        height: 3,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway Requests',
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          props.api.metricCount({ period: cdk.Duration.minutes(1) }),
          props.api.metricServerError({ period: cdk.Duration.minutes(1) }),
          props.api.metricClientError({ period: cdk.Duration.minutes(1) }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway Latency',
        left: [
          props.api.metricLatency({ period: cdk.Duration.minutes(1), statistic: 'p50' }),
          props.api.metricLatency({ period: cdk.Duration.minutes(1), statistic: 'p99' }),
        ],
        width: 12,
        height: 6,
      })
    );

    for (const { name, fn } of fns) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${name}: Invocations & Errors`,
          view: cloudwatch.GraphWidgetView.BAR,
          left: [
            fn.metricInvocations({ period: cdk.Duration.minutes(1) }),
            fn.metricErrors({ period: cdk.Duration.minutes(1) }),
            fn.metricThrottles({ period: cdk.Duration.minutes(1) }),
          ],
          width: 8,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${name}: Duration`,
          left: [
            fn.metricDuration({ period: cdk.Duration.minutes(1), statistic: 'p50' }),
            fn.metricDuration({ period: cdk.Duration.minutes(1), statistic: 'p99' }),
            fn.metricDuration({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
          ],
          width: 8,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${name}: Concurrent Executions`,
          view: cloudwatch.GraphWidgetView.BAR,
          left: [
            fn.metric('ConcurrentExecutions', { period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
          ],
          width: 8,
          height: 6,
        })
      );
    }
  }
}
