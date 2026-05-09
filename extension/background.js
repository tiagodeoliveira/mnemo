// Service worker. Receives events from content scripts, pushes captures to
// mnemo, maintains health state, and reflects status in the toolbar icon.

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

const DEFAULTS = {
  apiUrl: '',
  apiKey: '',
  workstation: 'chrome-extension',
  enabled: true,
};

// ---- Storage helpers ------------------------------------------------------

async function loadConfig() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...cfg };
}

// ---- Mnemo push -----------------------------------------------------------

async function pushToMnemo(detail) {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!cfg.apiUrl || !cfg.apiKey) {
    return { skipped: 'unconfigured' };
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
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey },
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
  return String(s).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 256);
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
  if (!cfg.apiUrl || !cfg.apiKey) {
    return { color: '#777', label: 'cfg', detail: 'API URL or key not set' };
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
      logEntry('info', `captured ${msg.detail && msg.detail.site} turn`, {
        site: msg.detail && msg.detail.site,
        userChars: (msg.detail && msg.detail.userMessage || '').length,
        assistantChars: (msg.detail && msg.detail.assistantMessage || '').length,
      });
      try {
        const res = await pushToMnemo(msg.detail);
        if (res && res.ok) {
          HEALTH.lastPushOkAt = Date.now();
          logEntry('info', `pushed to mnemo (${res.turns} turns, session=${res.sessionId})`);
        } else if (res && res.skipped) {
          logEntry('warn', `push skipped: ${res.skipped}`);
        }
      } catch (e) {
        HEALTH.pushFailures += 1;
        HEALTH.lastPushFailAt = Date.now();
        HEALTH.lastPushFailMessage = String(e && e.message || e);
        logEntry('error', `push failed: ${HEALTH.lastPushFailMessage}`);
      }
      break;
    }

    case 'get-status': {
      const status = await computeStatus();
      const cfg = await loadConfig();
      return {
        ok: true,
        status,
        health: HEALTH,
        config: { ...cfg, apiKey: cfg.apiKey ? '••••' : '' },
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
  }

  await refreshUi();
}

// Periodic refresh so "stale" transitions show up without an event.
chrome.alarms.create('mnemo-refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mnemo-refresh') void refreshUi();
});

// Initial paint.
void (async () => {
  await restoreHealth();
  await refreshUi();
})();
