import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('mock-jwt'),
}));

import { executePush } from '../src/commands/push';
import { getAccessToken } from '../src/auth';

const baseOpts = {
  apiUrl: 'https://api.example.com/v1',
  auth0Domain: 'tenant.us.auth0.com',
  auth0ClientId: 'client-123',
  workstation: 'laptop',
  workdir: '/home/user/mnemo',
};

describe('push command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessToken).mockResolvedValue('mock-jwt');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ event_id: 'evt-1' }),
    });
  });

  it('POSTs to /events with the flat snake_case body the server expects', async () => {
    await executePush({
      ...baseOpts,
      sessionId: 'session-1',
      turns: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      project: 'mnemo',
      source: 'claude-code',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/events');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer mock-jwt');
    expect(options.headers['content-type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.session_id).toBe('session-1');
    expect(body.turns).toHaveLength(2);
    expect(body.project).toBe('mnemo');
    expect(body.source).toBe('claude-code');
    expect(body.workstation).toBe('laptop');
    expect(body.workdir).toBe('/home/user/mnemo');
    // No `context` wrapper — the server expects a flat body.
    expect(body.context).toBeUndefined();
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(
      executePush({
        ...baseOpts,
        sessionId: 's1',
        turns: [{ role: 'user', content: 'test' }],
      })
    ).rejects.toThrow('500');
  });

  it('defaults source to unknown when not provided', async () => {
    await executePush({
      ...baseOpts,
      sessionId: 'session-1',
      turns: [{ role: 'user', content: 'hello' }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.source).toBe('unknown');
  });

  it("throws 'Not logged in' when getAccessToken returns null", async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce(null);

    await expect(
      executePush({
        ...baseOpts,
        sessionId: 's1',
        turns: [{ role: 'user', content: 'test' }],
      })
    ).rejects.toThrow(/Not logged in/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes attributes through to the body when present', async () => {
    await executePush({
      ...baseOpts,
      sessionId: 'session-1',
      turns: [{ role: 'user', content: 'hello' }],
      attributes: { meeting_id: 'm-42', meeting_ended: 'true' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.attributes).toEqual({ meeting_id: 'm-42', meeting_ended: 'true' });
  });
});
