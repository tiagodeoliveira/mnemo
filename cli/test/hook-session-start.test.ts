import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/config', () => ({
  loadConfig: () => ({
    apiUrl: 'https://api.test.com/v1',
    auth0Domain: 'tenant.us.auth0.com',
    auth0Audience: 'https://api.test.com',
    auth0ClientId: 'client-123',
    workstation: 'test-ws',
    defaults: { visible: true },
  }),
}));

vi.mock('../src/auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('mock-jwt'),
}));

vi.mock('../src/detect-project', () => ({
  detectProject: () => 'test-project',
}));

import { executeHookSessionStart } from '../src/commands/hook-session-start';

describe('hook-session-start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls recall and returns hook JSON with the recalled context', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          dimensions: [
            {
              dimension: 'preferences',
              namespace: '/preferences/dev-actor/',
              items: [
                { id: '1', content: 'likes TypeScript', tags: [], created_at: '', updated_at: '', reinforced_count: 1 },
              ],
            },
            {
              dimension: 'project',
              namespace: '/projects/dev-actor/test-project/',
              items: [
                { id: '2', content: 'uses Postgres', tags: [], created_at: '', updated_at: '', reinforced_count: 1 },
              ],
            },
          ],
        }),
    });

    const output = await executeHookSessionStart({ cwd: '/home/user/project' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/recall');
    expect(url).toContain('preferences=true');
    expect(url).toContain('about=true');
    expect(url).toContain('project=test-project');
    expect(url).toContain('task=coding');
    // facts was dropped in v2 — make sure the hook never asks for it.
    expect(url).not.toContain('facts');

    expect(output).toBeDefined();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('likes TypeScript');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('uses Postgres');
  });

  it('returns undefined when cwd is missing', async () => {
    const output = await executeHookSessionStart({});
    expect(output).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns undefined when recall returns no items', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ dimensions: [] }),
    });

    const output = await executeHookSessionStart({ cwd: '/home/user/project' });
    expect(output).toBeUndefined();
  });
});
