import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULTS } from './defaults.js';

export interface MnemoConfig {
  apiUrl: string;
  auth0Domain: string;
  auth0Audience: string;
  auth0ClientId: string;
  workstation: string;
  defaults: {
    visible: boolean;
  };
}

// Re-exposed at this layer so the rest of the file's narrative reads
// the same as before. Source of truth is `defaults.ts`, which CI
// regenerates at release time.
const DEFAULT_AUTH0_DOMAIN = DEFAULTS.auth0Domain;
const DEFAULT_AUTH0_AUDIENCE = DEFAULTS.auth0Audience;
const DEFAULT_AUTH0_CLIENT_ID = DEFAULTS.auth0ClientId;

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.mnemo', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): MnemoConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run 'mnemo install' to create one.`);
  }

  // Warn (but never fail) if the config file is readable by group or others.
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(configPath).mode & 0o777;
      if (mode & 0o077) {
        process.stderr.write(
          `[mnemo] warning: ${configPath} is accessible by other users (mode 0o${mode.toString(8)}). ` +
          `Consider running: chmod 600 ${configPath}\n`
        );
      }
    } catch {
      // Permission check is best-effort; never break the CLI.
    }
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }

  if (!raw.apiUrl || typeof raw.apiUrl !== 'string') {
    throw new Error(`Missing or invalid apiUrl in config: ${configPath}. Run 'mnemo install' to create one.`);
  }

  const defaults = raw.defaults as Record<string, unknown> | undefined;

  return {
    apiUrl: raw.apiUrl,
    auth0Domain: typeof raw.auth0Domain === 'string' ? raw.auth0Domain : DEFAULT_AUTH0_DOMAIN,
    auth0Audience: typeof raw.auth0Audience === 'string' ? raw.auth0Audience : DEFAULT_AUTH0_AUDIENCE,
    auth0ClientId: typeof raw.auth0ClientId === 'string' ? raw.auth0ClientId : DEFAULT_AUTH0_CLIENT_ID,
    workstation: (raw.workstation as string) || os.hostname(),
    defaults: {
      visible: typeof defaults?.visible === 'boolean' ? (defaults.visible as boolean) : true,
    },
  };
}
