import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SUPPORTED_CLIENTS = ['claude-code', 'codex', 'gemini-cli', 'openclaw'] as const;
type SupportedClient = typeof SUPPORTED_CLIENTS[number];

const OPENCLAW_HOOK_NAME = 'mnemo';

export interface InstallHooksOptions {
  client: string;
  mnemoConfigPath?: string;
  clientSettingsPath?: string;
  mnemoHooksDir?: string;
  openclawHooksDir?: string;
  channels?: string;
  noRestart?: boolean;
  dryRun?: boolean;
  force?: boolean;
  execFileSyncImpl?: typeof execFileSync;
}

export interface InstallHooksResult {
  configCreated: boolean;
  hooksInstalled: boolean;
  mnemoConfigPath: string;
  changesPlanned?: boolean;
  gatewayRestarted?: boolean;
  gatewayCliMissing?: boolean;
  openclawHookPath?: string;
  installedHooksPath?: string;
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

interface ClientSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function containsMnemoHook(hookEntries: HookEntry[]): boolean {
  return hookEntries.some((entry) =>
    entry.hooks?.some((h) => h.command.includes('mnemo'))
  );
}

// POSIX single-quote escaping so paths with spaces/quotes survive the shell.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function reconcileMnemoHookEntry(
  existing: HookEntry[],
  matcher: string,
  desiredCommand: string,
  timeout: number,
): HookEntry[] {
  const filtered = existing.filter(
    (entry) => !entry.hooks?.some((h) => h.command.includes('mnemo'))
  );
  filtered.push({
    matcher,
    hooks: [{ type: 'command', command: desiredCommand, timeout }],
  });
  return filtered;
}

function resolveAssetDir(client: SupportedClient): string {
  const base = path.resolve(__dirname, '..', '..', 'assets');
  if (client === 'openclaw') return path.join(base, 'openclaw', OPENCLAW_HOOK_NAME);
  if (client === 'gemini-cli') return path.join(base, 'gemini-cli');
  return path.join(base, 'shared');
}

function defaultSettingsPath(client: SupportedClient): string {
  if (client === 'codex') return path.join(os.homedir(), '.codex', 'hooks.json');
  if (client === 'gemini-cli') return path.join(os.homedir(), '.gemini', 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function defaultMnemoHooksDir(): string {
  return path.join(os.homedir(), '.mnemo', 'hooks');
}

function defaultOpenClawHooksDir(): string {
  return path.join(os.homedir(), '.openclaw', 'hooks');
}

function ensureMnemoConfig(mnemoConfigPath: string): boolean {
  if (fs.existsSync(mnemoConfigPath)) return false;
  fs.mkdirSync(path.dirname(mnemoConfigPath), { recursive: true });
  fs.writeFileSync(
    mnemoConfigPath,
    JSON.stringify(
      {
        apiUrl: 'https://mnemo.tiago.tools',
        // auth0 fields omitted — defaults baked in. Override here if you run your own Auth0 tenant.
        workstation: os.hostname(),
        defaults: { visible: true },
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  return true;
}

function listPackagedAssets(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(rootDir, path.join(entry.parentPath ?? rootDir, entry.name)))
    .sort();
}

function copyAssets(sourceDir: string, targetDir: string, preserveMode = true): void {
  const files = listPackagedAssets(sourceDir);
  for (const relativePath of files) {
    const sourceFile = path.join(sourceDir, relativePath);
    const targetFile = path.join(targetDir, relativePath);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(sourceFile, targetFile);
    if (preserveMode) {
      const { mode } = fs.statSync(sourceFile);
      fs.chmodSync(targetFile, mode);
    }
  }
}

function installClientShims(client: SupportedClient, destRoot: string): string {
  const sourceDir = resolveAssetDir(client);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`${client} hook assets not found: ${sourceDir}`);
  }
  const targetDir = path.join(destRoot, client);
  copyAssets(sourceDir, targetDir);
  return targetDir;
}

const SESSION_START_MATCHER: Record<string, string> = {
  'claude-code': '*',
  'codex': 'startup',
  'gemini-cli': 'startup',
};

const PROMPT_EVENT: Record<string, string> = {
  'claude-code': 'UserPromptSubmit',
  'codex': 'UserPromptSubmit',
  'gemini-cli': 'AfterAgent',
};

const HOOK_TIMEOUTS: Record<string, { sessionStart: number; prompt: number }> = {
  'claude-code': { sessionStart: 15, prompt: 10 },
  'codex': { sessionStart: 15, prompt: 10 },
  'gemini-cli': { sessionStart: 15000, prompt: 10000 },
};

function installClientHooks(settingsPath: string, shimDir: string, client: SupportedClient, force = false): boolean {
  const existingContent = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : '';
  const settings: ClientSettings = existingContent ? (JSON.parse(existingContent) as ClientSettings) : {};

  if (!settings.hooks) settings.hooks = {};

  const sessionStartHooks = settings.hooks.SessionStart || [];
  const promptEvent = PROMPT_EVENT[client] || 'UserPromptSubmit';
  const promptSubmitHooks = settings.hooks[promptEvent] || [];

  const sessionCmd = `bash ${shellQuote(path.join(shimDir, 'session-start.sh'))}`;
  const promptCmd = `bash ${shellQuote(path.join(shimDir, 'prompt-submit.sh'))}`;
  const sessionMatcher = SESSION_START_MATCHER[client] || '*';
  const timeouts = HOOK_TIMEOUTS[client] || HOOK_TIMEOUTS['claude-code'];

  if (force) {
    settings.hooks.SessionStart = reconcileMnemoHookEntry(sessionStartHooks, sessionMatcher, sessionCmd, timeouts.sessionStart);
    settings.hooks[promptEvent] = reconcileMnemoHookEntry(promptSubmitHooks, '*', promptCmd, timeouts.prompt);
    const next = JSON.stringify(settings, null, 2);
    if (next === existingContent) return false;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, next);
    return true;
  }

  if (containsMnemoHook(sessionStartHooks) && containsMnemoHook(promptSubmitHooks)) {
    return false;
  }

  if (!containsMnemoHook(sessionStartHooks)) {
    sessionStartHooks.push({
      matcher: sessionMatcher,
      hooks: [{ type: 'command', command: sessionCmd, timeout: timeouts.sessionStart }],
    });
  }

  if (!containsMnemoHook(promptSubmitHooks)) {
    promptSubmitHooks.push({
      matcher: '*',
      hooks: [{ type: 'command', command: promptCmd, timeout: timeouts.prompt }],
    });
  }

  settings.hooks.SessionStart = sessionStartHooks;
  settings.hooks[promptEvent] = promptSubmitHooks;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
}

function normalizeChannelList(channels?: string): string[] {
  if (!channels) return [];

  return Array.from(new Set(
    channels
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )).sort();
}

function buildOpenClawEnvContent(channels?: string): string | undefined {
  const values = normalizeChannelList(channels);
  if (values.length === 0) return undefined;
  return `MNEMO_OPENCLAW_CHANNELS=${values.join(',')}\n`;
}

function restartOpenClawGateway(execImpl: typeof execFileSync): { restarted: boolean; cliMissing: boolean } {
  try {
    execImpl('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
    return { restarted: true, cliMissing: false };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { restarted: false, cliMissing: true };
    }
    throw error;
  }
}

interface OpenClawInstallResult {
  hooksInstalled: boolean;
  changesPlanned: boolean;
  gatewayRestarted: boolean;
  gatewayCliMissing: boolean;
  openclawHookPath: string;
}

function installOpenClawHook(options: InstallHooksOptions): OpenClawInstallResult {
  const sourceDir = resolveAssetDir('openclaw');
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`OpenClaw hook assets not found: ${sourceDir}`);
  }

  const openclawHooksDir = path.resolve(options.openclawHooksDir ?? defaultOpenClawHooksDir());
  const targetDir = path.join(openclawHooksDir, OPENCLAW_HOOK_NAME);
  const envFile = path.join(targetDir, '.env');
  const desiredEnvContent = buildOpenClawEnvContent(options.channels);
  const sourceFiles = listPackagedAssets(sourceDir);

  if (sourceFiles.length === 0) {
    throw new Error(`OpenClaw hook assets are empty: ${sourceDir}`);
  }

  let changed = false;
  for (const relativePath of sourceFiles) {
    const sourceFile = path.join(sourceDir, relativePath);
    const targetFile = path.join(targetDir, relativePath);
    const sourceContent = fs.readFileSync(sourceFile, 'utf-8');

    if (!fs.existsSync(targetFile)) {
      changed = true;
      continue;
    }

    const targetContent = fs.readFileSync(targetFile, 'utf-8');
    if (targetContent === sourceContent) continue;

    if (!options.force && !options.dryRun) {
      throw new Error(
        `OpenClaw hook file differs from packaged asset: ${targetFile}. Re-run with --force to overwrite it.`
      );
    }

    changed = true;
  }

  const existingEnvContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : undefined;
  if (desiredEnvContent !== existingEnvContent) {
    changed = true;
  }

  if (options.dryRun) {
    return {
      hooksInstalled: false,
      changesPlanned: changed,
      gatewayRestarted: false,
      gatewayCliMissing: false,
      openclawHookPath: targetDir,
    };
  }

  if (changed) {
    fs.mkdirSync(targetDir, { recursive: true });
    copyAssets(sourceDir, targetDir, false);

    if (desiredEnvContent) {
      fs.writeFileSync(envFile, desiredEnvContent);
    } else if (fs.existsSync(envFile)) {
      fs.rmSync(envFile);
    }
  }

  let gatewayRestarted = false;
  let gatewayCliMissing = false;
  if (changed && !options.noRestart) {
    const exec = options.execFileSyncImpl ?? execFileSync;
    const outcome = restartOpenClawGateway(exec);
    gatewayRestarted = outcome.restarted;
    gatewayCliMissing = outcome.cliMissing;
  }

  return {
    hooksInstalled: changed,
    changesPlanned: changed,
    gatewayRestarted,
    gatewayCliMissing,
    openclawHookPath: targetDir,
  };
}

export function installHooks(options: InstallHooksOptions): InstallHooksResult {
  const client = options.client as SupportedClient;
  if (!SUPPORTED_CLIENTS.includes(client)) {
    throw new Error(
      `Unsupported client "${options.client}". Supported clients: ${SUPPORTED_CLIENTS.join(', ')}`
    );
  }

  const mnemoConfigPath = options.mnemoConfigPath ?? path.join(os.homedir(), '.mnemo', 'config.json');

  if (client === 'openclaw') {
    const result = installOpenClawHook(options);
    const configCreated = options.dryRun ? false : ensureMnemoConfig(mnemoConfigPath);
    return { configCreated, mnemoConfigPath, ...result };
  }

  const settingsPath = options.clientSettingsPath ?? defaultSettingsPath(client);
  const mnemoHooksDir = path.resolve(options.mnemoHooksDir ?? defaultMnemoHooksDir());
  const shimDir = installClientShims(client, mnemoHooksDir);

  const hooksInstalled = installClientHooks(settingsPath, shimDir, client, options.force);

  const configCreated = ensureMnemoConfig(mnemoConfigPath);
  return { configCreated, hooksInstalled, mnemoConfigPath, installedHooksPath: shimDir };
}
