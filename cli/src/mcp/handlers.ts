import { z } from 'zod';
import type { BootstrapResponse } from '../commands/bootstrap';
import type { MeProfile } from '../commands/profile';
import type { PushResponse } from '../commands/push';
import type { RecallResponse } from '../commands/recall';
import type { SearchResponse } from '../commands/search';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface RecallToolArgs {
  preferences?: boolean;
  episodes?: boolean;
  about?: boolean;
  project?: string;
  task?: string;
  date?: string;
  daily?: boolean;
  meeting?: string;
  q?: string;
  tags?: string[];
  tag_mode?: 'any' | 'all';
  since?: string;
  until?: string;
  limit?: number;
  min_similarity?: number;
}

export interface SearchToolArgs {
  q: string;
  dimensions?: string[];
  tags?: string[];
  tag_mode?: 'any' | 'all';
  namespace_prefix?: string;
  since?: string;
  until?: string;
  limit?: number;
  min_similarity?: number;
}

export interface PushEventToolArgs {
  session_id: string;
  turns: Array<{ role: string; content: string }>;
  project?: string;
  source?: string;
  workstation?: string;
  workdir?: string;
  attributes?: Record<string, unknown>;
}

export interface BootstrapDocumentToolArgs {
  source: string;
  content: string;
  project?: string;
}

export interface MnemoApi {
  recall(args: RecallToolArgs): Promise<RecallResponse>;
  search(args: SearchToolArgs): Promise<SearchResponse>;
  pushEvent(args: PushEventToolArgs): Promise<PushResponse>;
  bootstrapDocument(args: BootstrapDocumentToolArgs): Promise<BootstrapResponse>;
  getProfile(): Promise<MeProfile>;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message || 'unexpected mnemo error');
  }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const limitSchema = z.number().int().min(1).max(200).optional();
const tagsSchema = z.array(z.string().min(1)).optional();
const tagModeSchema = z.enum(['any', 'all']).optional();
const turnSchema = z.object({
  role: z.string().min(1),
  content: z.string().min(1),
});

export function makeTools(api: MnemoApi): ToolDef[] {
  return [
    {
      name: 'recall_memories',
      description:
        'Recall scoped mnemo memories. Select one or more dimensions with preferences, episodes, about, project, task, date/daily, or meeting. Optional q reranks selected dimensions semantically.',
      schema: {
        preferences: z.boolean().optional(),
        episodes: z.boolean().optional(),
        about: z.boolean().optional(),
        project: z.string().min(1).optional(),
        task: z.string().min(1).optional(),
        date: dateSchema.optional(),
        daily: z.boolean().optional(),
        meeting: z.string().min(1).optional(),
        q: z.string().min(1).optional(),
        tags: tagsSchema,
        tag_mode: tagModeSchema,
        since: dateSchema.optional(),
        until: dateSchema.optional(),
        limit: limitSchema,
        min_similarity: z.number().min(0).max(1).optional(),
      },
      handler: (args) => guarded(async () => ok(await api.recall(args as RecallToolArgs))),
    },
    {
      name: 'search_memories',
      description:
        'Semantic search across mnemo memories. Use dimensions, tags, namespace_prefix, date range, limit, and min_similarity to narrow results.',
      schema: {
        q: z.string().min(1),
        dimensions: z.array(z.string().min(1)).optional(),
        tags: tagsSchema,
        tag_mode: tagModeSchema,
        namespace_prefix: z.string().min(1).optional(),
        since: dateSchema.optional(),
        until: dateSchema.optional(),
        limit: limitSchema,
        min_similarity: z.number().min(0).max(1).optional(),
      },
      handler: (args) => guarded(async () => ok(await api.search(args as unknown as SearchToolArgs))),
    },
    {
      name: 'push_event',
      description:
        'Push a conversation slice into mnemo memory. This queues asynchronous extraction and returns the event_id accepted by /events.',
      schema: {
        session_id: z.string().min(1),
        turns: z.array(turnSchema).min(1),
        project: z.string().min(1).optional(),
        source: z.string().min(1).optional(),
        workstation: z.string().min(1).optional(),
        workdir: z.string().min(1).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      },
      handler: (args) => guarded(async () => ok(await api.pushEvent(args as unknown as PushEventToolArgs))),
    },
    {
      name: 'bootstrap_document',
      description:
        'Ingest a document body into mnemo as one or more synthetic events. Use project to route project facts into that namespace.',
      schema: {
        source: z.string().min(1),
        content: z.string().min(1),
        project: z.string().min(1).optional(),
      },
      handler: (args) => guarded(async () => ok(await api.bootstrapDocument(args as unknown as BootstrapDocumentToolArgs))),
    },
    {
      name: 'get_profile',
      description:
        'Return the current mnemo actor profile, including digest settings, episode strategy, and task domain vocabulary.',
      schema: {},
      handler: () => guarded(async () => ok(await api.getProfile())),
    },
  ];
}
