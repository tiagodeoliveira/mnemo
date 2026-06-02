import { loadConfig } from '../config';
import { getAccessToken } from '../auth';
import { detectProject } from '../detect-project';
import { localDate } from '../date';

export interface RecallOptions {
  apiUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
  workstation: string;
  preferences?: boolean;
  episodes?: boolean;
  about?: boolean;
  project?: string;
  task?: string;
  date?: string;
  meeting?: string;
  /** Optional semantic ranking query within the selected dimensions. */
  q?: string;
  tags?: string;        // csv
  tagMode?: string;     // 'any' | 'all'
  since?: string;
  until?: string;
  limit?: number;
  minSimilarity?: number;
  format?: 'text' | 'json';
  /**
   * Abort the recall fetch after this many milliseconds. Used by hook callers
   * to prevent a slow server from blocking the prompt. Omitted = no timeout.
   */
  timeoutMs?: number;
}

export interface RecallItem {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  reinforced_count: number;
  similarity?: number;
}

export interface RecallDimension {
  dimension: string;
  namespace: string;
  items: RecallItem[];
}

export interface RecallResponse {
  dimensions: RecallDimension[];
}

export async function executeRecall(options: RecallOptions): Promise<RecallResponse> {
  const token = await getAccessToken({ domain: options.auth0Domain, clientId: options.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }

  const params = new URLSearchParams();
  if (options.preferences) params.set('preferences', 'true');
  if (options.episodes) params.set('episodes', 'true');
  if (options.about) params.set('about', 'true');
  if (options.meeting) params.set('meeting', options.meeting);
  if (options.project) params.set('project', options.project);
  if (options.task) params.set('task', options.task);
  if (options.date) params.set('date', options.date);
  if (options.q) params.set('q', options.q);
  if (options.tags) params.set('tags', options.tags);
  if (options.tagMode) params.set('tag_mode', options.tagMode);
  if (options.since) params.set('since', options.since);
  if (options.until) params.set('until', options.until);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.minSimilarity !== undefined) params.set('min_similarity', String(options.minSimilarity));

  const url = `${options.apiUrl}/recall?${params.toString()}`;

  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timer = controller && options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;

  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Recall failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<RecallResponse>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function renderTextOutput(data: RecallResponse): string {
  const lines: string[] = [];
  for (const dim of data.dimensions) {
    if (!dim.items || dim.items.length === 0) continue;
    lines.push(`${dim.dimension.toUpperCase()} (${dim.items.length} item${dim.items.length === 1 ? '' : 's'})`);
    for (const item of dim.items) {
      lines.push(`  • ${item.content}`);
      const meta: string[] = [];
      if (item.tags && item.tags.length > 0) meta.push(`tags: ${item.tags.join(', ')}`);
      if (item.reinforced_count > 1) meta.push(`reinforced ${item.reinforced_count}×`);
      meta.push(`last ${formatDate(item.updated_at)}`);
      if (item.similarity !== undefined) meta.push(`similarity: ${item.similarity.toFixed(2)}`);
      lines.push(`      ${meta.join(' · ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format recalled memories as a markdown context block suitable for injection
 * into a Claude Code hook (additionalContext). Used by the session-start hook.
 */
export function formatRecallForHook(data: RecallResponse): string {
  const sections: string[] = [];
  for (const dim of data.dimensions) {
    if (!dim.items || dim.items.length === 0) continue;
    const bullets = dim.items.map((it) => `- ${it.content}`).join('\n');
    sections.push(`## ${dim.dimension}\n${bullets}`);
  }
  if (sections.length === 0) return '';
  return sections.join('\n');
}

export async function recallCmd(opts: {
  preferences?: boolean;
  episodes?: boolean;
  about?: boolean;
  project?: string | true;
  task?: string;
  date?: string;
  daily?: boolean;
  meeting?: string;
  all?: boolean;
  q?: string;
  tags?: string;
  tagMode?: string;
  since?: string;
  until?: string;
  limit?: number;
  minSimilarity?: number;
  format?: string;
}): Promise<void> {
  const config = loadConfig();

  const hasProject = opts.project !== undefined;
  const hasTask = opts.task !== undefined;
  const hasDate = opts.date !== undefined || opts.daily;
  const hasMeeting = opts.meeting !== undefined;
  const hasDimension = opts.preferences || opts.episodes || opts.about || hasProject || hasTask || hasDate || hasMeeting || opts.all;

  if (!hasDimension) {
    if (opts.q) {
      process.stderr.write(
        '--q ranks records within a dimension; it is not a standalone search. ' +
        'Combine it with at least one dimension flag (e.g. `mnemo recall --preferences --q "Rust async"`).\n'
      );
      process.exit(2);
    }
    process.stderr.write('Specify at least one dimension flag. Use --all for everything.\n');
    process.exit(2);
  }

  const project = hasProject
    ? (typeof opts.project === 'string' ? opts.project : detectProject())
    : opts.all ? detectProject() : undefined;

  const date = opts.date || (opts.daily || opts.all ? localDate() : undefined);

  const response = await executeRecall({
    apiUrl: config.apiUrl,
    auth0Domain: config.auth0Domain,
    auth0ClientId: config.auth0ClientId,
    workstation: config.workstation,
    preferences: opts.all || opts.preferences,
    episodes: opts.all || opts.episodes,
    about: opts.all || opts.about,
    project,
    task: opts.task || (opts.all ? 'coding' : undefined),
    date,
    meeting: opts.meeting,
    q: opts.q,
    tags: opts.tags,
    tagMode: opts.tagMode,
    since: opts.since,
    until: opts.until,
    limit: opts.limit,
    minSimilarity: opts.minSimilarity,
    format: opts.format === 'json' ? 'json' : 'text',
  });

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const output = renderTextOutput(response);
  if (output) process.stdout.write(output + '\n');
}
