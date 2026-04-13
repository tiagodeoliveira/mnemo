import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface InstallHooksOptions {
  mnemoConfigPath?: string;
  claudeSettingsPath?: string;
  hooksDir?: string;
}

export interface InstallHooksResult {
  configCreated: boolean;
  hooksInstalled: boolean;
  mnemoConfigPath: string;
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function defaultHooksDir(): string {
  return path.resolve(__dirname, '..', '..', '..', 'hooks');
}

function containsMnemoHook(hookEntries: HookEntry[]): boolean {
  return hookEntries.some((entry) =>
    entry.hooks?.some((h) => h.command.includes('mnemo'))
  );
}

export function installHooks(options: InstallHooksOptions = {}): InstallHooksResult {
  const mnemoConfigPath = options.mnemoConfigPath ?? path.join(os.homedir(), '.mnemo', 'config.json');
  const claudeSettingsPath = options.claudeSettingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
  const hooksDir = options.hooksDir ?? defaultHooksDir();

  let configCreated = false;
  if (!fs.existsSync(mnemoConfigPath)) {
    fs.mkdirSync(path.dirname(mnemoConfigPath), { recursive: true });
    fs.writeFileSync(
      mnemoConfigPath,
      JSON.stringify(
        {
          apiUrl: 'https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/v1',
          apiKey: 'YOUR_API_KEY',
          workstation: os.hostname(),
          defaults: { visible: true },
        },
        null,
        2
      )
    );
    configCreated = true;
  }

  let settings: ClaudeSettings = {};
  if (fs.existsSync(claudeSettingsPath)) {
    settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8')) as ClaudeSettings;
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const sessionStartHooks = settings.hooks.SessionStart || [];
  const promptSubmitHooks = settings.hooks.UserPromptSubmit || [];

  if (containsMnemoHook(sessionStartHooks) && containsMnemoHook(promptSubmitHooks)) {
    return { configCreated, hooksInstalled: false, mnemoConfigPath };
  }

  const sessionStartScript = path.resolve(hooksDir, 'session-start.sh');
  const promptSubmitScript = path.resolve(hooksDir, 'prompt-submit.sh');

  if (!containsMnemoHook(sessionStartHooks)) {
    sessionStartHooks.push({
      matcher: '*',
      hooks: [{ type: 'command', command: `bash ${sessionStartScript}`, timeout: 15 }],
    });
  }

  if (!containsMnemoHook(promptSubmitHooks)) {
    promptSubmitHooks.push({
      matcher: '*',
      hooks: [{ type: 'command', command: `bash ${promptSubmitScript}`, timeout: 10 }],
    });
  }

  settings.hooks.SessionStart = sessionStartHooks;
  settings.hooks.UserPromptSubmit = promptSubmitHooks;

  fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));

  return { configCreated, hooksInstalled: true, mnemoConfigPath };
}
