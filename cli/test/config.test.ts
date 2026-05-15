import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';

describe('config loader', () => {
  const tmpDir = path.join(os.tmpdir(), 'mnemo-test-' + Date.now());
  const configPath = path.join(tmpDir, '.mnemo', 'config.json');

  beforeEach(() => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config and populates auth0 fields from explicit values', () => {
    const config = {
      apiUrl: 'https://api.example.com/v1',
      auth0Domain: 'tenant.us.auth0.com',
      auth0Audience: 'https://api.example.com',
      auth0ClientId: 'client-123',
      workstation: 'my-laptop',
      defaults: { visible: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.apiUrl).toBe('https://api.example.com/v1');
    expect(loaded.auth0Domain).toBe('tenant.us.auth0.com');
    expect(loaded.auth0Audience).toBe('https://api.example.com');
    expect(loaded.auth0ClientId).toBe('client-123');
    expect(loaded.workstation).toBe('my-laptop');
  });

  it('falls back to baked-in auth0 defaults when fields are absent', () => {
    const config = { apiUrl: 'https://api.example.com/v1', defaults: { visible: true } };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.auth0Domain).toBeTruthy();
    expect(loaded.auth0Audience).toBeTruthy();
    expect(loaded.auth0ClientId).toBeTruthy();
  });

  it('uses hostname when workstation not set', () => {
    const config = { apiUrl: 'https://api.example.com/v1', defaults: { visible: true } };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadConfig(configPath);
    expect(loaded.workstation).toBe(os.hostname());
  });

  it('throws when config file not found', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow();
  });

  it('throws when apiUrl is missing', () => {
    fs.writeFileSync(configPath, JSON.stringify({ defaults: { visible: true } }));
    expect(() => loadConfig(configPath)).toThrow('apiUrl');
  });

  it('throws when apiUrl is empty string', () => {
    fs.writeFileSync(configPath, JSON.stringify({ apiUrl: '', defaults: { visible: true } }));
    expect(() => loadConfig(configPath)).toThrow('apiUrl');
  });

  it('throws when config file contains invalid JSON', () => {
    fs.writeFileSync(configPath, 'not json at all');
    expect(() => loadConfig(configPath)).toThrow();
  });
});
