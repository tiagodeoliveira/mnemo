const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiUrl: 'https://mnemo.tiago.tools',
  auth0Domain: 'dev-jrva0wzk3qkdxcar.us.auth0.com',
  auth0Audience: 'https://mnemo.tiago.tools',
  auth0ClientId: 'naKbYOFItrLOwttTMZQ8pQSBJYwyJuzS',
  workstation: 'chrome-extension',
  enabled: true,
};

function originPattern(apiUrl) {
  try {
    const u = new URL(apiUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const merged = { ...DEFAULTS, ...cfg };
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!merged[k];
    else el.value = merged[k];
  }
  await refreshPermissionState();
  await refreshAuthStatus();
}

async function refreshPermissionState() {
  const pattern = originPattern($('apiUrl').value.trim());
  if (!pattern) {
    setPerm('Set an API URL first.', false);
    return false;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (granted) setPerm(`Permission granted for ${pattern}`, true);
  else setPerm(`Permission required for ${pattern} — click Save to grant.`, false);
  return granted;
}

function setStatus(msg, ok) {
  const el = $('status');
  el.hidden = false;
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

function setPerm(msg, ok) {
  const el = $('perm');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

async function refreshAuthStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'mnemo:authStatus' });
    $('authStatus').textContent = s && s.signedIn ? 'Signed in' : 'Not signed in';
  } catch (e) {
    $('authStatus').textContent = 'Status unavailable';
  }
}

async function save() {
  const apiUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  const workstation = $('workstation').value.trim() || 'chrome-extension';
  const enabled = $('enabled').checked;
  const auth0Domain = $('auth0Domain').value.trim();
  const auth0Audience = $('auth0Audience').value.trim();
  const auth0ClientId = $('auth0ClientId').value.trim();

  const pattern = originPattern(apiUrl);
  if (apiUrl && pattern) {
    const already = await chrome.permissions.contains({ origins: [pattern] });
    if (!already) {
      // Must run inside the click handler to count as a user gesture.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        setStatus('Saved settings, but host permission was denied — pushes will fail with CORS until granted.', false);
        await chrome.storage.local.set({ apiUrl, auth0Domain, auth0Audience, auth0ClientId, workstation, enabled });
        await refreshPermissionState();
        return;
      }
    }
  }

  await chrome.storage.local.set({ apiUrl, auth0Domain, auth0Audience, auth0ClientId, workstation, enabled });
  setStatus('Saved.', true);
  await refreshPermissionState();
}

async function signIn() {
  setStatus('Opening Auth0 sign-in tab…', true);
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'mnemo:startLogin' });
  } catch (e) {
    setStatus(`Login failed: ${e}`, false);
    return;
  }
  if (!resp || !resp.ok) {
    setStatus(`Login failed: ${resp && resp.error || 'unknown error'}`, false);
    return;
  }
  setStatus(`A new tab opened. Approve code ${resp.user_code} to complete sign-in.`, true);
  // Poll auth status until signed in or 60 s elapsed.
  let attempts = 0;
  const t = setInterval(async () => {
    attempts++;
    const s = await chrome.runtime.sendMessage({ type: 'mnemo:authStatus' });
    if ((s && s.signedIn) || attempts > 30) {
      clearInterval(t);
      await refreshAuthStatus();
      if (s && s.signedIn) setStatus('Signed in successfully.', true);
    }
  }, 2000);
}

async function signOut() {
  await chrome.runtime.sendMessage({ type: 'mnemo:signOut' });
  await refreshAuthStatus();
  setStatus('Signed out.', true);
}

async function test() {
  setStatus('Testing…', true);
  const res = await chrome.runtime.sendMessage({ type: 'test-push' });
  if (res && res.ok) setStatus('OK — mnemo accepted the test event.', true);
  else setStatus('Failed: ' + (res && res.error || 'unknown error'), false);
}

$('save').addEventListener('click', save);
$('signin').addEventListener('click', signIn);
$('signout').addEventListener('click', signOut);
$('test').addEventListener('click', test);
$('apiUrl').addEventListener('blur', refreshPermissionState);
load();
