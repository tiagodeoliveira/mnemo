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

  const body: Record<string, unknown> = {
    session_id: options.sessionId,
    turns: options.turns,
    source: options.source || 'unknown',
    workstation: options.workstation,
    workdir: options.workdir,
  };
  if (options.project) body.project = options.project;
  if (options.attributes && Object.keys(options.attributes).length > 0) {
    body.attributes = options.attributes;
  }

  const response = await fetch(`${options.apiUrl}/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push failed (${response.status}): ${text}`);
  }
}
