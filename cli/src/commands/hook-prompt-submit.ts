import { loadConfig } from '../config';
import { detectProject } from '../detect-project';
import * as log from '../log';
import { readTranscript, buildTurnsWithActivity, detectTranscriptSource } from '../transcript';
import { executePush } from './push';
import { readStdin } from '../stdin';
import { hashTurn, loadCursor, saveCursor, pruneStaleCursors } from '../cursor';

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export async function executeHookPromptSubmit(input: HookInput): Promise<void> {
  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = input;
  if (!sessionId || !transcriptPath) {
    log.info('prompt-submit: skipped (missing sessionId or transcriptPath)');
    return;
  }

  const entries = readTranscript(transcriptPath);
  const workdir = cwd || process.cwd();
  const turns = buildTurnsWithActivity(entries, workdir);
  if (turns.length === 0) {
    log.info(`prompt-submit: session=${sessionId} no turns found`);
    return;
  }

  const pushedHashes = loadCursor(sessionId);
  const newTurns = turns.filter((t) => !pushedHashes.has(hashTurn(t)));
  if (newTurns.length === 0) {
    log.info(`prompt-submit: session=${sessionId} all ${turns.length} turns already pushed`);
    return;
  }

  const source = detectTranscriptSource(entries);
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

  for (const t of newTurns) pushedHashes.add(hashTurn(t));
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
