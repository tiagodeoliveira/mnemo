// Default identity + endpoint values shipped with this CLI build.
//
// The committed values point at localhost so `npm run build` produces a
// CLI usable against a self-hosted dev server with zero setup. Forks that
// publish their own CLI override these at release time by setting four
// repo Variables — AUTH0_DOMAIN, AUTH0_AUDIENCE, AUTH0_CLIENT_ID,
// MNEMO_API_URL — which .github/workflows/release.yml stamps into this
// file during `publish-cli`. See that workflow for the contract.

export const DEFAULTS = {
  apiUrl: 'http://localhost:18080',
  auth0Domain: '',
  auth0Audience: '',
  auth0ClientId: '',
} as const;
