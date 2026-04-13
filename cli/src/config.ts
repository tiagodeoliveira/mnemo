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

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }

  if (!raw.apiUrl || typeof raw.apiUrl !== 'string') {
    throw new Error(`Missing or invalid apiUrl in config: ${configPath}. Run 'mnemo install' to create one.`);
  }
  if (!raw.apiKey || typeof raw.apiKey !== 'string') {
    throw new Error(`Missing or invalid apiKey in config: ${configPath}. Run 'mnemo install' to create one.`);
  }

  return {
    apiUrl: raw.apiUrl,
    apiKey: raw.apiKey,
    workstation: raw.workstation || os.hostname(),
    defaults: {
      visible: raw.defaults?.visible ?? true,
    },
  };
}
