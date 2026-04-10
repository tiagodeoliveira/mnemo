import { localDate } from '../date';

export interface PushOptions {
  apiUrl: string;
  apiKey: string;
  sessionId: string;
  turns: Array<{ role: string; content: string }>;
  project?: string;
  workstation: string;
  workdir: string;
  source?: string;
}

export async function executePush(options: PushOptions): Promise<void> {
  const now = new Date();
  const context: Record<string, unknown> = {
    workstation: options.workstation,
    workdir: options.workdir,
    timestamp: now.toISOString(),
    date: localDate(now),
  };
  if (options.project) context.project = options.project;
  context.source = options.source || 'unknown';

  const response = await fetch(`${options.apiUrl}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
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
