// Service worker. Receives events from content scripts, pushes captures to
// mnemo, maintains health state, and reflects status in the toolbar icon.

import { DEFAULTS } from './defaults.js';

const HEALTH = {
  // Global counters
  captures: 0,
  pushFailures: 0,
  parseErrors: 0,
  tampers: 0,
  // Timestamps (ms epoch)
  lastCaptureAt: 0,
  lastPushOkAt: 0,
  lastPushFailAt: 0,
  lastParseErrorAt: 0,
  lastTamperAt: 0,
  lastReadyAt: 0,
  lastHeartbeatAt: 0,
  lastPushFailMessage: '',
  // Recent activity log (newest first)
  log: [],
};

const RECENT_CAPTURES_MAX = 20;
const STALE_AFTER_MS = 10 * 60 * 1000; // 10 min on-site without capture → yellow

// DEFAULTS imported from ./defaults.js — CI regenerates that file at
// release time from GitHub repo Variables.

// ---- Auth0 device flow + token storage ------------------------------------
// Tokens live in chrome.storage.local under 'mnemo_creds' as
// { access_token, refresh_token, expires_at }.

const CRED_KEY = 'mnemo_creds';

async function startDeviceLogin(cfg) {
  const dcRes = await fetch(`https://${cfg.auth0Domain}/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.auth0ClientId,
      scope: 'openid profile email offline_access',
      audience: cfg.auth0Audience,
    }),
  });
  if (!dcRes.ok) throw new Error(`device/code ${dcRes.status}`);
  const dc = await dcRes.json();
  // Open the verification page for the user.
  chrome.tabs.create({ url: dc.verification_uri_complete });
  return dc; // caller will poll
}

async function pollDeviceToken(cfg, deviceCode) {
  const res = await fetch(`https://${cfg.auth0Domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: cfg.auth0ClientId,
    }),
  });
  const t = await res.json();
  return t; // {access_token,...} | {error:'authorization_pending'|...}
}

async function saveCredentials(t) {
  const cred = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (t.expires_in || 0),
  };
  await chrome.storage.local.set({ [CRED_KEY]: cred });
}

async function loadCredentials() {
  const got = await chrome.storage.local.get(CRED_KEY);
  return got[CRED_KEY] || null;
}

async function clearCredentials() {
  await chrome.storage.local.remove(CRED_KEY);
}

async function refreshAccessToken(cfg) {
  const cur = await loadCredentials();
  if (!cur || !cur.refresh_token) return null;
  const res = await fetch(`https://${cfg.auth0Domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.auth0ClientId,
      refresh_token: cur.refresh_token,
    }),
  });
  if (!res.ok) return null;
  const t = await res.json();
  if (!t.access_token) return null;
  const fresh = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || cur.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (t.expires_in || 0),
  };
  await chrome.storage.local.set({ [CRED_KEY]: fresh });
  return fresh.access_token;
}

async function getAccessToken(cfg) {
  const cur = await loadCredentials();
  if (!cur) return null;
  if (cur.expires_at - 60 > Math.floor(Date.now() / 1000)) {
    return cur.access_token;
  }
  return await refreshAccessToken(cfg);
}

// ---- Storage helpers ------------------------------------------------------

async function loadConfig() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...cfg };
}

// ---- Mnemo push -----------------------------------------------------------

async function pushToMnemo(detail) {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!cfg.apiUrl || !cfg.auth0Domain || !cfg.auth0ClientId) {
    return { skipped: 'unconfigured' };
  }

  const token = await getAccessToken(cfg);
  if (!token) {
    console.warn('[mnemo] no access token — skipping push (sign in via Options)');
    return { skipped: 'unauthenticated' };
  }

  const turns = [];
  if (detail.userMessage) turns.push({ role: 'user', content: truncate(detail.userMessage, 100_000) });
  if (detail.assistantMessage) turns.push({ role: 'assistant', content: truncate(detail.assistantMessage, 100_000) });
  if (turns.length === 0) return { skipped: 'empty' };

  const sessionId = sanitizeSessionId(detail.conversationId || `${detail.site}:${hash(detail.url)}`);
  const now = new Date(detail.capturedAt || Date.now());

  const body = {
    sessionId,
    turns,
    context: {
      workstation: cfg.workstation || 'chrome-extension',
      workdir: detail.url || `https://${detail.site}/`,
      timestamp: now.toISOString(),
      date: localDate(now),
      source: 'chrome-extension',
      attributes: {
        site: detail.site || 'unknown',
        kind: detail.kind || 'unknown',
      },
    },
  };

  const url = cfg.apiUrl.replace(/\/+$/, '') + '/events';

  // Without a host permission for the API origin, the fetch hits CORS.
  // Detect that up front so the popup shows a useful message.
  try {
    const u = new URL(url);
    const pattern = `${u.protocol}//${u.host}/*`;
    const granted = await chrome.permissions.contains({ origins: [pattern] });
    if (!granted) {
      throw new Error(`missing host permission for ${pattern} — open Options and click Save to grant`);
    }
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`invalid API URL: ${cfg.apiUrl}`);
    throw e;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`push ${res.status}: ${text.slice(0, 200)}`);
  }
  return { ok: true, sessionId, turns: turns.length };
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) : s; }
function sanitizeSessionId(s) {
  // Bedrock AgentCore sessionId allows only [a-zA-Z0-9_-]; '.' and ':' get rejected.
  const cleaned = String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256);
  return cleaned || 'unknown';
}
function localDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ---- Health state + log ---------------------------------------------------

function logEntry(level, message, extra) {
  HEALTH.log.unshift({
    at: Date.now(),
    level, // 'info' | 'warn' | 'error'
    message,
    ...(extra || {}),
  });
  if (HEALTH.log.length > RECENT_CAPTURES_MAX) HEALTH.log.length = RECENT_CAPTURES_MAX;
  void persistHealth();
}

async function persistHealth() {
  // Persist a slim subset so the popup can render after SW restart.
  await chrome.storage.session.set({ health: HEALTH }).catch(() => {});
}

async function restoreHealth() {
  try {
    const { health } = await chrome.storage.session.get('health');
    if (health && typeof health === 'object') Object.assign(HEALTH, health);
  } catch (_) {}
}

// ---- Status: badge + icon -------------------------------------------------
//
// We render a colored dot directly via OffscreenCanvas so the extension has no
// PNG asset dependency. The dot color encodes health:
//   green  = recent successful capture
//   blue   = configured + on-site, idle
//   yellow = on-site, no captures for STALE_AFTER_MS
//   red    = parse error / tamper / push failure since last capture
//   gray   = unconfigured

async function computeStatus() {
  const cfg = await loadConfig();
  const now = Date.now();
  if (!cfg.apiUrl || !cfg.auth0Domain || !cfg.auth0ClientId) {
    return { color: '#777', label: 'cfg', detail: 'API URL or Auth0 config not set' };
  }
  if (!cfg.enabled) {
    return { color: '#777', label: 'off', detail: 'Capture disabled' };
  }
  if (HEALTH.lastTamperAt && HEALTH.lastTamperAt > HEALTH.lastCaptureAt) {
    return { color: '#d33', label: '!', detail: 'fetch was replaced — re-patched' };
  }
  if (HEALTH.lastPushFailAt && HEALTH.lastPushFailAt > HEALTH.lastPushOkAt) {
    return { color: '#d33', label: '!', detail: 'last push to mnemo failed' };
  }
  if (HEALTH.lastParseErrorAt && HEALTH.lastParseErrorAt > HEALTH.lastCaptureAt) {
    return { color: '#d33', label: '!', detail: 'API call seen but no turns parsed — site may have changed' };
  }
  if (HEALTH.lastCaptureAt && now - HEALTH.lastCaptureAt < STALE_AFTER_MS) {
    return { color: '#2a8', label: 'ok', detail: `last capture ${fmtAgo(now - HEALTH.lastCaptureAt)}` };
  }
  if (HEALTH.lastHeartbeatAt && now - HEALTH.lastHeartbeatAt < 90_000) {
    if (!HEALTH.lastCaptureAt || now - HEALTH.lastCaptureAt > STALE_AFTER_MS) {
      return { color: '#cc0', label: '?', detail: 'on-site but no captures yet' };
    }
  }
  return { color: '#48a', label: '', detail: 'idle' };
}

function fmtAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

async function refreshUi() {
  const status = await computeStatus();
  try {
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillStyle = status.color;
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const imageData = ctx.getImageData(0, 0, 32, 32);
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    // OffscreenCanvas not available in some test contexts; non-fatal.
  }
  await chrome.action.setBadgeText({ text: status.label || '' });
  await chrome.action.setBadgeBackgroundColor({ color: status.color });
  await chrome.action.setTitle({
    title: `mnemo capture — ${status.detail}` +
      (HEALTH.captures ? `\n${HEALTH.captures} captures, ${HEALTH.pushFailures} push failures` : ''),
  });
}

// ---- Login poll alarm handler (registered once at top level) --------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'mnemo-refresh') {
    void refreshUi();
    return;
  }
  if (alarm.name === 'mnemo-login-poll') {
    // Delegated to the stored poll state; nothing to do here unless
    // options.js re-sends a startLogin. The alarm fires the tick closure
    // stored in the outer scope by handleMessage. Because service workers
    // can restart between alarms, we re-read config and device_code from
    // storage if available.
    const got = await chrome.storage.local.get('mnemo_login_pending');
    const pending = got.mnemo_login_pending;
    if (!pending) return;
    if (Date.now() > pending.deadline) {
      await chrome.storage.local.remove('mnemo_login_pending');
      return;
    }
    const cfg = await loadConfig();
    const t = await pollDeviceToken(cfg, pending.device_code);
    if (t.access_token) {
      await saveCredentials(t);
      await chrome.storage.local.remove('mnemo_login_pending');
      return;
    }
    if (!t.error || t.error === 'authorization_pending' || t.error === 'slow_down') {
      const interval = t.error === 'slow_down' ? pending.interval + 5 : pending.interval;
      chrome.alarms.create('mnemo-login-poll', { when: Date.now() + interval * 1000 });
    }
  }
});

// ---- Event handling -------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await restoreHealth();
  await refreshUi();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreHealth();
  await refreshUi();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => sendResponse(r || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async
});

async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'ready':
      HEALTH.lastReadyAt = Date.now();
      logEntry('info', `inject.js ready on ${msg.detail && msg.detail.site}`);
      break;

    case 'heartbeat':
      HEALTH.lastHeartbeatAt = Date.now();
      break;

    case 'diagnostic':
      logEntry('info', `diagnostic: nativeFetchLooksNative=${msg.detail && msg.detail.nativeFetchLooksNative}`);
      break;

    case 'tamper':
      HEALTH.tampers += 1;
      HEALTH.lastTamperAt = Date.now();
      logEntry('warn', `fetch was replaced; re-patched (${msg.detail && msg.detail.site})`);
      break;

    case 'parse-error':
      HEALTH.parseErrors += 1;
      HEALTH.lastParseErrorAt = Date.now();
      logEntry('error', `parse failed on ${msg.detail && msg.detail.kind}`, {
        kind: msg.detail && msg.detail.kind,
        hadUserMessage: msg.detail && msg.detail.hadUserMessage,
        hadAssistantMessage: msg.detail && msg.detail.hadAssistantMessage,
      });
      break;

    case 'capture': {
      HEALTH.captures += 1;
      HEALTH.lastCaptureAt = Date.now();
      console.log('[mnemo] capture', {
        site: msg.detail && msg.detail.site,
        kind: msg.detail && msg.detail.kind,
        conversationId: msg.detail && msg.detail.conversationId,
        userChars: (msg.detail && msg.detail.userMessage || '').length,
        assistantChars: (msg.detail && msg.detail.assistantMessage || '').length,
      });
      logEntry('info', `captured ${msg.detail && msg.detail.site} turn`, {
        site: msg.detail && msg.detail.site,
        userChars: (msg.detail && msg.detail.userMessage || '').length,
        assistantChars: (msg.detail && msg.detail.assistantMessage || '').length,
      });
      try {
        const res = await pushToMnemo(msg.detail);
        if (res && res.ok) {
          HEALTH.lastPushOkAt = Date.now();
          console.log('[mnemo] push ok', { sessionId: res.sessionId, turns: res.turns });
          logEntry('info', `pushed to mnemo (${res.turns} turns, session=${res.sessionId})`);
        } else if (res && res.skipped) {
          console.warn('[mnemo] push skipped', res.skipped);
          logEntry('warn', `push skipped: ${res.skipped}`);
        }
      } catch (e) {
        HEALTH.pushFailures += 1;
        HEALTH.lastPushFailAt = Date.now();
        HEALTH.lastPushFailMessage = String(e && e.message || e);
        console.error('[mnemo] push failed', e);
        logEntry('error', `push failed: ${HEALTH.lastPushFailMessage}`);
      }
      break;
    }

    case 'get-status': {
      const status = await computeStatus();
      const cfg = await loadConfig();
      const cred = await loadCredentials();
      return {
        ok: true,
        status,
        health: HEALTH,
        config: { apiUrl: cfg.apiUrl, workstation: cfg.workstation, signedIn: !!cred },
      };
    }

    case 'test-push': {
      try {
        const res = await pushToMnemo({
          site: 'chrome-extension',
          kind: 'test',
          conversationId: 'mnemo-extension-test',
          url: 'chrome-extension://test',
          userMessage: 'mnemo extension test ping',
          assistantMessage: 'pong',
          capturedAt: new Date().toISOString(),
        });
        return { ok: true, result: res };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }

    case 'mnemo:startLogin': {
      const cfg = await loadConfig();
      try {
        const dc = await startDeviceLogin(cfg);
        const deadline = Date.now() + dc.expires_in * 1000;
        const interval = Math.max(5, dc.interval || 5);
        // Persist pending state so the alarm handler can resume after SW restart.
        await chrome.storage.local.set({
          mnemo_login_pending: {
            device_code: dc.device_code,
            deadline,
            interval,
          },
        });
        // Schedule first poll.
        chrome.alarms.create('mnemo-login-poll', { when: Date.now() + interval * 1000 });
        return { ok: true, verification_uri_complete: dc.verification_uri_complete, user_code: dc.user_code };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }

    case 'mnemo:signOut': {
      await clearCredentials();
      return { ok: true };
    }

    case 'mnemo:authStatus': {
      const cred = await loadCredentials();
      return { ok: true, signedIn: !!cred, expires_at: cred ? cred.expires_at : null };
    }
  }

  await refreshUi();
}

// Periodic refresh so "stale" transitions show up without an event.
chrome.alarms.create('mnemo-refresh', { periodInMinutes: 1 });

// Initial paint.
void (async () => {
  await restoreHealth();
  await refreshUi();
})();
