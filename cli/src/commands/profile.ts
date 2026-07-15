import { getAccessToken } from '../auth';

export interface ProfileOptions {
  apiUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
}

export interface MeProfile {
  actor_id: string;
  display_name: string;
  email?: string;
  timezone: string;
  digest_enabled: boolean;
  episode_strategy: string;
  task_domains: string[];
}

async function loadToken(opts: ProfileOptions): Promise<string> {
  const token = await getAccessToken({ domain: opts.auth0Domain, clientId: opts.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }
  return token;
}

export async function executeGetProfile(opts: ProfileOptions): Promise<MeProfile> {
  const token = await loadToken(opts);
  const resp = await fetch(`${opts.apiUrl}/me`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GET /me failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<MeProfile>;
}

export async function executePatchProfile(opts: ProfileOptions, body: Record<string, unknown>): Promise<MeProfile> {
  const token = await loadToken(opts);
  const resp = await fetch(`${opts.apiUrl}/me`, {
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
