import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installHooks } from '../src/commands/install-hooks';

describe('install-hooks', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-hooks-test-' + Date.now());
  const mnemoConfigPath = path.join(tmpDir, '.mnemo', 'config.json');
  const claudeSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
  const hooksDir = path.join(tmpDir, 'hooks');

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.mnemo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), '#!/bin/bash');
    fs.writeFileSync(path.join(hooksDir, 'prompt-submit.sh'), '#!/bin/bash');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates mnemo config and claude settings from scratch', () => {
    const result = installHooks({ client: 'claude-code', mnemoConfigPath, claudeSettingsPath, hooksDir });

    expect(fs.existsSync(mnemoConfigPath)).toBe(true);
    expect(fs.existsSync(claudeSettingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('session-start.sh');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('prompt-submit.sh');

    expect(result.configCreated).toBe(true);
    expect(result.hooksInstalled).toBe(true);
  });

  it('preserves existing claude settings and merges hooks', () => {
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    }, null, 2));

    const result = installHooks({ client: 'claude-code', mnemoConfigPath, claudeSettingsPath, hooksDir });

    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Read']);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);

    expect(result.hooksInstalled).toBe(true);
  });

  it('skips mnemo config if it already exists', () => {
    fs.writeFileSync(mnemoConfigPath, JSON.stringify({ apiUrl: 'https://existing.com' }));

    const result = installHooks({ client: 'claude-code', mnemoConfigPath, claudeSettingsPath, hooksDir });

    const config = JSON.parse(fs.readFileSync(mnemoConfigPath, 'utf-8'));
    expect(config.apiUrl).toBe('https://existing.com');
    expect(result.configCreated).toBe(false);
  });

  it('skips hooks if already installed', () => {
    installHooks({ client: 'claude-code', mnemoConfigPath, claudeSettingsPath, hooksDir });
    const result = installHooks({ client: 'claude-code', mnemoConfigPath, claudeSettingsPath, hooksDir });

    expect(result.hooksInstalled).toBe(false);

    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('rejects unsupported clients', () => {
    expect(() =>
      installHooks({ client: 'unknown-tool', mnemoConfigPath, claudeSettingsPath, hooksDir })
    ).toThrow('Unsupported client "unknown-tool"');
  });

  it('uses absolute paths for hook commands', () => {
    installHooks({ client: 'claude-code', mnemoConfigPath, claudeSettingsPath, hooksDir });

    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(path.isAbsolute(cmd.split(' ')[1])).toBe(true);
  });
});
