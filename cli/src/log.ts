import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LOG_PATH = process.env.MNEMO_LOG_PATH || path.join(os.homedir(), '.mnemo', 'mnemo.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = LOG_PATH + '.1';
      fs.renameSync(LOG_PATH, rotated);
    }
  } catch {
    // file doesn't exist yet, nothing to rotate
  }
}

function write(level: string, message: string): void {
  try {
    const dir = path.dirname(LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `${timestamp} [${level}] ${message}\n`);
  } catch {
    // logging should never break the hook
  }
}

export function info(message: string): void {
  write('INFO', message);
}

export function error(message: string): void {
  write('ERROR', message);
}
