import { loadConfig } from '../config';
import { executeGetProfile, executePatchProfile, type MeProfile, type ProfileOptions } from './profile';

function printDigestSettings(profile: MeProfile, header: string): void {
  console.log(header);
  console.log(`  Enabled:   ${profile.digest_enabled}`);
  console.log(`  Email:     ${profile.email || '(not set)'}`);
  console.log(`  Timezone:  ${profile.timezone}`);
}

function loadProfileOptions(): ProfileOptions {
  const config = loadConfig();
  return {
    apiUrl: config.apiUrl,
    auth0Domain: config.auth0Domain,
    auth0ClientId: config.auth0ClientId,
  };
}

export interface ConfigDigestOptions {
  enable?: boolean;
  disable?: boolean;
  timezone?: string;
  email?: string;
}

export async function configDigestCmd(opts: ConfigDigestOptions): Promise<void> {
  if (opts.enable && opts.disable) {
    throw new Error('--enable and --disable are mutually exclusive');
  }

  const hasUpdate = opts.enable !== undefined || opts.disable !== undefined ||
                    opts.timezone !== undefined || opts.email !== undefined;
  const profileOptions = loadProfileOptions();

  if (!hasUpdate) {
    const profile = await executeGetProfile(profileOptions);
    printDigestSettings(profile, 'Digest Settings');
    return;
  }

  const body: Record<string, unknown> = {};
  if (opts.enable) body.digest_enabled = true;
  if (opts.disable) body.digest_enabled = false;
  if (opts.timezone !== undefined) body.timezone = opts.timezone;
  if (opts.email !== undefined) body.email = opts.email;

  const updated = await executePatchProfile(profileOptions, body);
  printDigestSettings(updated, 'Digest settings updated:');
}
