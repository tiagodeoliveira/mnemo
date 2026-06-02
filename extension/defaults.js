// Default identity + endpoint values shipped with this extension build.
//
// The committed values point at localhost so the extension works against
// a self-hosted dev server with zero setup. Forks that publish their own
// extension override these at release time by setting four repo
// Variables — AUTH0_DOMAIN, AUTH0_AUDIENCE, AUTH0_CLIENT_ID,
// MNEMO_API_URL — which .github/workflows/release.yml stamps into this
// file during `publish-extension`.
//
// Imported as an ES module by both background.js (the service worker
// is declared with `"type": "module"` in manifest.json) and options.js
// (loaded via `<script type="module">` in options.html).

export const DEFAULTS = {
  apiUrl: 'http://localhost:18080',
  auth0Domain: '',
  auth0Audience: '',
  auth0ClientId: '',
  workstation: 'chrome-extension',
  enabled: true,
};
