import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MnemoConfig {
  apiUrl: string;
  apiKey: string;
  workstation: string;
  defaults: {
    visible: boolean;
  };
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.mnemo', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): MnemoConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run 'mnemo install' to create one.`);
  }

  // Warn (but never fail) if the config file is readable by group or others.
  // The file contains an API key, so 0o600 is the expected permission mask.
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
  if (!raw.apiKey || typeof raw.apiKey !== 'string') {
    throw new Error(`Missing or invalid apiKey in config: ${configPath}. Run 'mnemo install' to create one.`);
  }

  const defaults = raw.defaults as Record<string, unknown> | undefined;

  return {
    apiUrl: raw.apiUrl,
    apiKey: raw.apiKey,
    workstation: (raw.workstation as string) || os.hostname(),
    defaults: {
      visible: typeof defaults?.visible === 'boolean' ? (defaults.visible as boolean) : true,
    },
  };
}
