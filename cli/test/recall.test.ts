import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('mock-jwt'),
}));

import { executeRecall, formatRecallForHook } from '../src/commands/recall';
import { getAccessToken } from '../src/auth';

const baseOpts = {
  apiUrl: 'https://api.example.com/v1',
  auth0Domain: 'tenant.us.auth0.com',
  auth0ClientId: 'client-123',
  workstation: 'laptop',
};

const sampleResponse = {
  dimensions: [
    {
      dimension: 'preferences',
      namespace: '/preferences/dev-actor/',
      items: [
        {
          id: 'p1',
          content: 'Prefers TypeScript and functional style',
          tags: ['language'],
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
          reinforced_count: 2,
        },
      ],
    },
    {
      dimension: 'project',
      namespace: '/projects/dev-actor/mnemo/',
      items: [
        {
          id: 'pr1',
          content: 'Chose Postgres + pgvector over a vector DB',
          tags: ['architecture'],
          created_at: '2026-05-05T00:00:00Z',
          updated_at: '2026-05-05T00:00:00Z',
          reinforced_count: 1,
        },
      ],
    },
  ],
};

describe('executeRecall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessToken).mockResolvedValue('mock-jwt');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
  });

  it('builds /recall URL with the requested dimension flags and Auth0 Bearer header', async () => {
    await executeRecall({
      ...baseOpts,
      preferences: true,
      about: true,
      project: 'mnemo',
      task: 'coding',
      date: '2026-05-14',
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/recall?');
    expect(url).toContain('preferences=true');
    expect(url).toContain('about=true');
    expect(url).toContain('project=mnemo');
    expect(url).toContain('task=coding');
    expect(url).toContain('date=2026-05-14');
    // facts was dropped in v2 and should never appear.
    expect(url).not.toContain('facts');
    expect(options.headers['Authorization']).toBe('Bearer mock-jwt');
  });

  it('passes q + tag filters + similarity threshold through as snake_case query params', async () => {
    await executeRecall({
      ...baseOpts,
      preferences: true,
      q: 'durable preferences',
      tags: 'language,tool',
      tagMode: 'all',
      minSimilarity: 0.7,
      limit: 5,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('q=durable+preferences');
    expect(url).toContain('tags=language%2Ctool');
    expect(url).toContain('tag_mode=all');
    expect(url).toContain('min_similarity=0.7');
    expect(url).toContain('limit=5');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(
      executeRecall({ ...baseOpts, preferences: true })
    ).rejects.toThrow('401');
  });

  it("throws 'Not logged in' when getAccessToken returns null", async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce(null);

    await expect(
      executeRecall({ ...baseOpts, preferences: true })
    ).rejects.toThrow(/Not logged in/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the server response verbatim', async () => {
    const got = await executeRecall({ ...baseOpts, preferences: true });
    expect(got).toEqual(sampleResponse);
  });
});

describe('formatRecallForHook', () => {
  it('renders each non-empty dimension as a markdown section with bullet list', () => {
    const md = formatRecallForHook(sampleResponse);
    expect(md).toContain('## preferences');
    expect(md).toContain('- Prefers TypeScript and functional style');
    expect(md).toContain('## project');
    expect(md).toContain('- Chose Postgres + pgvector over a vector DB');
  });

  it('skips empty dimensions', () => {
    const md = formatRecallForHook({
      dimensions: [
        { dimension: 'preferences', namespace: '/preferences/x/', items: [] },
        {
          dimension: 'about',
          namespace: '/about/x/',
          items: [
            {
              id: 'a1',
              content: 'Tiago — backend engineer',
              tags: [],
              created_at: '',
              updated_at: '',
              reinforced_count: 1,
            },
          ],
        },
      ],
    });
    expect(md).not.toContain('## preferences');
    expect(md).toContain('## about');
    expect(md).toContain('- Tiago — backend engineer');
  });

  it('returns an empty string when nothing was recalled', () => {
    expect(formatRecallForHook({ dimensions: [] })).toBe('');
  });
});
