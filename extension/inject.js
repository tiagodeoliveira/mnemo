// Runs in the page's main world. Monkey-patches window.fetch to observe
// conversation API calls on claude.ai and chatgpt.com, parses their SSE
// response streams, and emits CustomEvents the isolated-world content script
// forwards to the service worker.
//
// Key constraints:
//   - Must run before the site's bundle captures a private reference to fetch.
//     The manifest sets run_at=document_start; this file is injected as the
//     very first <script> the content script appends.
//   - Must not throw or alter response semantics. We tee() the body so the
//     site sees an untouched stream.
//   - Must self-detect tampering: if our patched fetch is later replaced,
//     we re-patch and emit a 'tamper' event so the service worker can warn.

(() => {
  if (window.__mnemoInjected) return;
  window.__mnemoInjected = true;

  const NATIVE_FETCH = window.fetch.bind(window);
  const NATIVE_FETCH_STR = Function.prototype.toString.call(window.fetch);

  const SITE = (() => {
    const h = location.hostname;
    if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude.ai';
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt.com';
    return null;
  })();

  const LOG = (...a) => console.log('[mnemo]', ...a);
  const WARN = (...a) => console.warn('[mnemo]', ...a);

  function emit(type, detail) {
    try {
      window.dispatchEvent(new CustomEvent('mnemo:' + type, { detail }));
    } catch (_) {}
  }

  // Fire a heartbeat so the service worker knows the page is alive and patched.
  LOG('inject.js installed on', SITE, location.href);
  emit('ready', { site: SITE, href: location.href });
  setInterval(() => emit('heartbeat', { site: SITE, href: location.href }), 30_000);

  // ---- Site adapters ------------------------------------------------------

  function isTargetUrl(url) {
    if (!SITE) return null;
    try {
      const u = new URL(url, location.href);
      if (SITE === 'claude.ai') {
        // POST /api/organizations/{org}/chat_conversations/{conv}/completion
        const m = u.pathname.match(
          /^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion\/?$/
        );
        if (m) return { kind: 'claude-completion', conversationId: m[1] };
      } else if (SITE === 'chatgpt.com') {
        // POST /backend-api/conversation; conversation_id is in the request body, not the URL.
        if (u.pathname === '/backend-api/conversation' || u.pathname === '/backend-api/f/conversation') {
          return { kind: 'chatgpt-conversation', conversationId: null };
        }
      }
    } catch (_) {}
    return null;
  }

  function extractUserMessage(target, requestBody) {
    if (!requestBody) return null;
    let parsed;
    try {
      parsed = typeof requestBody === 'string' ? JSON.parse(requestBody) : null;
    } catch {
      return null;
    }
    if (!parsed) return null;

    if (target.kind === 'claude-completion') {
      // claude.ai sends { prompt: "...", ... }
      if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) return parsed.prompt;
      return null;
    }
    if (target.kind === 'chatgpt-conversation') {
      // chatgpt.com sends { messages: [...], conversation_id: "uuid"|null, ... }
      // Mutate the target so the caller can use it as sessionId.
      if (typeof parsed.conversation_id === 'string' && parsed.conversation_id) {
        target.conversationId = parsed.conversation_id;
      }
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const role = m && m.author && m.author.role;
        if (role !== 'user') continue;
        const parts = m.content && Array.isArray(m.content.parts) ? m.content.parts : [];
        const text = parts
          .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
          .join('\n')
          .trim();
        if (text) return text;
      }
      return null;
    }
    return null;
  }

  // SSE parser: splits a string buffer on blank-line event boundaries and
  // yields the concatenated `data:` payload of each event.
  function makeSseAccumulator(onData) {
    let buf = '';
    return {
      push(chunk) {
        buf += chunk;
        let idx, sep;
        while (true) {
          const rn = buf.indexOf('\r\n\r\n');
          const nn = buf.indexOf('\n\n');
          if (rn === -1 && nn === -1) break;
          if (rn !== -1 && (nn === -1 || rn <= nn)) { idx = rn; sep = 4; }
          else                                       { idx = nn; sep = 2; }
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + sep);
          const lines = raw.split(/\r?\n/);
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length) onData(dataLines.join('\n'));
        }
      },
      flush() {
        if (buf.trim()) {
          const lines = buf.split(/\r?\n/);
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length) onData(dataLines.join('\n'));
        }
        buf = '';
      },
    };
  }

  function makeAssistantAccumulator(target) {
    let text = '';
    let saw = false;

    function handle(dataStr) {
      if (dataStr === '[DONE]') return;
      let evt;
      try { evt = JSON.parse(dataStr); } catch { return; }

      if (target.kind === 'claude-completion') {
        // Events look like { type: "completion", completion: "..." } or
        // { type: "content_block_delta", delta: { text: "..." } }
        if (typeof evt.completion === 'string') {
          text += evt.completion;
          saw = true;
        } else if (evt.delta && typeof evt.delta.text === 'string') {
          text += evt.delta.text;
          saw = true;
        }
      } else if (target.kind === 'chatgpt-conversation') {
        // Newer chatgpt SSE uses { v: "...", p: "/message/content/parts/0", o: "append" }
        // patches plus full-snapshot events with { message: { author: { role: "assistant" }, content: { parts: [...] } } }.
        if (evt.message && evt.message.author && evt.message.author.role === 'assistant') {
          const parts = evt.message.content && Array.isArray(evt.message.content.parts)
            ? evt.message.content.parts
            : [];
          const snapshot = parts
            .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
            .join('\n');
          if (snapshot.length >= text.length) {
            text = snapshot;
            saw = true;
          }
        } else if (typeof evt.v === 'string' && (!evt.p || evt.p === '' || evt.p.includes('/parts/'))) {
          // Append-style delta
          if (evt.o === 'append' || evt.o == null) {
            text += evt.v;
            saw = true;
          }
        }
      }
    }

    return {
      push(dataStr) { handle(dataStr); },
      result() { return { text: text.trim(), parsed: saw }; },
    };
  }

  // ---- Fetch patch --------------------------------------------------------

  async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const method = (init && init.method) || (input && input.method) || 'GET';
    const target = url ? isTargetUrl(url) : null;

    if (!target || method.toUpperCase() !== 'POST') {
      return NATIVE_FETCH(input, init);
    }

    // Capture request body BEFORE sending (init.body may be a stream consumable once)
    let requestBody = null;
    try {
      if (init && typeof init.body === 'string') {
        requestBody = init.body;
      } else if (init && init.body) {
        // Best-effort: try to read other body types
        try { requestBody = await new Response(init.body).clone().text(); } catch (_) {}
      } else if (input && typeof input.clone === 'function') {
        try { requestBody = await input.clone().text(); } catch (_) {}
      }
    } catch (_) {}

    let response;
    try {
      response = await NATIVE_FETCH(input, init);
    } catch (e) {
      throw e;
    }

    // Only intercept successful streamed responses
    if (!response.ok || !response.body) return response;

    const userMessage = extractUserMessage(target, requestBody);
    const sse = makeSseAccumulator((data) => assistant.push(data));
    const assistant = makeAssistantAccumulator(target);

    const [a, b] = response.body.tee();

    // Read one branch in the background; site gets the other untouched.
    (async () => {
      const reader = a.getReader();
      const decoder = new TextDecoder('utf-8');
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) sse.push(decoder.decode(value, { stream: true }));
        }
        sse.flush();
        const { text, parsed } = assistant.result();
        if (parsed && (userMessage || text)) {
          LOG('captured', target.kind, 'conv=', target.conversationId,
              'user=', (userMessage || '').length, 'chars',
              'assistant=', text.length, 'chars');
          emit('capture', {
            site: SITE,
            kind: target.kind,
            conversationId: target.conversationId || null,
            url: location.href,
            userMessage: userMessage || '',
            assistantMessage: text,
            capturedAt: new Date().toISOString(),
          });
        } else {
          WARN('parse-error: target hit but no turns extracted', target.kind, url);
          // We saw a target API call but couldn't extract a turn pair.
          // Surfaced as "interception broken" health signal.
          emit('parse-error', {
            site: SITE,
            kind: target.kind,
            url: url,
            hadUserMessage: !!userMessage,
            hadAssistantMessage: !!text,
          });
        }
      } catch (err) {
        emit('parse-error', {
          site: SITE,
          kind: target.kind,
          url: url,
          error: String(err && err.message || err),
        });
      }
    })();

    return new Response(b, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  Object.defineProperty(window, 'fetch', {
    configurable: true,
    writable: true,
    value: patchedFetch,
  });

  // Tamper detection: if something replaces window.fetch, re-patch and warn.
  setInterval(() => {
    if (window.fetch !== patchedFetch) {
      WARN('window.fetch was replaced — re-patching');
      emit('tamper', { site: SITE, fetchToString: String(window.fetch).slice(0, 200) });
      try {
        Object.defineProperty(window, 'fetch', {
          configurable: true,
          writable: true,
          value: patchedFetch,
        });
      } catch (_) {}
    }
  }, 5_000);

  // Sanity check: confirm we held a reference to native fetch (used in popup diagnostics).
  emit('diagnostic', {
    site: SITE,
    nativeFetchLooksNative: /\[native code\]/.test(NATIVE_FETCH_STR),
  });
})();
