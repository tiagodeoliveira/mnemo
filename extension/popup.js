const $ = (id) => document.getElementById(id);

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

function fmtAgo(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'get-status' });
  if (!res || !res.ok) {
    $('detail').textContent = 'service worker unreachable';
    return;
  }
  const { status, health, config } = res;

  $('dot').style.background = status.color;
  $('detail').textContent = status.detail;

  const cfgLine = config.apiUrl
    ? `→ ${config.apiUrl.replace(/^https?:\/\//, '')}`
    : 'API not configured — open Options';
  $('title').textContent = `mnemo capture · ${cfgLine}`;

  const stats = [
    ['Captures', health.captures],
    ['Push failures', health.pushFailures],
    ['Parse errors', health.parseErrors],
    ['Tampering events', health.tampers],
    ['Last capture', fmtAgo(health.lastCaptureAt)],
    ['Last push ok', fmtAgo(health.lastPushOkAt)],
    ['Last push fail', fmtAgo(health.lastPushFailAt)],
    ['Last heartbeat', fmtAgo(health.lastHeartbeatAt)],
  ];
  $('stats').innerHTML = stats
    .map(([k, v]) => `<div class="k">${k}</div><div>${v ?? '—'}</div>`)
    .join('');

  if (!health.log || health.log.length === 0) {
    $('log').innerHTML = '<div class="empty">No activity yet.</div>';
  } else {
    $('log').innerHTML = health.log
      .map((e) => {
        const lvl = e.level || 'info';
        const t = fmtTime(e.at);
        return `<div class="e ${lvl}"><time>${t}</time>${escape(e.message || '')}</div>`;
      })
      .join('');
  }
}

function escape(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

$('test').addEventListener('click', async () => {
  $('detail').textContent = 'sending test…';
  const r = await chrome.runtime.sendMessage({ type: 'test-push' });
  if (r && r.ok) $('detail').textContent = 'test push ok';
  else $('detail').textContent = 'test failed: ' + (r && r.error || 'unknown');
  setTimeout(refresh, 400);
});

refresh();
setInterval(refresh, 2000);
