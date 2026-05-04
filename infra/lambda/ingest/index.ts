import {
  BedrockAgentCoreClient,
  CreateEventCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { PayloadType } from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { IngestRequest } from '../shared/types';

if (!process.env.MEMORY_ID || !process.env.ACTOR_ID) {
  throw new Error('Missing required env vars: MEMORY_ID, ACTOR_ID');
}

const client = new BedrockAgentCoreClient({});

const ROLE_MAP: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'OTHER',
};

const MAX_TURNS = 200;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_FIELD_LENGTH = 256;
const MAX_WORKDIR_LENGTH = 2048;
const MAX_ATTRIBUTES = 32;
const MAX_ATTR_KEY_LENGTH = 64;
const MAX_ATTR_VALUE_LENGTH = 512;
const ATTR_KEY_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function errorResponse(statusCode: number, error: string): APIGatewayProxyResult {
  return { statusCode, body: JSON.stringify({ error }), headers: { 'Content-Type': 'application/json' } };
}

function validateBody(event: APIGatewayProxyEvent): IngestRequest | APIGatewayProxyResult {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
  if (!contentType.includes('application/json')) {
    return errorResponse(415, 'Content-Type must be application/json');
  }

  if (!event.body) {
    return errorResponse(400, 'Request body is required');
  }

  let body: IngestRequest;
  try {
    body = JSON.parse(event.body);
  } catch {
    return errorResponse(400, 'Invalid JSON');
  }

  if (!body.sessionId || typeof body.sessionId !== 'string' || body.sessionId.length > MAX_FIELD_LENGTH) {
    return errorResponse(400, 'sessionId is required and must be a string (max 256 chars)');
  }
  if (!Array.isArray(body.turns) || body.turns.length === 0) {
    return errorResponse(400, 'turns must be a non-empty array');
  }
  if (body.turns.length > MAX_TURNS) {
    return errorResponse(400, `turns exceeds maximum of ${MAX_TURNS}`);
  }
  for (const turn of body.turns) {
    if (!turn.role || !['user', 'assistant', 'tool'].includes(turn.role)) {
      return errorResponse(400, 'Each turn must have role: user, assistant, or tool');
    }
    if (typeof turn.content !== 'string' || turn.content.length > MAX_CONTENT_LENGTH) {
      return errorResponse(400, `turn content must be a string (max ${MAX_CONTENT_LENGTH} chars)`);
    }
  }
  if (!body.context || typeof body.context !== 'object') {
    return errorResponse(400, 'context is required');
  }
  if (!body.context.workstation || body.context.workstation.length > MAX_FIELD_LENGTH) {
    return errorResponse(400, 'context.workstation is required (max 256 chars)');
  }
  if (!body.context.workdir || body.context.workdir.length > MAX_WORKDIR_LENGTH) {
    return errorResponse(400, 'context.workdir is required (max 2048 chars)');
  }
  if (!body.context.timestamp) {
    return errorResponse(400, 'context.timestamp is required');
  }
  const ts = new Date(body.context.timestamp);
  if (isNaN(ts.getTime())) {
    return errorResponse(400, 'context.timestamp must be a valid ISO date');
  }
  if (body.context.project && body.context.project.length > MAX_FIELD_LENGTH) {
    return errorResponse(400, `context.project exceeds maximum of ${MAX_FIELD_LENGTH} chars`);
  }
  if (body.context.source && body.context.source.length > MAX_FIELD_LENGTH) {
    return errorResponse(400, `context.source exceeds maximum of ${MAX_FIELD_LENGTH} chars`);
  }
  if (body.context.attributes !== undefined) {
    if (typeof body.context.attributes !== 'object' || Array.isArray(body.context.attributes)) {
      return errorResponse(400, 'context.attributes must be an object of string key/value pairs');
    }
    const entries = Object.entries(body.context.attributes);
    if (entries.length > MAX_ATTRIBUTES) {
      return errorResponse(400, `context.attributes exceeds maximum of ${MAX_ATTRIBUTES} entries`);
    }
    for (const [key, value] of entries) {
      if (!ATTR_KEY_PATTERN.test(key) || key.length > MAX_ATTR_KEY_LENGTH) {
        return errorResponse(400, `context.attributes key "${key}" must match ${ATTR_KEY_PATTERN} (max ${MAX_ATTR_KEY_LENGTH} chars)`);
      }
      if (typeof value !== 'string' || value.length > MAX_ATTR_VALUE_LENGTH) {
        return errorResponse(400, `context.attributes["${key}"] must be a string (max ${MAX_ATTR_VALUE_LENGTH} chars)`);
      }
    }
  }

  return body;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const validated = validateBody(event);
    if ('statusCode' in validated) return validated;
    const body = validated;

    // Build metadata context line to embed in conversation
    // AgentCore S3 payload only includes conversation turns, not event metadata,
    // so we prepend a context turn that the extractor can parse deterministically.
    const date = body.context.date || body.context.timestamp.slice(0, 10);
    const ctxPayload: Record<string, string | Record<string, string>> = {
      source: body.context.source || 'unknown',
      workstation: body.context.workstation,
      date,
    };
    if (body.context.project) ctxPayload.project = body.context.project;
    if (body.context.attributes && Object.keys(body.context.attributes).length > 0) {
      ctxPayload.attributes = body.context.attributes;
    }

    const contextTurn: PayloadType = {
      conversational: {
        content: { text: `[mnemo-context: ${JSON.stringify(ctxPayload)}]` },
        role: 'OTHER' as const,
      },
    } as PayloadType;

    const conversationTurns: PayloadType[] = body.turns.map((turn) => ({
      conversational: {
        content: { text: turn.content },
        role: (ROLE_MAP[turn.role] || 'OTHER') as 'USER' | 'ASSISTANT' | 'OTHER' | 'TOOL',
      },
    } as PayloadType));

    const payload: PayloadType[] = [contextTurn, ...conversationTurns];

    const metadata: Record<string, { stringValue: string }> = {
      workstation: { stringValue: body.context.workstation },
      workdir: { stringValue: body.context.workdir },
    };
    if (body.context.project) {
      metadata.project = { stringValue: body.context.project };
    }
    if (body.context.source) {
      metadata.source = { stringValue: body.context.source };
    }

    metadata.date = { stringValue: date };

    if (body.context.attributes) {
      for (const [key, value] of Object.entries(body.context.attributes)) {
        metadata[`attr.${key}`] = { stringValue: value };
      }
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

    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: 'mnemo',
          Dimensions: [['Service']],
          Metrics: [
            { Name: 'EventsIngested', Unit: 'Count' },
            { Name: 'TurnsIngested', Unit: 'Count' },
          ],
        }],
      },
      Service: 'ingest',
      EventsIngested: 1,
      TurnsIngested: body.turns.length,
    }));

    return { statusCode: 200, body: JSON.stringify({ ok: true }), headers: { 'Content-Type': 'application/json' } };
  } catch (err: unknown) {
    console.error('Ingest error:', err);
    return errorResponse(500, 'Internal server error');
  }
}
