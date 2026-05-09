// Runs in the isolated world. Two jobs:
//   1. Inject inject.js into the page's main world before any page script runs.
//   2. Forward CustomEvents from inject.js to the service worker.

(() => {
  const EVENT_TYPES = ['ready', 'heartbeat', 'capture', 'parse-error', 'tamper', 'diagnostic'];

  // Inject as the very first <script> the page sees.
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).prepend(s);
  } catch (e) {
    console.error('[mnemo] failed to inject', e);
  }

  function forward(type) {
    window.addEventListener('mnemo:' + type, (ev) => {
      try {
        chrome.runtime.sendMessage({
          type,
          detail: ev.detail,
          tabUrl: location.href,
          tabHost: location.hostname,
        });
      } catch (_) {
        // Service worker may be torn down; messages will resume next event.
      }
    });
  }

  for (const t of EVENT_TYPES) forward(t);
})();
