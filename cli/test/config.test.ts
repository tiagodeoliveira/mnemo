import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, type MnemoConfig } from '../src/config';

describe('config loader', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-test-' + Date.now());
  const configPath = path.join(tmpDir, '.mnemo', 'config.json');

  beforeEach(() => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config from file', () => {
    const config: MnemoConfig = {
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      workstation: 'my-laptop',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.apiUrl).toBe('https://api.example.com/v1');
    expect(loaded.apiKey).toBe('test-key');
    expect(loaded.workstation).toBe('my-laptop');
  });

  it('uses hostname when workstation not set', () => {
    const config = {
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.workstation).toBe(os.hostname());
  });

  it('throws when config file not found', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow();
  });

  it('throws when apiUrl is missing', () => {
    const config = {
      apiKey: 'test-key',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    expect(() => loadConfig(configPath)).toThrow('apiUrl');
  });

  it('throws when apiKey is missing', () => {
    const config = {
      apiUrl: 'https://api.example.com/v1',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    expect(() => loadConfig(configPath)).toThrow('apiKey');
  });

  it('throws when apiUrl is empty string', () => {
    const config = {
      apiUrl: '',
      apiKey: 'test-key',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    expect(() => loadConfig(configPath)).toThrow('apiUrl');
  });

  it('throws when config file contains invalid JSON', () => {
    fs.writeFileSync(configPath, 'not json at all');

    expect(() => loadConfig(configPath)).toThrow();
  });
});
