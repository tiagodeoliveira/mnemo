import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MemoryConstruct } from './memory-construct';
import { LambdaConstruct } from './lambda-construct';
import { ApiConstruct } from './api-construct';

export interface MnemoStackProps extends cdk.StackProps {
  actorId: string;
  modelId?: string;
}

export class MnemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MnemoStackProps) {
    super(scope, id, props);

    const memory = new MemoryConstruct(this, 'Memory', {
      memoryName: 'mnemo_memory',
      actorId: props.actorId,
    });

    const lambdas = new LambdaConstruct(this, 'Lambdas', {
      memoryId: memory.memoryId,
      actorId: props.actorId,
      snsTopic: memory.snsTopic,
      payloadBucket: memory.payloadBucket,
      modelId: props.modelId,
    });

    new ApiConstruct(this, 'Api', {
      ingestFunction: lambdas.ingestFunction,
      recallFunction: lambdas.recallFunction,
    });
  }
}
