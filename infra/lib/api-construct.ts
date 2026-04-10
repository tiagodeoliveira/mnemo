import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ApiConstructProps {
  ingestFunction: lambda.IFunction;
  recallFunction: lambda.IFunction;
  logEncryptionKey: kms.IKey;
}

export class ApiConstruct extends Construct {
  public readonly api: apigw.RestApi;
  public readonly apiKey: apigw.IApiKey;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.logEncryptionKey,
    });

    const prefix = cdk.Stack.of(this).stackName.toLowerCase();

    this.api = new apigw.RestApi(this, 'MnemoApi', {
      restApiName: `${prefix}-api`,
      deployOptions: {
        stageName: 'v1',
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    const events = this.api.root.addResource('events');
    events.addMethod('POST', new apigw.LambdaIntegration(props.ingestFunction), {
      apiKeyRequired: true,
    });

    const recall = this.api.root.addResource('recall');
    recall.addMethod('GET', new apigw.LambdaIntegration(props.recallFunction), {
      apiKeyRequired: true,
    });

    this.apiKey = this.api.addApiKey('MnemoApiKey', {
      apiKeyName: `${prefix}-key`,
    });

    const usagePlan = this.api.addUsagePlan('MnemoUsagePlan', {
      name: `${prefix}-usage-plan`,
      throttle: {
        rateLimit: 10,
        burstLimit: 20,
      },
    });

    usagePlan.addApiKey(this.apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    this.apiUrl = this.api.url;

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: this.apiKey.keyId });
  }
}
