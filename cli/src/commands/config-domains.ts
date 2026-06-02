import { loadConfig } from '../config';
import { getAccessToken } from '../auth';

interface MeProfile {
  actor_id: string;
  display_name: string;
  email?: string;
  timezone: string;
  digest_enabled: boolean;
  episode_strategy: string;
  task_domains: string[];
}

const DEFAULT_DOMAINS = ['coding', 'studying', 'meeting', 'general'];

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

async function patchDomains(apiUrl: string, token: string, domains: string[]): Promise<MeProfile> {
  const resp = await fetch(`${apiUrl}/me`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ task_domains: domains }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PATCH /me failed (${resp.status}): ${text.trim()}`);
  }
  return resp.json() as Promise<MeProfile>;
}

function printDomains(domains: string[], header: string): void {
  console.log(header);
  for (const d of domains) {
    console.log(`  - ${d}`);
  }
}

async function loadTokenAndConfig(): Promise<{ apiUrl: string; token: string }> {
  const config = loadConfig();
  const token = await getAccessToken({ domain: config.auth0Domain, clientId: config.auth0ClientId });
  if (!token) {
    throw new Error("Not logged in. Run 'mnemo login' first.");
  }
  return { apiUrl: config.apiUrl, token };
}

export async function configDomainsListCmd(): Promise<void> {
  const { apiUrl, token } = await loadTokenAndConfig();
  const profile = await getProfile(apiUrl, token);
  printDomains(profile.task_domains, 'Task domains:');
}

export async function configDomainsAddCmd(toAdd: string[]): Promise<void> {
  if (toAdd.length === 0) {
    throw new Error('Provide at least one domain to add');
  }
  const { apiUrl, token } = await loadTokenAndConfig();
  const profile = await getProfile(apiUrl, token);
  const merged = Array.from(new Set([...profile.task_domains, ...toAdd.map((d) => d.toLowerCase())]));
  const updated = await patchDomains(apiUrl, token, merged);
  printDomains(updated.task_domains, 'Task domains updated:');
}

export async function configDomainsRemoveCmd(toRemove: string[]): Promise<void> {
  if (toRemove.length === 0) {
    throw new Error('Provide at least one domain to remove');
  }
  const lowered = toRemove.map((d) => d.toLowerCase());
  if (lowered.includes('general')) {
    throw new Error("'general' is the fallback domain and cannot be removed");
  }
  const { apiUrl, token } = await loadTokenAndConfig();
  const profile = await getProfile(apiUrl, token);
  const removeSet = new Set(lowered);
  const filtered = profile.task_domains.filter((d) => !removeSet.has(d));
  const updated = await patchDomains(apiUrl, token, filtered);
  printDomains(updated.task_domains, 'Task domains updated:');
}

export async function configDomainsResetCmd(): Promise<void> {
  const { apiUrl, token } = await loadTokenAndConfig();
  const updated = await patchDomains(apiUrl, token, DEFAULT_DOMAINS);
  printDomains(updated.task_domains, 'Task domains reset to defaults:');
}
