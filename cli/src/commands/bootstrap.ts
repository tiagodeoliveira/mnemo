import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadConfig } from '../config';
import { getAccessToken } from '../auth';

export interface BootstrapOptions {
  file: string;
  source?: string;
  project?: string;
}

export interface BootstrapContentOptions {
  apiUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
  source: string;
  content: string;
  project?: string;
}

export interface BootstrapResponse {
  event_ids: string[];
  chunk_count: number;
}

export async function executeBootstrapContent(opts: BootstrapContentOptions): Promise<BootstrapResponse> {
  if (opts.content.trim() === '') {
    throw new Error('bootstrap content is empty');
  }

  const token = await getAccessToken({ domain: opts.auth0Domain, clientId: opts.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }

  const body: Record<string, unknown> = { source: opts.source, content: opts.content };
  if (opts.project) body.project = opts.project;

  const resp = await fetch(`${opts.apiUrl}/bootstrap`, {
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
  return (await resp.json()) as BootstrapResponse;
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
  const source = opts.source ?? basename(opts.file);
  const result = await executeBootstrapContent({
    apiUrl: config.apiUrl,
    auth0Domain: config.auth0Domain,
    auth0ClientId: config.auth0ClientId,
    source,
    content,
    project: opts.project,
  });
  console.log(`Ingested ${result.chunk_count} chunk(s) from ${source}`);
  console.log(`  ${result.event_ids.length} event(s) queued for extraction`);
}
