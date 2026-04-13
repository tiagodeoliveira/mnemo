import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { executePush } from '../src/commands/push';

describe('push command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  it('sends turns to /events endpoint', async () => {
    await executePush({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      sessionId: 'session-1',
      turns: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      project: 'mnemo',
      workstation: 'laptop',
      workdir: '/home/user/mnemo',
    });

    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/events');
    expect(options.method).toBe('POST');
    expect(options.headers['x-api-key']).toBe('test-key');

    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe('session-1');
    expect(body.turns).toHaveLength(2);
    expect(body.context.project).toBe('mnemo');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(
      executePush({
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        sessionId: 's1',
        turns: [{ role: 'user', content: 'test' }],
        workstation: 'laptop',
        workdir: '/tmp',
      })
    ).rejects.toThrow('500');
  });

  it('includes source in context when provided', async () => {
    await executePush({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      sessionId: 'session-1',
      turns: [{ role: 'user', content: 'hello' }],
      project: 'mnemo',
      workstation: 'laptop',
      workdir: '/home/user/mnemo',
      source: 'claude-code',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context.source).toBe('claude-code');
  });

  it('omits source from context when not provided', async () => {
    await executePush({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      sessionId: 'session-1',
      turns: [{ role: 'user', content: 'hello' }],
      workstation: 'laptop',
      workdir: '/home/user',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context.source).toBeUndefined();
  });
});
