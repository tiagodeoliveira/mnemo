import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface MnemoStackProps extends cdk.StackProps {
  actorId: string;
}

export class MnemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MnemoStackProps) {
    super(scope, id, props);
  }
}
