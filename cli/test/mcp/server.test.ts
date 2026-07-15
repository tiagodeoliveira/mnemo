import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import type { MnemoApi } from '../../src/mcp/handlers';
import { createServer } from '../../src/mcp/server';

const noopApi: MnemoApi = {
  recall: async () => ({ dimensions: [] }),
  search: async () => ({ results: [], query_embedding_cost_tokens: 0 }),
  pushEvent: async () => ({ event_id: 'evt-1' }),
  bootstrapDocument: async () => ({ event_ids: ['evt-1'], chunk_count: 1 }),
  getProfile: async () => ({
    actor_id: 'alice',
    display_name: 'alice',
    timezone: 'UTC',
    digest_enabled: false,
    episode_strategy: 'monthly_bucket',
    task_domains: ['coding', 'general'],
  }),
};

describe('createServer', () => {
  it('registers the mnemo tools over MCP', async () => {
    const server = createServer(noopApi);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bootstrap_document',
      'get_profile',
      'push_event',
      'recall_memories',
      'search_memories',
    ].sort());

    await client.close();
    await server.close();
  });
});
