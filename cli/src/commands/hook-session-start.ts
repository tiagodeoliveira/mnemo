import { loadConfig } from '../config';
import { detectProject } from '../detect-project';
import * as log from '../log';
import { executeRecall, formatRecallOutput } from './recall';
import { readStdin } from '../stdin';
import { localDate } from '../date';

interface HookInput {
  cwd?: string;
}

export async function executeHookSessionStart(input: HookInput): Promise<string | undefined> {
  const cwd = input.cwd;
  if (!cwd) {
    log.info('session-start: skipped (no cwd)');
    return undefined;
  }

  const project = detectProject(cwd);
  const config = loadConfig();
  const today = localDate();

  log.info(`session-start: recalling memories (project=${project || 'none'}, date=${today})`);

  const response = await executeRecall({
    apiUrl: config.apiUrl,
    auth0Domain: config.auth0Domain,
    auth0ClientId: config.auth0ClientId,
    workstation: config.workstation,
    preferences: true,
    about: true,
    project,
    task: 'coding',
    date: today,
  });

  const output = formatRecallOutput(response, { visible: false });
  log.info(`session-start: recall complete (${output ? output.length : 0} chars)`);
  return output || undefined;
}

export async function hookSessionStartFromStdin(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw) return;

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      log.error('session-start: invalid JSON on stdin');
      return;
    }

    const output = await executeHookSessionStart(input);
    if (output) process.stdout.write(output + '\n');
  } catch (err: unknown) {
    log.error(`session-start: ${err instanceof Error ? err.message : String(err)}`);
  }
}
