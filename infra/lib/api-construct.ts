import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ApiConstructProps {
  ingestFunction: lambda.IFunction;
  recallFunction: lambda.IFunction;
}

export class ApiConstruct extends Construct {
  public readonly api: apigw.RestApi;
  public readonly apiKey: apigw.IApiKey;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    this.api = new apigw.RestApi(this, 'MnemoApi', {
      restApiName: 'mnemo-api',
      deployOptions: {
        stageName: 'v1',
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
      apiKeyName: 'mnemo-key',
    });

    const usagePlan = this.api.addUsagePlan('MnemoUsagePlan', {
      name: 'mnemo-usage-plan',
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
