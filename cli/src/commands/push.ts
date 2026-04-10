export interface PushOptions {
  apiUrl: string;
  apiKey: string;
  sessionId: string;
  turns: Array<{ role: string; content: string }>;
  project?: string;
  workstation: string;
  workdir: string;
}

export async function executePush(options: PushOptions): Promise<void> {
  const response = await fetch(`${options.apiUrl}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify({
      sessionId: options.sessionId,
      turns: options.turns,
      context: {
        project: options.project,
        workstation: options.workstation,
        workdir: options.workdir,
        timestamp: new Date().toISOString(),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push failed (${response.status}): ${text}`);
  }
}
