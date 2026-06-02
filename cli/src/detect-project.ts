import { execFileSync } from 'child_process';
import * as path from 'path';

export function detectProject(cwd: string = process.cwd()): string | undefined {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return path.basename(gitRoot);
  } catch {
    return undefined;
  }
}
