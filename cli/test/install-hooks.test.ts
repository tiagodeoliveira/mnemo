import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installHooks } from '../src/commands/install-hooks';

const bashCmd = (p: string): string => `bash '${p.replace(/'/g, `'\\''`)}'`;

describe('install-hooks claude-code', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-hooks-test-' + Date.now());
  const mnemoConfigPath = path.join(tmpDir, '.mnemo', 'config.json');
  const clientSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
  const mnemoHooksDir = path.join(tmpDir, '.mnemo', 'hooks');

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.mnemo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates mnemo config, copies shims, and wires claude settings from scratch', () => {
    const result = installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });

    expect(fs.existsSync(mnemoConfigPath)).toBe(true);
    expect(fs.existsSync(clientSettingsPath)).toBe(true);

    const shimDir = path.join(mnemoHooksDir, 'claude-code');
    expect(fs.existsSync(path.join(shimDir, 'session-start.sh'))).toBe(true);
    expect(fs.existsSync(path.join(shimDir, 'prompt-submit.sh'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'session-start.sh')));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'prompt-submit.sh')));

    expect(result.configCreated).toBe(true);
    expect(result.hooksInstalled).toBe(true);
    expect(result.installedHooksPath).toBe(shimDir);
  });

  it('preserves existing claude settings and merges hooks', () => {
    fs.writeFileSync(clientSettingsPath, JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    }, null, 2));

    const result = installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });

    const settings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Read']);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);

    expect(result.hooksInstalled).toBe(true);
  });

  it('skips mnemo config if it already exists', () => {
    fs.writeFileSync(mnemoConfigPath, JSON.stringify({ apiUrl: 'https://existing.com' }));

    const result = installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });

    const config = JSON.parse(fs.readFileSync(mnemoConfigPath, 'utf-8'));
    expect(config.apiUrl).toBe('https://existing.com');
    expect(result.configCreated).toBe(false);
  });

  it('skips hooks if already installed', () => {
    installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });
    const result = installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });

    expect(result.hooksInstalled).toBe(false);

    const settings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('uses absolute paths for hook commands', () => {
    installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });

    const settings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf-8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(path.isAbsolute(cmd.split("'")[1])).toBe(true);
  });

  it('single-quotes hook paths so directories with spaces survive the shell', () => {
    const spacedHooksDir = path.join(tmpDir, 'Some Dir', '.mnemo', 'hooks');
    installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir: spacedHooksDir });

    const shimDir = path.join(spacedHooksDir, 'claude-code');
    const settings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf-8'));
    const sessionCmd = settings.hooks.SessionStart[0].hooks[0].command;

    expect(sessionCmd).toBe(`bash '${path.join(shimDir, 'session-start.sh')}'`);
    expect(sessionCmd.startsWith("bash '")).toBe(true);
    expect(sessionCmd.endsWith(".sh'")).toBe(true);
  });

  it('--force rewrites stale mnemo hook paths and preserves unrelated hooks', () => {
    fs.writeFileSync(clientSettingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash /stale/path/mnemo/session-start.sh', timeout: 15 }] },
        ],
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash /stale/path/mnemo/prompt-submit.sh', timeout: 10 }] },
        ],
      },
    }, null, 2));

    const result = installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir, force: true });

    const shimDir = path.join(mnemoHooksDir, 'claude-code');
    const settings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf-8'));

    expect(result.hooksInstalled).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('echo pre');
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'session-start.sh')));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'prompt-submit.sh')));
  });

  it('--force is a no-op when mnemo entries already point at the current shim paths', () => {
    installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir });
    const before = fs.readFileSync(clientSettingsPath, 'utf-8');

    const result = installHooks({ client: 'claude-code', mnemoConfigPath, clientSettingsPath, mnemoHooksDir, force: true });

    expect(result.hooksInstalled).toBe(false);
    expect(fs.readFileSync(clientSettingsPath, 'utf-8')).toBe(before);
  });
});

describe('install-hooks codex', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-codex-test-' + Date.now());
  const mnemoConfigPath = path.join(tmpDir, '.mnemo', 'config.json');
  const codexHooksPath = path.join(tmpDir, '.codex', 'hooks.json');
  const mnemoHooksDir = path.join(tmpDir, '.mnemo', 'hooks');

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.mnemo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates codex hooks.json and copies shims from scratch', () => {
    const result = installHooks({ client: 'codex', mnemoConfigPath, clientSettingsPath: codexHooksPath, mnemoHooksDir });

    expect(fs.existsSync(codexHooksPath)).toBe(true);

    const shimDir = path.join(mnemoHooksDir, 'codex');
    expect(fs.existsSync(path.join(shimDir, 'session-start.sh'))).toBe(true);
    expect(fs.existsSync(path.join(shimDir, 'prompt-submit.sh'))).toBe(true);

    const config = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    expect(config.hooks.SessionStart[0].matcher).toBe('startup');
    expect(config.hooks.SessionStart[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'session-start.sh')));
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'prompt-submit.sh')));

    expect(result.configCreated).toBe(true);
    expect(result.hooksInstalled).toBe(true);
    expect(result.installedHooksPath).toBe(shimDir);
  });

  it('preserves existing codex hooks and merges', () => {
    fs.writeFileSync(codexHooksPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    }, null, 2));

    const result = installHooks({ client: 'codex', mnemoConfigPath, clientSettingsPath: codexHooksPath, mnemoHooksDir });

    const config = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);

    expect(result.hooksInstalled).toBe(true);
  });

  it('skips codex hooks if already installed', () => {
    installHooks({ client: 'codex', mnemoConfigPath, clientSettingsPath: codexHooksPath, mnemoHooksDir });
    const result = installHooks({ client: 'codex', mnemoConfigPath, clientSettingsPath: codexHooksPath, mnemoHooksDir });

    expect(result.hooksInstalled).toBe(false);

    const config = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(config.hooks.SessionStart).toHaveLength(1);
  });

  it('uses startup matcher for codex SessionStart', () => {
    installHooks({ client: 'codex', mnemoConfigPath, clientSettingsPath: codexHooksPath, mnemoHooksDir });

    const config = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(config.hooks.SessionStart[0].matcher).toBe('startup');
  });

  it('--force rewrites stale codex mnemo entries and keeps startup matcher', () => {
    fs.writeFileSync(codexHooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'bash /stale/path/mnemo/session-start.sh', timeout: 15 }] },
        ],
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash /stale/path/mnemo/prompt-submit.sh', timeout: 10 }] },
        ],
      },
    }, null, 2));

    const result = installHooks({ client: 'codex', mnemoConfigPath, clientSettingsPath: codexHooksPath, mnemoHooksDir, force: true });

    const shimDir = path.join(mnemoHooksDir, 'codex');
    const config = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));

    expect(result.hooksInstalled).toBe(true);
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(config.hooks.SessionStart[0].matcher).toBe('startup');
    expect(config.hooks.SessionStart[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'session-start.sh')));
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toBe(bashCmd(path.join(shimDir, 'prompt-submit.sh')));
  });
});

describe('install-hooks openclaw', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-openclaw-test-' + Date.now());
  const mnemoConfigPath = path.join(tmpDir, '.mnemo', 'config.json');
  const openclawHooksDir = path.join(tmpDir, '.openclaw', 'hooks');

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.mnemo'), { recursive: true });
    fs.mkdirSync(openclawHooksDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('installs packaged hook assets and restarts the gateway', () => {
    const execFileSyncImpl = vi.fn();

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    const hookDir = path.join(openclawHooksDir, 'mnemo');
    expect(fs.existsSync(path.join(hookDir, 'HOOK.md'))).toBe(true);
    expect(fs.existsSync(path.join(hookDir, 'handler.js'))).toBe(true);
    expect(result.hooksInstalled).toBe(true);
    expect(result.gatewayRestarted).toBe(true);
    expect(result.openclawHookPath).toBe(hookDir);
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      'openclaw',
      ['gateway', 'restart'],
      { stdio: 'inherit' }
    );
    expect(fs.existsSync(path.join(hookDir, '.env'))).toBe(false);
  });

  it('writes channel routing config when channels are provided', () => {
    const execFileSyncImpl = vi.fn();

    installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      channels: 'telegram, whatsapp,telegram',
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    const envFile = path.join(openclawHooksDir, 'mnemo', '.env');
    expect(fs.readFileSync(envFile, 'utf-8')).toBe('MNEMO_OPENCLAW_CHANNELS=telegram,whatsapp\n');
  });

  it('skips restart when --no-restart is used', () => {
    const execFileSyncImpl = vi.fn();

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      noRestart: true,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(true);
    expect(result.gatewayRestarted).toBe(false);
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it('supports dry runs without writing files', () => {
    const execFileSyncImpl = vi.fn();

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      dryRun: true,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(false);
    expect(result.changesPlanned).toBe(true);
    expect(result.gatewayRestarted).toBe(false);
    expect(fs.existsSync(path.join(openclawHooksDir, 'mnemo'))).toBe(false);
    expect(fs.existsSync(mnemoConfigPath)).toBe(false);
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it('reports drift during dry run without requiring --force', () => {
    const execFileSyncImpl = vi.fn();
    const hookDir = path.join(openclawHooksDir, 'mnemo');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'HOOK.md'), 'custom');
    fs.writeFileSync(path.join(hookDir, 'handler.js'), 'custom');

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      dryRun: true,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(false);
    expect(result.changesPlanned).toBe(true);
    expect(result.gatewayRestarted).toBe(false);
    expect(fs.readFileSync(path.join(hookDir, 'HOOK.md'), 'utf-8')).toBe('custom');
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it('reports channel config changes during dry run', () => {
    installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      channels: 'telegram',
      noRestart: true,
      execFileSyncImpl: vi.fn() as unknown as typeof execFileSync,
    });

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      channels: 'whatsapp',
      dryRun: true,
      execFileSyncImpl: vi.fn() as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(false);
    expect(result.changesPlanned).toBe(true);
    expect(fs.readFileSync(path.join(openclawHooksDir, 'mnemo', '.env'), 'utf-8')).toBe('MNEMO_OPENCLAW_CHANNELS=telegram\n');
  });

  it('returns no-op when the installed hook already matches the packaged asset', () => {
    installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      noRestart: true,
      execFileSyncImpl: vi.fn() as unknown as typeof execFileSync,
    });

    const execFileSyncImpl = vi.fn();
    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(false);
    expect(result.changesPlanned).toBe(false);
    expect(result.gatewayRestarted).toBe(false);
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it('removes channel routing config when channels are omitted', () => {
    installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      channels: 'telegram',
      noRestart: true,
      execFileSyncImpl: vi.fn() as unknown as typeof execFileSync,
    });

    const execFileSyncImpl = vi.fn();
    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(true);
    expect(fs.existsSync(path.join(openclawHooksDir, 'mnemo', '.env'))).toBe(false);
    expect(execFileSyncImpl).toHaveBeenCalledOnce();
  });

  it('refuses to overwrite drifted hook files without --force', () => {
    const hookDir = path.join(openclawHooksDir, 'mnemo');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'HOOK.md'), 'custom');

    expect(() =>
      installHooks({
        client: 'openclaw',
        mnemoConfigPath,
        openclawHooksDir,
        execFileSyncImpl: vi.fn() as unknown as typeof execFileSync,
      })
    ).toThrow('Re-run with --force to overwrite it.');

    expect(fs.existsSync(mnemoConfigPath)).toBe(false);
  });

  it('signals cliMissing and skips restart when openclaw CLI is not on PATH', () => {
    const enoent = Object.assign(new Error('spawn openclaw ENOENT'), { code: 'ENOENT' });
    const execFileSyncImpl = vi.fn(() => { throw enoent; });

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(true);
    expect(result.gatewayRestarted).toBe(false);
    expect(result.gatewayCliMissing).toBe(true);
    expect(execFileSyncImpl).toHaveBeenCalledOnce();

    const hookDir = path.join(openclawHooksDir, 'mnemo');
    expect(fs.existsSync(path.join(hookDir, 'handler.js'))).toBe(true);
  });

  it('re-throws non-ENOENT restart errors', () => {
    const hookDir = path.join(openclawHooksDir, 'mnemo');
    fs.mkdirSync(hookDir, { recursive: true });
    const boom = Object.assign(new Error('gateway refused restart'), { code: 1 });
    const execFileSyncImpl = vi.fn(() => { throw boom; });

    expect(() =>
      installHooks({
        client: 'openclaw',
        mnemoConfigPath,
        openclawHooksDir,
        execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
      })
    ).toThrow('gateway refused restart');
  });

  it('overwrites drifted hook files with --force', () => {
    const execFileSyncImpl = vi.fn();
    const hookDir = path.join(openclawHooksDir, 'mnemo');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'HOOK.md'), 'custom');
    fs.writeFileSync(path.join(hookDir, 'handler.js'), 'custom');

    const result = installHooks({
      client: 'openclaw',
      mnemoConfigPath,
      openclawHooksDir,
      force: true,
      execFileSyncImpl: execFileSyncImpl as unknown as typeof execFileSync,
    });

    expect(result.hooksInstalled).toBe(true);
    expect(result.gatewayRestarted).toBe(true);
    expect(fs.readFileSync(path.join(hookDir, 'HOOK.md'), 'utf-8')).toContain('Capture OpenClaw message exchanges');
    expect(execFileSyncImpl).toHaveBeenCalledOnce();
  });
});

describe('install-hooks validation', () => {
  it('rejects unsupported clients', () => {
    expect(() =>
      installHooks({ client: 'unknown-tool' })
    ).toThrow('Unsupported client "unknown-tool"');
  });
});
