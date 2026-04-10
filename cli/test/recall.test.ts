import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { executeRecall, formatRecallOutput } from '../src/commands/recall';

const sampleResponse = {
  preferences: [
    { id: 'r1', content: 'Prefers TypeScript and functional style', score: 0.95, createdAt: '' },
  ],
  facts: [
    { id: 'r2', content: 'Senior engineer working on distributed systems', score: 0.9, createdAt: '' },
  ],
  episodes: [],
  reflections: [],
  project: {
    name: 'mnemo',
    memories: [
      { id: 'r3', content: 'Chose CDK over SAM for infrastructure', score: 0.85, createdAt: '' },
    ],
  },
};

describe('recall command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
  });

  it('calls /recall with project param', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      project: 'mnemo',
      workstation: 'laptop',
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/recall?project=mnemo&workstation=laptop');
    expect(options.headers['x-api-key']).toBe('test-key');
  });

  it('omits project param when not provided', async () => {
    await executeRecall({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      workstation: 'laptop',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/recall?workstation=laptop');
  });
});

describe('formatRecallOutput', () => {
  it('formats response for visible mode', () => {
    const output = formatRecallOutput(sampleResponse, true);
    expect(output).toContain('Prefers TypeScript');
    expect(output).toContain('Senior engineer');
    expect(output).toContain('mnemo');
    expect(output).toContain('Chose CDK over SAM');
  });

  it('formats response for silent mode as JSON system message', () => {
    const output = formatRecallOutput(sampleResponse, false);
    const parsed = JSON.parse(output);
    expect(parsed.systemMessage).toBeDefined();
  });
});
