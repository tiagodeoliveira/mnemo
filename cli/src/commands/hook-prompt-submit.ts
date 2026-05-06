import { loadConfig } from '../config';
import { detectProject } from '../detect-project';
import * as log from '../log';
import { readTranscript, buildTurnsWithActivity, detectTranscriptSource } from '../transcript';
import { executePush } from './push';
import { readStdin } from '../stdin';
import { hashTurn, loadCursor, saveCursor, pruneStaleCursors } from '../cursor';
import type { Turn } from '../transcript';

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  prompt_response?: string;
  timestamp?: string;
}

interface CursorEntry {
  turn: Turn;
  key: string;
  legacyKey: string;
}

function buildGeminiAfterAgentTurns(input: HookInput): Turn[] {
  const turns: Turn[] = [];
  const prompt = input.prompt?.trim();
  const response = input.prompt_response?.trim();

  if (prompt) turns.push({ role: 'user', content: prompt });
  if (response) turns.push({ role: 'assistant', content: response });

  return turns;
}

function buildTranscriptCursorEntries(turns: Turn[]): { entries: CursorEntry[]; migrateLegacy: boolean } {
  const seenOccurrences = new Map<string, number>();
  const entries = turns.map((turn) => {
    const legacyKey = hashTurn(turn);
    const occurrence = seenOccurrences.get(legacyKey) || 0;
    seenOccurrences.set(legacyKey, occurrence + 1);
    return {
      turn,
      key: hashTurn(turn, occurrence),
      legacyKey,
    };
  });

  return { entries, migrateLegacy: true };
}

function buildEventCursorEntries(turns: Turn[], eventId: string): { entries: CursorEntry[]; migrateLegacy: boolean } {
  return {
    entries: turns.map((turn) => ({
      turn,
      key: hashTurn({ role: turn.role, content: `${eventId}\0${turn.content}` }),
      legacyKey: hashTurn(turn),
    })),
    migrateLegacy: false,
  };
}

export async function executeHookPromptSubmit(input: HookInput): Promise<void> {
  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = input;
  if (!sessionId || !transcriptPath) {
    const geminiTurns = input.hook_event_name === 'AfterAgent' ? buildGeminiAfterAgentTurns(input) : [];
    if (!sessionId || geminiTurns.length === 0) {
      log.info('prompt-submit: skipped (missing sessionId or transcriptPath)');
      return;
    }
  }

  const workdir = cwd || process.cwd();
  const isGeminiAfterAgent = input.hook_event_name === 'AfterAgent' && !!input.prompt;
  const entries = isGeminiAfterAgent ? [] : readTranscript(transcriptPath!);
  const turns = isGeminiAfterAgent ? buildGeminiAfterAgentTurns(input) : buildTurnsWithActivity(entries, workdir);
  if (turns.length === 0) {
    log.info(`prompt-submit: session=${sessionId} no turns found`);
    return;
  }

  const pushedHashes = loadCursor(sessionId);
  const legacyHashCounts = new Map<string, number>();
  for (const t of turns) {
    const legacyHash = hashTurn(t);
    legacyHashCounts.set(legacyHash, (legacyHashCounts.get(legacyHash) || 0) + 1);
  }

  const eventId = `${input.hook_event_name || 'prompt-submit'}:${input.timestamp || hashTurn({ role: 'tool', content: turns.map((t) => `${t.role}\0${t.content}`).join('\0') })}`;
  const { entries: cursorEntries, migrateLegacy } = isGeminiAfterAgent
    ? buildEventCursorEntries(turns, eventId)
    : buildTranscriptCursorEntries(turns);

  let cursorChanged = false;
  const newEntries = cursorEntries.filter(({ key, legacyKey }) => {
    if (pushedHashes.has(key)) return false;

    // Migrate old content-only cursors for unique turns. Repeated identical
    // turns must be replayed with occurrence-aware keys so they are not dropped.
    if (migrateLegacy && legacyHashCounts.get(legacyKey) === 1 && pushedHashes.has(legacyKey)) {
      pushedHashes.add(key);
      cursorChanged = true;
      return false;
    }

    return true;
  });
  const newTurns = newEntries.map(({ turn }) => turn);
  if (newTurns.length === 0) {
    if (cursorChanged) {
      saveCursor(sessionId, pushedHashes);
      pruneStaleCursors();
    }
    log.info(`prompt-submit: session=${sessionId} all ${turns.length} turns already pushed`);
    return;
  }

  const source = isGeminiAfterAgent ? 'gemini-cli' : detectTranscriptSource(entries);
  const project = detectProject(workdir);
  const config = loadConfig();

  log.info(`prompt-submit: session=${sessionId} pushing ${newTurns.length} new turns (source=${source || 'unknown'}, project=${project || 'none'})`);

  await executePush({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    sessionId,
    turns: newTurns,
    project,
    workstation: config.workstation,
    workdir,
    source,
  });

  for (const { key } of newEntries) pushedHashes.add(key);
  saveCursor(sessionId, pushedHashes);
  pruneStaleCursors();

  log.info(`prompt-submit: session=${sessionId} push complete (${newTurns.length} turns)`);
}

export async function hookPromptSubmitFromStdin(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw) return;

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      log.error('prompt-submit: invalid JSON on stdin');
      return;
    }

    await executeHookPromptSubmit(input);
  } catch (err: unknown) {
    log.error(`prompt-submit: ${err instanceof Error ? err.message : String(err)}`);
  }
}
