const $ = (id) => document.getElementById(id);

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
}

function setStatus(msg, ok) {
  const el = $('status');
  el.hidden = false;
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

async function save() {
  const apiUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  const workstation = $('workstation').value.trim() || 'chrome-extension';
  const enabled = $('enabled').checked;
  await chrome.storage.local.set({ apiUrl, apiKey, workstation, enabled });
  setStatus('Saved.', true);
}

async function test() {
  setStatus('Testing…', true);
  const res = await chrome.runtime.sendMessage({ type: 'test-push' });
  if (res && res.ok) setStatus('OK — mnemo accepted the test event.', true);
  else setStatus('Failed: ' + (res && res.error || 'unknown error'), false);
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
