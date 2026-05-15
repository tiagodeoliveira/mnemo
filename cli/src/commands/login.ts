import { deviceLogin } from '../auth.js';
import { loadConfig } from '../config.js';

export async function loginCmd(): Promise<void> {
  const cfg = await loadConfig();
  await deviceLogin({
    domain: cfg.auth0Domain,
    audience: cfg.auth0Audience,
    clientId: cfg.auth0ClientId,
  });
}
