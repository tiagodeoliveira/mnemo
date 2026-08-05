import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lookupClaudeSessionName } from '../src/claude-session-name';

describe('lookupClaudeSessionName', () => {
  const tmpDir = path.join(os.tmpdir(), `mnemo-claude-sessions-test-${Date.now()}`);

  beforeEach(() => {
    process.env.MNEMO_CLAUDE_SESSIONS_DIR = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.MNEMO_CLAUDE_SESSIONS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when the sessions directory does not exist', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(lookupClaudeSessionName('some-session')).toBeUndefined();
  });

  it('returns undefined when no file matches the session id', () => {
    fs.writeFileSync(path.join(tmpDir, '111.json'), JSON.stringify({ sessionId: 'other', name: 'foo' }));
    expect(lookupClaudeSessionName('some-session')).toBeUndefined();
  });

  it('returns the name for a user-renamed session', () => {
    fs.writeFileSync(
      path.join(tmpDir, '111.json'),
      JSON.stringify({ sessionId: 'some-session', name: "tiago's assistant" }),
    );
    expect(lookupClaudeSessionName('some-session')).toBe("tiago's assistant");
  });

  it('excludes auto-derived default names', () => {
    fs.writeFileSync(
      path.join(tmpDir, '111.json'),
      JSON.stringify({ sessionId: 'some-session', name: 'mnemo-6a', nameSource: 'derived' }),
    );
    expect(lookupClaudeSessionName('some-session')).toBeUndefined();
  });

  it('ignores malformed session files instead of throwing', () => {
    fs.writeFileSync(path.join(tmpDir, '111.json'), '{not json');
    fs.writeFileSync(
      path.join(tmpDir, '222.json'),
      JSON.stringify({ sessionId: 'some-session', name: 'real-name' }),
    );
    expect(lookupClaudeSessionName('some-session')).toBe('real-name');
  });

  it('ignores non-.json files in the directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a session file');
    expect(lookupClaudeSessionName('some-session')).toBeUndefined();
  });
});
