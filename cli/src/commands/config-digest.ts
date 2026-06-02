import { loadConfig } from '../config';
import { getAccessToken } from '../auth';

interface MeProfile {
  actor_id: string;
  display_name: string;
  email?: string;
  timezone: string;
  digest_enabled: boolean;
  episode_strategy: string;
}

function printDigestSettings(profile: MeProfile, header: string): void {
  console.log(header);
  console.log(`  Enabled:   ${profile.digest_enabled}`);
  console.log(`  Email:     ${profile.email || '(not set)'}`);
  console.log(`  Timezone:  ${profile.timezone}`);
}

async function getProfile(apiUrl: string, token: string): Promise<MeProfile> {
  const resp = await fetch(`${apiUrl}/me`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GET /me failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<MeProfile>;
}

async function patchProfile(apiUrl: string, token: string, body: Record<string, unknown>): Promise<MeProfile> {
  const resp = await fetch(`${apiUrl}/me`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PATCH /me failed (${resp.status}): ${text.trim()}`);
  }
  return resp.json() as Promise<MeProfile>;
}

export interface ConfigDigestOptions {
  enable?: boolean;
  disable?: boolean;
  timezone?: string;
  email?: string;
}

export async function configDigestCmd(opts: ConfigDigestOptions): Promise<void> {
  const config = loadConfig();
  const token = await getAccessToken({ domain: config.auth0Domain, clientId: config.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }

  // Validate mutually exclusive flags.
  if (opts.enable && opts.disable) {
    throw new Error('--enable and --disable are mutually exclusive');
  }

  const hasUpdate = opts.enable !== undefined || opts.disable !== undefined ||
                    opts.timezone !== undefined || opts.email !== undefined;

  if (!hasUpdate) {
    // Show current settings.
    const profile = await getProfile(config.apiUrl, token);
    printDigestSettings(profile, 'Digest Settings');
    return;
  }

  // Build PATCH body from provided flags.
  const body: Record<string, unknown> = {};
  if (opts.enable) body.digest_enabled = true;
  if (opts.disable) body.digest_enabled = false;
  if (opts.timezone !== undefined) body.timezone = opts.timezone;
  if (opts.email !== undefined) body.email = opts.email;

  const updated = await patchProfile(config.apiUrl, token, body);
  printDigestSettings(updated, 'Digest settings updated:');
}
