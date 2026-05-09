# mnemo capture (Chrome extension)

Captures conversations on **claude.ai** and **chatgpt.com** by intercepting the
sites' SSE network responses, then pushes turns to mnemo's `/events` API.

## How it works

```
page (main world)              isolated world           service worker
  inject.js                       content.js              background.js
  ──────────                      ──────────              ────────────
  patches window.fetch ──events──► forwards via ──msg──►  POST /events
  tee()s SSE response                                     update badge color
  parses turns                                            track health state
```

- `inject.js` runs at `document_start` and replaces `window.fetch` before the
  page's bundle can capture a private reference. Matching requests
  (`POST /api/organizations/.../completion` for claude.ai,
  `POST /backend-api/conversation` for chatgpt.com) have their response stream
  `tee()`d so the page sees an untouched copy while we parse SSE events.
- `content.js` bridges page CustomEvents to the service worker.
- `background.js` pushes to mnemo and reflects health in the toolbar icon —
  the badge dot is drawn at runtime via `OffscreenCanvas`, so there are no PNG
  assets to ship.

## Health signals

The toolbar icon changes color based on what the extension is observing:

| Color  | Meaning                                                            |
|--------|--------------------------------------------------------------------|
| green  | Recent successful capture (last 10 minutes)                        |
| blue   | Configured and idle                                                |
| yellow | On a target site but no captures recently — possible miss          |
| red    | Tamper detected, push to mnemo failed, or API call returned no parseable turns (likely site format change) |
| gray   | API URL or key not set, or capture disabled                        |

The popup shows the last capture time, recent log entries, and a "Test push"
button that round-trips a synthetic event through `/events`.

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode → Load unpacked → pick this
   `extension/` directory.
2. Open the extension's Options page and fill in:
   - **API base URL** — e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/v1`
   - **API key** — the same `x-api-key` value the CLI uses
   - **Workstation** — defaults to `chrome-extension`
3. Click **Test push** to verify the API key works.
4. Open a chat on claude.ai or chatgpt.com and send a message. The popup should
   show a green dot and a log entry within a second of the assistant
   finishing its reply.

## Things that can break

- **Site changes its API path** — interception silently misses turns. The
  yellow "on-site but no captures yet" state will surface this once you've
  spent a few minutes on the page without a capture.
- **Site changes its SSE event shape** — interception fires but parses
  nothing, triggering the red "API call seen but no turns parsed" state.
  Inspect `inject.js` `makeAssistantAccumulator` and the request-body
  extractor.
- **Site captures `window.fetch` before our patch runs** — the tamper detector
  re-patches every 5s and logs a warning, but turns sent in the gap are lost.
- **Service worker restart** — health state is persisted to
  `chrome.storage.session`, so popup stays accurate across SW shutdowns within
  a browser session.

## Files

| File             | Role                                                       |
|------------------|------------------------------------------------------------|
| `manifest.json`  | MV3 manifest, host permissions, content script registration|
| `inject.js`      | Main-world `fetch` patch, SSE parser, per-site adapters    |
| `content.js`     | Isolated-world bridge; injects `inject.js` into the page   |
| `background.js`  | Service worker: API push, health state, badge rendering    |
| `options.html/js`| Configure API URL, key, workstation                        |
| `popup.html/js`  | Live status + recent activity log                          |
