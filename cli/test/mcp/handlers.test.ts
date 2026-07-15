import { describe, expect, it } from 'vitest';
import type { MnemoApi } from '../../src/mcp/handlers';
import { makeTools } from '../../src/mcp/handlers';

function fakeApi(overrides: Partial<MnemoApi> = {}): MnemoApi {
  return {
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
    ...overrides,
  };
}

function tool(name: string, api: MnemoApi) {
  const found = makeTools(api).find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function parseText(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe('mnemo MCP tools', () => {
  it('exposes the expected tools in order', () => {
    expect(makeTools(fakeApi()).map((t) => t.name)).toEqual([
      'recall_memories',
      'search_memories',
      'push_event',
      'bootstrap_document',
      'get_profile',
    ]);
  });

  it('recall_memories forwards dimension and filter arguments', async () => {
    let seen: unknown;
    const res = await tool('recall_memories', fakeApi({
      recall: async (args) => {
        seen = args;
        return { dimensions: [{ dimension: 'preferences', namespace: '/preferences/alice/', items: [] }] };
      },
    })).handler({ preferences: true, project: 'mnemo', tags: ['language'], tag_mode: 'all' });

    expect(seen).toEqual({ preferences: true, project: 'mnemo', tags: ['language'], tag_mode: 'all' });
    expect(parseText(res).dimensions[0].dimension).toBe('preferences');
  });

  it('search_memories returns search results as JSON text', async () => {
    const res = await tool('search_memories', fakeApi({
      search: async () => ({
        query_embedding_cost_tokens: 3,
        results: [{
          id: 'm1',
          dimension: 'project',
          namespace: '/projects/alice/mnemo/',
          content: 'mnemo uses pgvector',
          tags: ['architecture'],
          similarity: 0.91,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          reinforced_count: 2,
        }],
      }),
    })).handler({ q: 'pgvector' });

    const out = parseText(res);
    expect(out.results[0].content).toBe('mnemo uses pgvector');
  });

  it('push_event returns the accepted event id', async () => {
    const res = await tool('push_event', fakeApi()).handler({
      session_id: 's1',
      turns: [{ role: 'user', content: 'remember this' }],
    });
    expect(parseText(res)).toEqual({ event_id: 'evt-1' });
  });

  it('bootstrap_document returns queued chunk metadata', async () => {
    const res = await tool('bootstrap_document', fakeApi()).handler({
      source: 'README.md',
      content: 'mnemo docs',
    });
    expect(parseText(res)).toEqual({ event_ids: ['evt-1'], chunk_count: 1 });
  });

  it('get_profile returns profile settings', async () => {
    const res = await tool('get_profile', fakeApi()).handler({});
    expect(parseText(res).task_domains).toEqual(['coding', 'general']);
  });

  it('maps thrown errors to MCP isError results', async () => {
    const res = await tool('search_memories', fakeApi({
      search: async () => {
        throw new Error("Not logged in. Run 'mnemo login' first.");
      },
    })).handler({ q: 'anything' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/mnemo login/);
  });
});
