import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Claude Code writes one file per running session under this directory,
// keyed by PID, e.g. { sessionId, name, nameSource }. This is undocumented,
// internal state — not part of the hooks API — so it can change or vanish
// on any Claude Code release. Every read here is best-effort.
export function claudeSessionsDir(): string {
  return process.env.MNEMO_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
}

interface ClaudeSessionFile {
  sessionId?: string;
  name?: string;
  nameSource?: string;
}

// Returns the user-assigned name for a Claude Code session (set via
// `/rename` or `claude -n <name>`), or undefined if there isn't one.
// Auto-generated default names (nameSource === 'derived', e.g. "myrepo-3f")
// are deliberately excluded — those aren't a tag the user chose.
export function lookupClaudeSessionName(sessionId: string): string | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(claudeSessionsDir());
  } catch {
    return undefined;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir(), file), 'utf-8')) as ClaudeSessionFile;
      if (data.sessionId === sessionId && typeof data.name === 'string' && data.nameSource !== 'derived') {
        return data.name;
      }
    } catch {
      continue; // malformed or mid-write — skip, never fail the push over it
    }
  }
  return undefined;
}
