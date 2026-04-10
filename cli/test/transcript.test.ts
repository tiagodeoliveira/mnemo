import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscript, extractTurns, extractActivity, buildTurnsWithActivity, detectTranscriptSource } from '../src/transcript';

interface TranscriptEntry { type: string; message: Record<string, unknown>; payload?: Record<string, unknown> }

describe('transcript', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-transcript-test-' + Date.now());
  let transcriptPath: string;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLines(lines: object[]) {
    fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  describe('readTranscript', () => {
    it('parses valid JSONL', () => {
      writeLines([
        { type: 'user', message: { content: 'hello' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      ]);

      const entries = readTranscript(transcriptPath) as TranscriptEntry[];
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('user');
      expect(entries[1].type).toBe('assistant');
    });

    it('strips control characters that break JSON', () => {
      const line = JSON.stringify({ type: 'user', message: { content: 'hello' } });
      const corrupted = line.slice(0, 5) + '\x00\x01\x09' + line.slice(5);
      fs.writeFileSync(transcriptPath, corrupted);

      const entries = readTranscript(transcriptPath) as TranscriptEntry[];
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('user');
    });

    it('skips unparseable lines gracefully', () => {
      fs.writeFileSync(
        transcriptPath,
        '{"type":"user","message":{"content":"ok"}}\nnot valid json\n{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
      );

      const entries = readTranscript(transcriptPath);
      expect(entries).toHaveLength(2);
    });

    it('tails to requested line count', () => {
      const lines = Array.from({ length: 50 }, (_, i) => ({
        type: 'user',
        message: { content: `msg-${i}` },
      }));
      writeLines(lines);

      const entries = readTranscript(transcriptPath, 10) as TranscriptEntry[];
      expect(entries.length).toBeLessThanOrEqual(10);
      expect(entries[entries.length - 1].message.content).toBe('msg-49');
    });
  });

  describe('extractTurns', () => {
    it('extracts user string messages and assistant text blocks', () => {
      const entries = [
        { type: 'user', message: { content: 'what is this?' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'it is a test' }] } },
      ] as unknown[];

      const turns = extractTurns(entries);
      expect(turns).toEqual([
        { role: 'user', content: 'what is this?' },
        { role: 'assistant', content: 'it is a test' },
      ]);
    });

    it('skips user tool_result arrays', () => {
      const entries = [
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'data' }] } },
        { type: 'user', message: { content: 'real question' } },
      ] as unknown[];

      const turns = extractTurns(entries);
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('real question');
    });

    it('skips assistant messages with only tool_use blocks', () => {
      const entries = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'result' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
      ] as unknown[];

      const turns = extractTurns(entries);
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('result');
    });

    it('joins multiple text blocks with newline', () => {
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'first part' },
              { type: 'tool_use', name: 'Bash', input: {} },
              { type: 'text', text: 'second part' },
            ],
          },
        },
      ] as unknown[];

      const turns = extractTurns(entries);
      expect(turns[0].content).toBe('first part\nsecond part');
    });

    it('skips empty content', () => {
      const entries = [
        { type: 'user', message: { content: '   ' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
      ] as unknown[];

      const turns = extractTurns(entries);
      expect(turns).toHaveLength(0);
    });
  });

  describe('extractActivity', () => {
    it('groups tool operations by type', () => {
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/src/main.ts' } },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/home/user/project/src/main.ts' } },
              { type: 'tool_use', name: 'Bash', input: { description: 'run tests', command: 'npm test' } },
            ],
          },
        },
      ] as unknown[];

      const activity = extractActivity(entries, '/home/user/project');
      expect(activity).toContain('bash=run tests');
      expect(activity).toContain('edit=src/main.ts');
      expect(activity).toContain('read=src/main.ts');
    });

    it('strips cwd prefix from file paths', () => {
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/proj/lib/util.ts' } },
            ],
          },
        },
      ] as unknown[];

      const activity = extractActivity(entries, '/workspace/proj');
      expect(activity).toBe('read=lib/util.ts');
    });

    it('deduplicates entries', () => {
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/proj/a.ts' } },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/proj/a.ts' } },
            ],
          },
        },
      ] as unknown[];

      const activity = extractActivity(entries, '/proj');
      expect(activity).toBe('read=a.ts');
    });

    it('returns empty string when no tool_use blocks', () => {
      const entries = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      ] as unknown[];

      expect(extractActivity(entries, '/proj')).toBe('');
    });

    it('uses Bash description over command', () => {
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { description: 'Install deps', command: 'npm install --legacy-peer-deps' } },
            ],
          },
        },
      ] as unknown[];

      const activity = extractActivity(entries, '/proj');
      expect(activity).toBe('bash=Install deps');
    });

    it('truncates Bash command to 60 chars when no description', () => {
      const longCmd = 'a'.repeat(100);
      const entries = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: longCmd } },
            ],
          },
        },
      ] as unknown[];

      const activity = extractActivity(entries, '/proj');
      expect(activity).toBe('bash=' + 'a'.repeat(60));
    });
  });

  describe('buildTurnsWithActivity', () => {
    it('prepends activity summary as tool turn', () => {
      const entries = [
        { type: 'user', message: { content: 'fix the bug' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/proj/src/bug.ts' } },
              { type: 'text', text: 'Fixed it' },
            ],
          },
        },
      ] as unknown[];

      const turns = buildTurnsWithActivity(entries, '/proj');
      expect(turns).toHaveLength(3);
      expect(turns[0].role).toBe('tool');
      expect(turns[0].content).toContain('[session-activity:');
      expect(turns[0].content).toContain('read=src/bug.ts');
    });

    it('returns empty array when no turns', () => {
      expect(buildTurnsWithActivity([], '/proj')).toEqual([]);
    });

    it('skips activity turn when no tool_use blocks', () => {
      const entries = [
        { type: 'user', message: { content: 'hello' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      ] as unknown[];

      const turns = buildTurnsWithActivity(entries, '/proj');
      expect(turns).toHaveLength(2);
      expect(turns[0].role).toBe('user');
    });
  });

  describe('codex transcript format', () => {
    it('detects codex transcripts', () => {
      const entries = [
        { type: 'session_meta', payload: { id: 'test' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      ];
      expect(detectTranscriptSource(entries)).toBe('codex');
    });

    it('detects claude-code transcripts', () => {
      const entries = [
        { type: 'user', message: { content: 'hello' } },
      ];
      expect(detectTranscriptSource(entries)).toBe('claude-code');
    });

    it('extracts user and assistant turns from codex format', () => {
      const entries = [
        { type: 'session_meta', payload: { id: 'test' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } },
        { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'I fixed the bug in main.ts' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'thanks' } },
      ];

      const turns = extractTurns(entries);
      expect(turns).toHaveLength(3);
      expect(turns[0]).toEqual({ role: 'user', content: 'fix the bug' });
      expect(turns[1]).toEqual({ role: 'assistant', content: 'I fixed the bug in main.ts' });
      expect(turns[2]).toEqual({ role: 'user', content: 'thanks' });
    });

    it('skips empty codex messages', () => {
      const entries = [
        { type: 'session_meta', payload: { id: 'test' } },
        { type: 'event_msg', payload: { type: 'user_message', message: '' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: '  ' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'real message' } },
      ];

      const turns = extractTurns(entries);
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('real message');
    });

    it('extracts activity from codex shell calls', () => {
      const entries = [
        { type: 'session_meta', payload: { id: 'test' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"npm test"}' } },
      ];

      const activity = extractActivity(entries, '/proj');
      expect(activity).toBe('bash=npm test');
    });

    it('reads and parses codex transcript file', () => {
      const lines = [
        { type: 'session_meta', payload: { id: 'test' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello from codex' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'hi there' } },
      ];
      writeLines(lines);

      const entries = readTranscript(transcriptPath);
      const turns = extractTurns(entries);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toEqual({ role: 'user', content: 'hello from codex' });
      expect(turns[1]).toEqual({ role: 'assistant', content: 'hi there' });
    });

    it('builds turns with activity from codex transcript', () => {
      const entries = [
        { type: 'session_meta', payload: { id: 'test' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'run the tests' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"npm test"}' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Tests passed' } },
      ];

      const turns = buildTurnsWithActivity(entries, '/proj');
      expect(turns).toHaveLength(3);
      expect(turns[0].role).toBe('tool');
      expect(turns[0].content).toContain('bash=npm test');
      expect(turns[1].role).toBe('user');
      expect(turns[2].role).toBe('assistant');
    });
  });
});
