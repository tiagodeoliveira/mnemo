import { loadConfig } from '../config';
import { executeGetProfile, executePatchProfile, type ProfileOptions } from './profile';

const DEFAULT_DOMAINS = ['coding', 'studying', 'meeting', 'general'];

function printDomains(domains: string[], header: string): void {
  console.log(header);
  for (const d of domains) {
    console.log(`  - ${d}`);
  }
}

function loadProfileOptions(): ProfileOptions {
  const config = loadConfig();
  return {
    apiUrl: config.apiUrl,
    auth0Domain: config.auth0Domain,
    auth0ClientId: config.auth0ClientId,
  };
}

export async function configDomainsListCmd(): Promise<void> {
  const profileOptions = loadProfileOptions();
  const profile = await executeGetProfile(profileOptions);
  printDomains(profile.task_domains, 'Task domains:');
}

export async function configDomainsAddCmd(toAdd: string[]): Promise<void> {
  if (toAdd.length === 0) {
    throw new Error('Provide at least one domain to add');
  }
  const profileOptions = loadProfileOptions();
  const profile = await executeGetProfile(profileOptions);
  const merged = Array.from(new Set([...profile.task_domains, ...toAdd.map((d) => d.toLowerCase())]));
  const updated = await executePatchProfile(profileOptions, { task_domains: merged });
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
  const profileOptions = loadProfileOptions();
  const profile = await executeGetProfile(profileOptions);
  const removeSet = new Set(lowered);
  const filtered = profile.task_domains.filter((d) => !removeSet.has(d));
  const updated = await executePatchProfile(profileOptions, { task_domains: filtered });
  printDomains(updated.task_domains, 'Task domains updated:');
}

export async function configDomainsResetCmd(): Promise<void> {
  const profileOptions = loadProfileOptions();
  const updated = await executePatchProfile(profileOptions, { task_domains: DEFAULT_DOMAINS });
  printDomains(updated.task_domains, 'Task domains reset to defaults:');
}
