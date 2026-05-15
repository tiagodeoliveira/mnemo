import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

const DEFAULT_AUTH0_DOMAIN   = 'dev-jrva0wzk3qkdxcar.us.auth0.com';
const DEFAULT_AUTH0_AUDIENCE = 'https://mnemo.tiago.tools';
const DEFAULT_AUTH0_CLIENT_ID = 'naKbYOFItrLOwttTMZQ8pQSBJYwyJuzS';

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

  // Warn if someone still has apiKey in their config but no auth0 fields yet.
  if (raw.apiKey && !raw.auth0Domain && !raw.auth0Audience && !raw.auth0ClientId) {
    process.stderr.write(`[mnemo] apiKey is no longer used; run 'mnemo login'\n`);
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
