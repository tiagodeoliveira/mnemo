const $ = (id) => document.getElementById(id);

function originPattern(apiUrl) {
  try {
    const u = new URL(apiUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function load() {
  const cfg = await chrome.storage.local.get({
    apiUrl: '',
    apiKey: '',
    workstation: 'chrome-extension',
    enabled: true,
  });
  $('apiUrl').value = cfg.apiUrl;
  $('apiKey').value = cfg.apiKey;
  $('workstation').value = cfg.workstation;
  $('enabled').checked = !!cfg.enabled;
  await refreshPermissionState();
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

async function save() {
  const apiUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  const workstation = $('workstation').value.trim() || 'chrome-extension';
  const enabled = $('enabled').checked;

  const pattern = originPattern(apiUrl);
  if (apiUrl && pattern) {
    const already = await chrome.permissions.contains({ origins: [pattern] });
    if (!already) {
      // Must run inside the click handler to count as a user gesture.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        setStatus('Saved settings, but host permission was denied — pushes will fail with CORS until granted.', false);
        await chrome.storage.local.set({ apiUrl, apiKey, workstation, enabled });
        await refreshPermissionState();
        return;
      }
    }
  }

  await chrome.storage.local.set({ apiUrl, apiKey, workstation, enabled });
  setStatus('Saved.', true);
  await refreshPermissionState();
}

async function test() {
  setStatus('Testing…', true);
  const res = await chrome.runtime.sendMessage({ type: 'test-push' });
  if (res && res.ok) setStatus('OK — mnemo accepted the test event.', true);
  else setStatus('Failed: ' + (res && res.error || 'unknown error'), false);
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
$('apiUrl').addEventListener('blur', refreshPermissionState);
load();
