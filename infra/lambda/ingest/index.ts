import {
  BedrockAgentCoreClient,
  CreateEventCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { IngestRequest } from '../shared/types';

const client = new BedrockAgentCoreClient({});

const ROLE_MAP: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const body: IngestRequest = JSON.parse(event.body || '{}');

    if (!body.turns || body.turns.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'turns is required and must not be empty' }) };
    }
    if (!body.sessionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'sessionId is required' }) };
    }

    const payload = body.turns.map((turn) => ({
      conversational: {
        content: { text: turn.content },
        role: ROLE_MAP[turn.role] || 'OTHER',
      },
    }));

    const metadata: Record<string, { stringValue: string }> = {
      workstation: { stringValue: body.context.workstation },
      workdir: { stringValue: body.context.workdir },
    };
    if (body.context.project) {
      metadata.project = { stringValue: body.context.project };
    }

    await client.send(
      new CreateEventCommand({
        memoryId: process.env.MEMORY_ID!,
        actorId: process.env.ACTOR_ID!,
        sessionId: body.sessionId,
        eventTimestamp: new Date(body.context.timestamp),
        payload,
        metadata,
      })
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error('Ingest error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
