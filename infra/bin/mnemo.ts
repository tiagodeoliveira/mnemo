#!/usr/bin/env node
import 'source-map-support/register';
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { MnemoStack } from '../lib/mnemo-stack';

const app = new cdk.App();

const actorId = app.node.tryGetContext('actorId') || process.env.ACTOR_ID;
if (!actorId) {
  throw new Error('actorId is required: set ACTOR_ID in infra/.env or pass --context actorId=<your-name>');
}

const notificationEmail = app.node.tryGetContext('notificationEmail') || process.env.NOTIFICATION_EMAIL;

const rawEnvironment = app.node.tryGetContext('environment') || process.env.ENVIRONMENT;
if (rawEnvironment !== undefined && rawEnvironment !== 'dev' && rawEnvironment !== 'production') {
  throw new Error(`environment must be 'dev' or 'production' (got "${rawEnvironment}")`);
}

new MnemoStack(app, 'MnemoStack', {
  actorId,
  notificationEmail,
  digestSchedule: app.node.tryGetContext('digestSchedule') || process.env.DIGEST_SCHEDULE,
  digestTimezone: app.node.tryGetContext('digestTimezone') || process.env.DIGEST_TIMEZONE,
  environment: rawEnvironment,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
