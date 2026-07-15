import { loadConfig } from '../config';
import { getAccessToken } from '../auth';

export interface SearchOptions {
  q: string;
  dimensions?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  namespacePrefix?: string;
  since?: string;
  until?: string;
  limit?: number;
  minSimilarity?: number;
  format?: 'text' | 'json';
}

export interface SearchExecuteOptions extends SearchOptions {
  apiUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
}

export interface SearchResultItem {
  id: string;
  dimension: string;
  namespace: string;
  content: string;
  tags: string[];
  similarity: number;
  created_at: string;
  updated_at: string;
  reinforced_count: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
  query_embedding_cost_tokens: number;
}

export async function executeSearch(opts: SearchExecuteOptions): Promise<SearchResponse> {
  const token = await getAccessToken({ domain: opts.auth0Domain, clientId: opts.auth0ClientId });
  if (!token) throw new Error("Not logged in. Run 'mnemo login' first.");

  const body: Record<string, unknown> = { q: opts.q };
  if (opts.dimensions?.length) body.dimensions = opts.dimensions;
  if (opts.tags?.length) body.tags = opts.tags;
  if (opts.tagMode) body.tag_mode = opts.tagMode;
  if (opts.namespacePrefix) body.namespace_prefix = opts.namespacePrefix;
  if (opts.since) body.since = opts.since;
  if (opts.until) body.until = opts.until;
  if (opts.limit) body.limit = opts.limit;
  if (opts.minSimilarity !== undefined) body.min_similarity = opts.minSimilarity;

  const res = await fetch(`${opts.apiUrl}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`search: ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as SearchResponse;
}

export async function searchCmd(opts: SearchOptions): Promise<void> {
  const cfg = loadConfig();
  const data = await executeSearch({
    ...opts,
    apiUrl: cfg.apiUrl,
    auth0Domain: cfg.auth0Domain,
    auth0ClientId: cfg.auth0ClientId,
  });

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (!data.results || data.results.length === 0) {
    console.log(`No matches for "${opts.q}"`);
    return;
  }
  console.log(`Top ${data.results.length} results for "${opts.q}" (cost: ${data.query_embedding_cost_tokens} tokens)\n`);
  for (const r of data.results) {
    const sim = (r.similarity * 100).toFixed(0);
    const reinforce = r.reinforced_count > 1 ? ` · reinforced ${r.reinforced_count}×` : '';
    const tags = r.tags?.length ? ` · tags: ${r.tags.join(', ')}` : '';
    console.log(`  ${sim}%  [${r.dimension}] ${r.content}`);
    console.log(`        ${r.namespace}${reinforce}${tags}`);
  }
}
