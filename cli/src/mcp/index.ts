#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { executeBootstrapContent } from '../commands/bootstrap';
import { executeGetProfile } from '../commands/profile';
import { executePush } from '../commands/push';
import { executeRecall } from '../commands/recall';
import { executeSearch } from '../commands/search';
import { loadConfig } from '../config';
import { createServer } from './server';
import type { BootstrapDocumentToolArgs, MnemoApi, PushEventToolArgs, RecallToolArgs, SearchToolArgs } from './handlers';

function makeApi(): { api: MnemoApi; apiUrl: string } {
  const cfg = loadConfig();
  const auth = {
    apiUrl: cfg.apiUrl,
    auth0Domain: cfg.auth0Domain,
    auth0ClientId: cfg.auth0ClientId,
  };

  const api: MnemoApi = {
    recall: (args: RecallToolArgs) => executeRecall({
      ...auth,
      workstation: cfg.workstation,
      preferences: args.preferences,
      episodes: args.episodes,
      about: args.about,
      project: args.project,
      task: args.task,
      date: args.date,
      daily: args.daily,
      meeting: args.meeting,
      q: args.q,
      tags: args.tags?.join(','),
      tagMode: args.tag_mode,
      since: args.since,
      until: args.until,
      limit: args.limit,
      minSimilarity: args.min_similarity,
    }),
    search: (args: SearchToolArgs) => executeSearch({
      ...auth,
      q: args.q,
      dimensions: args.dimensions,
      tags: args.tags,
      tagMode: args.tag_mode,
      namespacePrefix: args.namespace_prefix,
      since: args.since,
      until: args.until,
      limit: args.limit,
      minSimilarity: args.min_similarity,
    }),
    pushEvent: (args: PushEventToolArgs) => executePush({
      ...auth,
      sessionId: args.session_id,
      turns: args.turns,
      project: args.project,
      source: args.source || 'mnemo-mcp',
      workstation: args.workstation || cfg.workstation,
      workdir: args.workdir || process.cwd(),
      attributes: args.attributes,
    }),
    bootstrapDocument: (args: BootstrapDocumentToolArgs) => executeBootstrapContent({
      ...auth,
      source: args.source,
      content: args.content,
      project: args.project,
    }),
    getProfile: () => executeGetProfile(auth),
  };

  return { api, apiUrl: cfg.apiUrl };
}

async function main(): Promise<void> {
  const { api, apiUrl } = makeApi();
  const server = createServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mnemo-mcp connected (api ${apiUrl})`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`mnemo-mcp failed to start: ${message}`);
  process.exit(1);
});
