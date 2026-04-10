import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

import { executeHookPromptSubmit } from '../src/commands/hook-prompt-submit';
import { pruneStaleCursors } from '../src/cursor';

describe('hook-prompt-submit', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-hook-test-' + Date.now());
  const cursorDir = path.join(tmpDir, 'cursors');
  let transcriptPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.MNEMO_CURSOR_DIR = cursorDir;
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MNEMO_CURSOR_DIR;
  });

  function writeTranscript(lines: object[]) {
    fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('parses transcript and pushes turns', async () => {
    writeTranscript([
      { type: 'user', message: { content: 'hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } },
    ]);

    await executeHookPromptSubmit({
      session_id: 'test-session-1',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sessionId).toBe('test-session-1');
    expect(body.turns).toContainEqual({ role: 'user', content: 'hello' });
    expect(body.turns).toContainEqual({ role: 'assistant', content: 'hi there' });
    expect(body.context.source).toBe('claude-code');
    expect(body.context.project).toBe('test-project');
  });

  it('skips push when session_id missing', async () => {
    writeTranscript([{ type: 'user', message: { content: 'test' } }]);

    await executeHookPromptSubmit({
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips push when transcript_path missing', async () => {
    await executeHookPromptSubmit({
      session_id: 'test-session-2',
      cwd: tmpDir,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips push when no turns extracted', async () => {
    writeTranscript([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'data' }] } },
    ]);

    await executeHookPromptSubmit({
      session_id: 'test-session-3',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not re-push turns already recorded in the cursor', async () => {
    writeTranscript([
      { type: 'user', message: { content: 'hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } },
    ]);

    await executeHookPromptSubmit({
      session_id: 'dedup-session',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });
    expect(mockFetch).toHaveBeenCalledOnce();

    await executeHookPromptSubmit({
      session_id: 'dedup-session',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });
    // Same transcript, same session — no new turns, no second push.
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('pushes only turns added since the last hook invocation', async () => {
    writeTranscript([
      { type: 'user', message: { content: 'prompt 1' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply 1' }] } },
    ]);

    await executeHookPromptSubmit({
      session_id: 'incremental-session',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });
    expect(mockFetch).toHaveBeenCalledOnce();

    writeTranscript([
      { type: 'user', message: { content: 'prompt 1' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply 1' }] } },
      { type: 'user', message: { content: 'prompt 2' } },
    ]);

    await executeHookPromptSubmit({
      session_id: 'incremental-session',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const userTurns = secondBody.turns.filter((t: { role: string }) => t.role === 'user');
    expect(userTurns).toEqual([{ role: 'user', content: 'prompt 2' }]);
  });

  it('does not update the cursor if push fails, so the next run retries', async () => {
    writeTranscript([{ type: 'user', message: { content: 'flaky' } }]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });

    await expect(executeHookPromptSubmit({
      session_id: 'retry-session',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })).rejects.toThrow();

    mockFetch.mockResolvedValue({ ok: true });
    await executeHookPromptSubmit({
      session_id: 'retry-session',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.turns).toContainEqual({ role: 'user', content: 'flaky' });
  });

  it('prunes cursor files older than the TTL', async () => {
    fs.mkdirSync(cursorDir, { recursive: true });
    const stale = path.join(cursorDir, 'old-session.json');
    fs.writeFileSync(stale, JSON.stringify({ pushedHashes: ['deadbeef'] }));
    // Backdate the file well past the default 2-day TTL.
    const threeDaysAgo = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, threeDaysAgo, threeDaysAgo);

    pruneStaleCursors();

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('includes activity summary in turns', async () => {
    writeTranscript([
      { type: 'user', message: { content: 'fix it' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: path.join(tmpDir, 'src', 'main.ts') } },
            { type: 'text', text: 'done' },
          ],
        },
      },
    ]);

    await executeHookPromptSubmit({
      session_id: 'test-session-activity',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const activityTurn = body.turns.find((t: { role: string }) => t.role === 'tool');
    expect(activityTurn).toBeDefined();
    expect(activityTurn.content).toContain('read=src/main.ts');
  });

  it('handles transcripts with control characters', async () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hello world' } });
    const corrupted = line.slice(0, 10) + '\x00\x01\x08\x09\x0b\x1f' + line.slice(10);
    fs.writeFileSync(transcriptPath, corrupted);

    await executeHookPromptSubmit({
      session_id: 'test-session-control',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.turns).toContainEqual({ role: 'user', content: 'hello world' });
  });
});
