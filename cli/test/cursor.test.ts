import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCursor, saveCursor, pruneStaleCursors, hashTurn } from '../src/cursor';

describe('cursor', () => {
  const tmpDir = path.join(os.tmpdir(), `mnemo-cursor-test-${Date.now()}`);

  beforeEach(() => {
    process.env.MNEMO_CURSOR_DIR = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.MNEMO_CURSOR_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadCursor', () => {
    it('returns empty set when no file exists', () => {
      const cursor = loadCursor('nonexistent-session');
      expect(cursor).toBeInstanceOf(Set);
      expect(cursor.size).toBe(0);
    });

    it('reads saved cursor from disk', () => {
      const sessionId = 'test-session';
      const hashes = ['abc123', 'def456'];
      const file = path.join(tmpDir, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify({ pushedHashes: hashes }));

      const cursor = loadCursor(sessionId);
      expect(cursor.size).toBe(2);
      expect(cursor.has('abc123')).toBe(true);
      expect(cursor.has('def456')).toBe(true);
    });

    it('returns empty set for corrupt JSON', () => {
      const sessionId = 'corrupt-session';
      const file = path.join(tmpDir, `${sessionId}.json`);
      fs.writeFileSync(file, 'not valid json {{{');

      const cursor = loadCursor(sessionId);
      expect(cursor.size).toBe(0);
    });

    it('returns empty set when pushedHashes is not an array', () => {
      const sessionId = 'bad-shape';
      const file = path.join(tmpDir, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify({ pushedHashes: 'not-an-array' }));

      const cursor = loadCursor(sessionId);
      expect(cursor.size).toBe(0);
    });

    it('returns empty set when JSON lacks pushedHashes key', () => {
      const sessionId = 'missing-key';
      const file = path.join(tmpDir, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify({ other: 'data' }));

      const cursor = loadCursor(sessionId);
      expect(cursor.size).toBe(0);
    });

    it('returns empty set when cursor directory does not exist', () => {
      process.env.MNEMO_CURSOR_DIR = path.join(tmpDir, 'nonexistent', 'deep');
      const cursor = loadCursor('any-session');
      expect(cursor.size).toBe(0);
    });
  });

  describe('saveCursor', () => {
    it('writes cursor hashes to disk', () => {
      const sessionId = 'save-session';
      const hashes = new Set(['hash1', 'hash2', 'hash3']);

      saveCursor(sessionId, hashes);

      const file = path.join(tmpDir, `${sessionId}.json`);
      const content: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(content.pushedHashes).toEqual(['hash1', 'hash2', 'hash3']);
    });

    it('creates cursor directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'cursor', 'dir');
      process.env.MNEMO_CURSOR_DIR = nestedDir;

      saveCursor('session-1', new Set(['h1']));

      expect(fs.existsSync(nestedDir)).toBe(true);
      const file = path.join(nestedDir, 'session-1.json');
      const content: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(content.pushedHashes).toEqual(['h1']);
    });

    it('overwrites existing cursor file', () => {
      const sessionId = 'overwrite-session';
      saveCursor(sessionId, new Set(['old-hash']));
      saveCursor(sessionId, new Set(['new-hash']));

      const cursor = loadCursor(sessionId);
      expect(cursor.size).toBe(1);
      expect(cursor.has('new-hash')).toBe(true);
      expect(cursor.has('old-hash')).toBe(false);
    });
  });

  describe('pruneStaleCursors', () => {
    it('removes cursor files older than the TTL', () => {
      const freshFile = path.join(tmpDir, 'fresh.json');
      const staleFile = path.join(tmpDir, 'stale.json');

      fs.writeFileSync(freshFile, JSON.stringify({ pushedHashes: [] }));
      fs.writeFileSync(staleFile, JSON.stringify({ pushedHashes: [] }));

      // Set the stale file's mtime to 3 days ago
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      fs.utimesSync(staleFile, threeDaysAgo, threeDaysAgo);

      pruneStaleCursors();

      expect(fs.existsSync(freshFile)).toBe(true);
      expect(fs.existsSync(staleFile)).toBe(false);
    });

    it('accepts a custom TTL', () => {
      const file = path.join(tmpDir, 'recent.json');
      fs.writeFileSync(file, JSON.stringify({ pushedHashes: [] }));

      // Set mtime to 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(file, oneHourAgo, oneHourAgo);

      // Prune with 30-minute TTL -- this file should be removed
      pruneStaleCursors(30 * 60 * 1000);

      expect(fs.existsSync(file)).toBe(false);
    });

    it('does nothing when cursor directory does not exist', () => {
      process.env.MNEMO_CURSOR_DIR = path.join(tmpDir, 'nonexistent');
      // Should not throw
      expect(() => pruneStaleCursors()).not.toThrow();
    });

    it('leaves files within TTL untouched', () => {
      const file = path.join(tmpDir, 'keep-me.json');
      fs.writeFileSync(file, JSON.stringify({ pushedHashes: ['h1'] }));

      pruneStaleCursors();

      expect(fs.existsSync(file)).toBe(true);
    });
  });

  describe('session ID sanitization', () => {
    it('replaces path traversal characters with underscores', () => {
      const maliciousId = '../../../etc/passwd';
      saveCursor(maliciousId, new Set(['h1']));

      // The file should be created in the cursor directory with sanitized name
      // '../../../etc/passwd' -> '_________etc_passwd' (9 underscores: . . / . . / . . /)
      const sanitizedName = '_________etc_passwd.json';
      const file = path.join(tmpDir, sanitizedName);
      expect(fs.existsSync(file)).toBe(true);

      // And it should NOT create files outside the cursor directory
      expect(fs.existsSync(path.join(tmpDir, '..', '..', '..', 'etc', 'passwd.json'))).toBe(false);
    });

    it('preserves alphanumeric, dash, and underscore characters', () => {
      const sessionId = 'valid-session_123';
      saveCursor(sessionId, new Set(['h1']));

      const file = path.join(tmpDir, `${sessionId}.json`);
      expect(fs.existsSync(file)).toBe(true);
    });

    it('sanitizes special characters in session IDs', () => {
      const sessionId = 'session with spaces & symbols!';
      saveCursor(sessionId, new Set(['h1']));

      const sanitizedName = 'session_with_spaces___symbols_.json';
      expect(fs.existsSync(path.join(tmpDir, sanitizedName))).toBe(true);
    });

    it('round-trips through save and load with sanitized ID', () => {
      const sessionId = 'tricky/../session';
      const hashes = new Set(['hash-a', 'hash-b']);

      saveCursor(sessionId, hashes);
      const loaded = loadCursor(sessionId);

      expect(loaded).toEqual(hashes);
    });
  });

  describe('hashTurn', () => {
    it('produces a deterministic hex hash', () => {
      const hash1 = hashTurn({ role: 'user', content: 'hello' });
      const hash2 = hashTurn({ role: 'user', content: 'hello' });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different hashes for different content', () => {
      const hash1 = hashTurn({ role: 'user', content: 'hello' });
      const hash2 = hashTurn({ role: 'user', content: 'world' });
      expect(hash1).not.toBe(hash2);
    });

    it('produces different hashes for different roles', () => {
      const hash1 = hashTurn({ role: 'user', content: 'hello' });
      const hash2 = hashTurn({ role: 'assistant', content: 'hello' });
      expect(hash1).not.toBe(hash2);
    });
  });
});
