import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/config', () => ({
  loadConfig: () => ({
    apiUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    workstation: 'test-ws',
    defaults: { visible: true },
  }),
}));

vi.mock('../src/detect-project', () => ({
  detectProject: () => 'test-project',
}));

import { executeHookSessionStart } from '../src/commands/hook-session-start';

describe('hook-session-start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls recall and returns hook JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          preferences: [{ id: '1', content: 'likes TypeScript', score: 0.9, createdAt: '2024-01-01' }],
          facts: [],
          episodes: [],
          project: { name: 'test-project', memories: [{ id: '2', content: 'uses CDK', score: 0.8, createdAt: '2024-01-01' }] },
        }),
    });

    const output = await executeHookSessionStart({ cwd: '/home/user/project' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/recall');
    expect(url).toContain('preferences=true');
    expect(url).toContain('facts=true');
    expect(url).not.toContain('episodes');
    expect(url).toContain('project=test-project');
    expect(url).toContain('task=coding');

    expect(output).toBeDefined();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('likes TypeScript');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('uses CDK');
  });

  it('returns undefined when cwd is missing', async () => {
    const output = await executeHookSessionStart({});
    expect(output).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns undefined when recall returns empty response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const output = await executeHookSessionStart({ cwd: '/home/user/project' });
    expect(output).toBeUndefined();
  });
});
