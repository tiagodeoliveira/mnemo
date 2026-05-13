import { localDate } from '../date';
import { getAccessToken } from '../auth';

export interface PushOptions {
  apiUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
  sessionId: string;
  turns: Array<{ role: string; content: string }>;
  project?: string;
  workstation: string;
  workdir: string;
  source?: string;
  attributes?: Record<string, string>;
}

export async function executePush(options: PushOptions): Promise<void> {
  const token = await getAccessToken({ domain: options.auth0Domain, clientId: options.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }

  const now = new Date();
  const context: Record<string, unknown> = {
    workstation: options.workstation,
    workdir: options.workdir,
    timestamp: now.toISOString(),
    date: localDate(now),
  };
  if (options.project) context.project = options.project;
  context.source = options.source || 'unknown';
  if (options.attributes && Object.keys(options.attributes).length > 0) {
    context.attributes = options.attributes;
  }

  const response = await fetch(`${options.apiUrl}/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      sessionId: options.sessionId,
      turns: options.turns,
      context,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push failed (${response.status}): ${text}`);
  }
}
