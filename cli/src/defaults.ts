// Default identity + endpoint values shipped with this CLI build.
//
// The committed values are what the project ships with by default
// (Tiago's mnemo tenant + kleos audience). CI regenerates this file
// at release time from GitHub repo Variables — AUTH0_DOMAIN,
// AUTH0_AUDIENCE, AUTH0_CLIENT_ID, MNEMO_API_URL — so changing any
// of them is a dashboard edit, not a code change. Forks override the
// same way: set the four repo Variables in your own GitHub project.
//
// Local dev: the committed values stay current so `npm run build`
// produces a working CLI against prod with zero setup.

export const DEFAULTS = {
  apiUrl: 'https://mnemo.tiago.tools',
  auth0Domain: 'dev-jrva0wzk3qkdxcar.us.auth0.com',
  auth0Audience: 'https://kleos.tiago.tools',
  auth0ClientId: 'naKbYOFItrLOwttTMZQ8pQSBJYwyJuzS',
} as const;
