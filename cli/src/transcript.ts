import * as fs from 'fs';

export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

// Claude Code transcript entry
interface ClaudeEntry {
  type: string;
  message: {
    content: string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

// Codex transcript entry
interface CodexEntry {
  type: string;
  payload: {
    type: string;
    role?: string;
    message?: string;
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
}


function sanitizeLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\x00-\x09\x0b-\x1f]/g, '');
}

function parseJsonlLines(raw: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of raw.split('\n')) {
    const cleaned = sanitizeLine(line).trim();
    if (!cleaned) continue;
    try {
      entries.push(JSON.parse(cleaned));
    } catch {
      // Skip unparseable lines
    }
  }
  return entries;
}

function isCodexTranscript(entries: unknown[]): boolean {
  return entries.some((e) => {
    const entry = e as Record<string, unknown>;
    return entry.type === 'session_meta' || entry.type === 'response_item' || entry.type === 'event_msg';
  });
}

export function readTranscript(transcriptPath: string, tailLines = 200): unknown[] {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n');
  const tail = lines.slice(-tailLines);
  return parseJsonlLines(tail.join('\n'));
}

export function detectTranscriptSource(entries: unknown[]): 'codex' | 'claude-code' {
  return isCodexTranscript(entries) ? 'codex' : 'claude-code';
}

function extractClaudeTurns(entries: ClaudeEntry[]): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    if (entry.type === 'user') {
      if (typeof entry.message?.content === 'string') {
        const text = entry.message.content.trim();
        if (text) turns.push({ role: 'user', content: text });
      }
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      const textParts = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!);
      const joined = textParts.join('\n').trim();
      if (joined) turns.push({ role: 'assistant', content: joined });
    }
  }

  return turns;
}

function extractCodexTurns(entries: CodexEntry[]): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
      const text = (entry.payload.message || '').trim();
      if (text) turns.push({ role: 'user', content: text });
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'agent_message') {
      const text = (entry.payload.message || '').trim();
      if (text) turns.push({ role: 'assistant', content: text });
    }
  }

  return turns;
}

export function extractTurns(entries: unknown[]): Turn[] {
  if (isCodexTranscript(entries)) return extractCodexTurns(entries as CodexEntry[]);
  return extractClaudeTurns(entries as ClaudeEntry[]);
}

interface ActivityGroups {
  [operation: string]: string[];
}

function extractClaudeActivity(entries: ClaudeEntry[], cwd: string): string {
  const seen = new Set<string>();
  const groups: ActivityGroups = {};
  const cwdPrefix = cwd.replace(/\/$/, '') + '/';

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.name) continue;

      let tag: string | undefined;
      const input = block.input || {};
      const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

      if (block.name === 'Read') {
        tag = 'read:' + stripPrefix(str(input.file_path), cwdPrefix);
      } else if (block.name === 'Edit') {
        tag = 'edit:' + stripPrefix(str(input.file_path), cwdPrefix);
      } else if (block.name === 'Write') {
        tag = 'write:' + stripPrefix(str(input.file_path), cwdPrefix);
      } else if (block.name === 'Bash') {
        tag = 'bash:' + (str(input.description) || (str(input.command) || '').slice(0, 60));
      } else if (block.name === 'Grep') {
        tag = 'grep:' + (str(input.pattern) || '');
      } else if (block.name === 'Glob') {
        tag = 'glob:' + (str(input.pattern) || '');
      }

      if (tag && !seen.has(tag)) {
        seen.add(tag);
        const [op, ...rest] = tag.split(':');
        const value = rest.join(':');
        if (!groups[op]) groups[op] = [];
        groups[op].push(value);
      }
    }
  }

  const parts = Object.keys(groups)
    .sort()
    .map((op) => `${op}=${groups[op].join(', ')}`);

  return parts.join(' | ');
}

function extractCodexActivity(entries: CodexEntry[], cwd: string): string {
  const seen = new Set<string>();
  const groups: ActivityGroups = {};
  const cwdPrefix = cwd.replace(/\/$/, '') + '/';

  for (const entry of entries) {
    if (entry.type !== 'response_item') continue;
    const payload = entry.payload;
    if (payload?.type !== 'function_call') continue;

    const name = typeof payload.name === 'string' ? payload.name : '';
    const rawArgs = payload.arguments;
    const args: Record<string, unknown> = typeof rawArgs === 'string'
      ? (() => { try { return JSON.parse(rawArgs) as Record<string, unknown>; } catch { return {}; } })()
      : (rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {});

    let tag: string | undefined;
    const str = (v: unknown): string => typeof v === 'string' ? v : '';

    if (name === 'shell') {
      const cmd = str(args.command).slice(0, 60);
      tag = cmd ? 'bash:' + cmd : undefined;
    } else if (name === 'apply_patch') {
      const match = str(args.patch).match(/--- a\/(.+)/);
      tag = match ? 'edit:' + stripPrefix(match[1], cwdPrefix) : 'edit:patch';
    } else if (name === 'read_file' || name === 'cat') {
      tag = 'read:' + stripPrefix(str(args.path) || str(args.file), cwdPrefix);
    }

    if (tag && !seen.has(tag)) {
      seen.add(tag);
      const [op, ...rest] = tag.split(':');
      const value = rest.join(':');
      if (!groups[op]) groups[op] = [];
      groups[op].push(value);
    }
  }

  const parts = Object.keys(groups)
    .sort()
    .map((op) => `${op}=${groups[op].join(', ')}`);

  return parts.join(' | ');
}

export function extractActivity(entries: unknown[], cwd: string): string {
  if (isCodexTranscript(entries)) return extractCodexActivity(entries as CodexEntry[], cwd);
  return extractClaudeActivity(entries as ClaudeEntry[], cwd);
}

function stripPrefix(str: string | undefined, prefix: string): string {
  if (!str) return '';
  return str.startsWith(prefix) ? str.slice(prefix.length) : str;
}

export function buildTurnsWithActivity(entries: unknown[], cwd: string): Turn[] {
  const turns = extractTurns(entries);
  if (turns.length === 0) return [];

  const activity = extractActivity(entries, cwd);
  if (activity) {
    turns.unshift({ role: 'tool', content: `[session-activity: ${activity}]` });
  }

  return turns;
}
