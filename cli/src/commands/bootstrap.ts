import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadConfig } from '../config';
import { getAccessToken } from '../auth';

export interface BootstrapOptions {
  file: string;
  source?: string;
  project?: string;
}

interface BootstrapResponse {
  event_ids: string[];
  chunk_count: number;
}

export async function bootstrapCmd(opts: BootstrapOptions): Promise<void> {
  if (!opts.file) {
    throw new Error('--file is required');
  }
  const content = await readFile(opts.file, 'utf8');
  if (content.trim() === '') {
    throw new Error(`${opts.file} is empty`);
  }

  const config = loadConfig();
  const token = await getAccessToken({ domain: config.auth0Domain, clientId: config.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }

  const source = opts.source ?? basename(opts.file);
  const body: Record<string, unknown> = { source, content };
  if (opts.project) body.project = opts.project;

  const resp = await fetch(`${config.apiUrl}/bootstrap`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST /bootstrap failed (${resp.status}): ${text.trim()}`);
  }
  const result = (await resp.json()) as BootstrapResponse;
  console.log(`Ingested ${result.chunk_count} chunk(s) from ${source}`);
  console.log(`  ${result.event_ids.length} event(s) queued for extraction`);
}
