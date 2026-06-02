import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CURSOR_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export function cursorDir(): string {
  return process.env.MNEMO_CURSOR_DIR || path.join(os.homedir(), '.mnemo', 'cursors');
}

export function hashTurn(turn: { role: string; content: string }, occurrence?: number): string {
  const sequence = occurrence === undefined ? '' : `\0${occurrence}`;
  return crypto.createHash('sha256').update(`${turn.role}\0${turn.content}${sequence}`).digest('hex');
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function loadCursor(sessionId: string): Set<string> {
  const file = path.join(cursorDir(), `${sanitizeSessionId(sessionId)}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(parsed.pushedHashes)) {
      return new Set<string>(parsed.pushedHashes);
    }
  } catch { /* no cursor yet, or malformed — treat as empty */ }
  return new Set<string>();
}

export function saveCursor(sessionId: string, hashes: Set<string>): void {
  const dir = cursorDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeSessionId(sessionId)}.json`);
  fs.writeFileSync(file, JSON.stringify({ pushedHashes: Array.from(hashes) }, null, 2));
}

export function pruneStaleCursors(ttlMs: number = CURSOR_TTL_MS): void {
  const dir = cursorDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > ttlMs) fs.unlinkSync(file);
    } catch { /* race or perms — skip */ }
  }
}
