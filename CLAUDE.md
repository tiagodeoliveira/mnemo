# mnemo

Centralized AI memory system using Amazon Bedrock AgentCore Memory.

## Structure

- `infra/` — CDK stack (TypeScript): API Gateway, Lambdas, AgentCore Memory
- `cli/` — CLI tool installed on workstations
- `hooks/` — Claude Code hook scripts

## Commands

- `cd infra && npx cdk synth` — synthesize CloudFormation template
- `cd infra && npx cdk deploy` — deploy stack
- `cd infra && npx vitest` — run infra tests
- `cd cli && npx vitest` — run CLI tests
- `npm install` — install all workspace dependencies

## Conventions

- TypeScript everywhere
- vitest for testing
- CDK assertions for infrastructure tests
- AWS SDK v3 client mocking with aws-sdk-client-mock for Lambda unit tests
