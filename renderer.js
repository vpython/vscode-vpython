// VPython notebook renderer for VS Code.
//
// The kernel side (vpython-jupyter's with_wsfrontend, auto-selected under
// VS Code) serves the whole VPython wire protocol on a tornado websocket
// inside the kernel process and announces it with this MIME output:
//
//   application/vnd.vpython.v1+json   { api: 1, port: N, wsuri: '/ws' }
//
// This renderer loads GlowScript (jquery + glow.min) into the output
// webview, connects to that websocket, and drives glowcomm_host.js —
// vpython-jupyter's host-agnostic protocol frontend — with:
//   downlink:  ws message -> fe.handle('trigger' | parsed package)
//   uplink:    33 ms pacer -> fe.tick() -> send(events) -> ws
//
// Webview rules learned the hard way (see the vscode-vpython-spike repo):
// never assign innerHTML (Trusted Types kills the render silently); build
// DOM with createElement/textContent; render every failure INTO the element.

const TICK_MS = 33; // matches classic glowcomm.js pacing

// ---- one-time GlowScript loading (shared by all outputs in this webview) --

let glowReady = null;

function loadScript(name) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./media/' + name, import.meta.url).toString();
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + name));
    document.head.appendChild(s);
  });
}

function loadCss(name) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./media/' + name, import.meta.url).toString();
  document.head.appendChild(link);
}

// If the webview exposes an AMD loader, UMD scripts register as modules
// instead of patching globals — jQuery core still sets window.$ either way,
// but jQuery UI then NEVER extends $.fn (no .resizable, which glow's canvas
// activation needs). Hide `define` while our classic scripts execute.
function suppressAmd() {
  const had = Object.prototype.hasOwnProperty.call(self, 'define');
  const saved = self.define;
  try { self.define = undefined; } catch (e) { /* frozen? proceed anyway */ }
  return () => {
    if (had) { self.define = saved; }
    else { try { delete self.define; } catch (e) { /* best effort */ } }
  };
}

function ensureGlow() {
  if (!glowReady) {
    // Order matters: glow expects jQuery AND jQuery UI (canvas activation
    // calls $(wrapper).resizable()); glowcomm_host expects glow's
    // constructors (and finds jQuery through the same globals).
    loadCss('jquery-ui.custom.css');
    const restoreAmd = suppressAmd();
    glowReady = loadScript('jquery.min.js')
      .then(() => loadScript('jquery-ui.custom.min.js'))
      .then(() => loadScript('glow.min.js'))
      .then(() => {
        // glow.min reads this global as the URL prefix for textures
        // (textures.earth et al) — must end with '/'.
        self.Jupyter_VPython = new URL('./media/data/', import.meta.url).toString();
        // Fonts for text(): glow bundles opentype.js and exposes
        // opentype_load; glow's text machinery reads __font_sans/__font_serif.
        const loadFont = (file, slot) => new Promise((resolve, reject) => {
          self.opentype_load(self.Jupyter_VPython + file, (err, font) => {
            if (err) { reject(new Error('font ' + file + ': ' + err)); return; }
            self[slot] = font;
            resolve();
          });
        });
        return Promise.all([
          loadFont('Roboto-Medium.ttf', '__font_sans'),
          loadFont('NimbusRomNo9L-Med.otf', '__font_serif')
        ]);
      })
      .then(() => loadScript('glowcomm_host.js'))
      .then(() => {
        restoreAmd();
        const jq = self.$ || self.jQuery;
        if (!jq || !jq.fn || typeof jq.fn.resizable !== 'function') {
          throw new Error('jQuery UI did not attach ($.fn.resizable missing) — ' +
            'AMD/UMD interference in this webview');
        }
        if (typeof self.createGlowFrontend !== 'function') {
          throw new Error('glowcomm_host.js loaded but createGlowFrontend missing');
        }
      })
      .catch((e) => { restoreAmd(); throw e; });
  }
  return glowReady;
}

// ---- per-output scene state ----------------------------------------------

const scenes = new Map(); // outputId -> scene state (see renderOutputItem)

function disposeScene(outputId) {
  const s = scenes.get(outputId);
  if (!s) { return; }
  scenes.delete(outputId);
  s.disposed = true;
  if (s.retryTimer) { clearTimeout(s.retryTimer); }
  if (s.attemptTimer) { clearTimeout(s.attemptTimer); }
  if (s.pacer) { clearInterval(s.pacer); }
  if (s.transport) { s.transport.close(); }
  if (s.fe) { try { s.fe.destroy(); } catch (e) { /* scene half-built */ } }
}

export function activate(context) {
  // Remote kernels (Codespace / Remote-SSH / WSL): 127.0.0.1 is the wrong
  // machine. The extension host maps the announced port with asExternalUri
  // (which also CREATES the forward) and answers with the reachable URI.
  // Until an answer arrives — messaging may be unavailable, and a request
  // can race extension activation — the direct localhost URL is used, which
  // is correct for local kernels. Requests are re-sent from the connect
  // retry loop, so a lost message heals itself.
  const mappedPorts = new Map(); // port -> external URI string
  const canMessage = typeof context.postMessage === 'function';

  // ws bridge (preferred transport): the extension host dials the kernel's
  // websocket at ITS 127.0.0.1 — the kernel's own machine in every setup —
  // and relays frames over renderer messaging. 'unavailable' (no WebSocket
  // client in the host's Node) is permanent for the session; silence just
  // means the host isn't activated (yet) and the caller times out.
  let bridgeBroken = false;       // host answered 'ws.unavailable'
  const bridgeConns = new Map();  // id -> {onopen, onmessage, onclose}
  let bridgeSeq = 0;

  if (canMessage && typeof context.onDidReceiveMessage === 'function') {
    context.onDidReceiveMessage((msg) => {
      if (!msg) { return; }
      if (msg.type === 'portMapped' && msg.externalUri) {
        mappedPorts.set(msg.port, msg.externalUri);
        return;
      }
      const conn = msg.id !== undefined && bridgeConns.get(msg.id);
      if (!conn) { return; }
      if (msg.type === 'ws.opened') { conn.onopen(); }
      else if (msg.type === 'ws.message') { conn.onmessage(msg.data); }
      else if (msg.type === 'ws.closed' || msg.type === 'ws.error') {
        bridgeConns.delete(msg.id);
        conn.onclose();
      } else if (msg.type === 'ws.unavailable') {
        bridgeBroken = true;
        bridgeConns.delete(msg.id);
        conn.onclose();
      }
    });
  }
  const requestPortMap = (port) => {
    if (canMessage && !mappedPorts.has(port)) {
      context.postMessage({ type: 'mapPort', port: port });
    }
  };

  // Both transports present the same shape: {send, close}, with the
  // caller's handlers {onopen, onmessage(str), onclose} driven by events.
  // id must be unique across webviews too — the host keys sockets by it.
  const bridgeTag = Math.random().toString(36).slice(2, 10);
  const openBridgeTransport = (info, handlers) => {
    const id = 'vp-' + bridgeTag + '-' + (++bridgeSeq);
    bridgeConns.set(id, handlers);
    context.postMessage({ type: 'ws.open', id: id, port: info.port,
                          path: info.wsuri || '/ws' });
    return {
      send: (data) => context.postMessage({ type: 'ws.send', id: id, data: data }),
      close: () => {
        bridgeConns.delete(id);
        context.postMessage({ type: 'ws.close', id: id });
      },
    };
  };
  const openDirectTransport = (url, handlers) => {
    const ws = new WebSocket(url);
    ws.onopen = () => handlers.onopen();
    ws.onmessage = (ev) => handlers.onmessage(ev.data);
    ws.onclose = () => handlers.onclose();
    ws.onerror = () => { /* onclose always follows */ };
    return {
      send: (data) => { if (ws.readyState === WebSocket.OPEN) { ws.send(data); } },
      close: () => { try { ws.close(); } catch (e) { /* already closed */ } },
    };
  };
  const wsUrlFor = (info) => {
    const path = info.wsuri || '/ws';
    const ext = mappedPorts.get(info.port);
    if (ext) {
      // http(s)://host[:port]/ -> ws(s)://host[:port] + path
      return ext.replace(/^http/, 'ws').replace(/\/+$/, '') + path;
    }
    return 'ws://127.0.0.1:' + info.port + path;
  };

  return {
    renderOutputItem(outputItem, element) {
      const outputId = outputItem.id;
      disposeScene(outputId); // re-render of the same output starts fresh

      const status = document.createElement('div');
      status.style.cssText = 'font-family: var(--vscode-editor-font-family, monospace);' +
        'font-size: 12px; opacity: 0.8;';
      const container = document.createElement('div');
      element.appendChild(status);
      element.appendChild(container);

      const fail = (text) => {
        const line = document.createElement('pre');
        line.textContent = 'VPython renderer: ' + text;
        line.style.cssText = 'color: #c00; white-space: pre-wrap;';
        element.appendChild(line);
      };

      let info;
      try {
        info = outputItem.json();
      } catch (e) {
        fail('bad payload: ' + e);
        return;
      }
      if (!info || info.api !== 1 || !info.port) {
        fail('unsupported payload ' + JSON.stringify(info) +
             ' (renderer speaks api 1)');
        return;
      }

      status.textContent = 'VPython: loading GlowScript…';

      ensureGlow().then(() => {
        // Transport preference: the extension-host ws BRIDGE (works in
        // every setup — the host dials the kernel's own 127.0.0.1, no port
        // forward or tunnel auth), then a DIRECT websocket (mapped through
        // asExternalUri when the host answered, plain localhost otherwise).
        // The renderer RETRIES on a fixed cadence: the extension host can
        // activate after this output renders, forwards can come up late,
        // and connections can drop. Reconnecting is always safe — the
        // kernel replays the whole scene on every attach.
        const state = { transport: null, fe: null, pacer: null, container,
                        retryTimer: null, attemptTimer: null, disposed: false };
        scenes.set(outputId, state);

        const RETRY_MS = 2000;
        const ATTEMPT_MS = 8000;   // a hung handshake must not stall the loop
        const BRIDGE_WAIT_MS = 1500; // silent host (not activated yet)
        const GIVE_UP_MS = 5 * 60 * 1000;
        let everConnected = false;
        let windowStart = Date.now(); // resets on every successful open
        let lastTried = 'kernel port ' + info.port;

        const opened = (transport) => {
          everConnected = true;
          windowStart = Date.now();
          state.transport = transport;
          if (!state.fe) {
            state.fe = self.createGlowFrontend({
              container: container,
              glow: self,
              send: (events) => {
                if (state.transport) { state.transport.send(JSON.stringify(events)); }
              }
            });
          }
          if (!state.pacer) {
            state.pacer = setInterval(() => state.fe.tick(), TICK_MS);
          }
          status.textContent = '';
        };

        const onmessage = (data) => {
          if (!state.fe) { return; }
          try {
            state.fe.handle(data === 'trigger' ? 'trigger' : JSON.parse(data));
          } catch (e) {
            fail('protocol error: ' + ((e && e.stack) || e));
          }
        };

        const clearAttempt = () => {
          if (state.attemptTimer) { clearTimeout(state.attemptTimer); state.attemptTimer = null; }
        };

        const dropped = () => {
          if (state.disposed) { return; }
          clearAttempt();
          state.transport = null;
          if (state.pacer) { clearInterval(state.pacer); state.pacer = null; }
          if (state.fe) { state.fe.pacingStopped(); }
          if (Date.now() - windowStart > GIVE_UP_MS) {
            status.textContent = '';
            fail(everConnected
              ? 'kernel connection lost (' + lastTried + ') — re-run the ' +
                'cell to start a new scene.'
              : 'could not reach the kernel (' + lastTried + ') after ' +
                (GIVE_UP_MS / 60000) + ' minutes — is the kernel running? ' +
                'For a remote kernel (Codespace/SSH), make sure the VPython ' +
                'extension is installed on the remote ("Install in ' +
                'Codespace" in the Extensions view).');
            return;
          }
          status.textContent = 'VPython: waiting for the kernel (' +
            lastTried + ') — retrying every ' + (RETRY_MS / 1000) + ' s …';
          state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            connect();
          }, RETRY_MS);
        };

        // One attempt on one transport; times out into onfail rather than
        // hanging (observed: a tunnel can hold a handshake open forever).
        const attempt = (openTransport, waitMs, onfail) => {
          let settled = false;
          const transport = openTransport({
            onopen: () => {
              if (settled || state.disposed) { return; }
              settled = true;
              clearAttempt();
              opened(transport);
            },
            onmessage: onmessage,
            onclose: () => {
              if (settled) { dropped(); return; }
              settled = true;
              clearAttempt();
              onfail();
            },
          });
          state.attemptTimer = setTimeout(() => {
            state.attemptTimer = null;
            if (settled || state.disposed) { return; }
            settled = true;
            transport.close();
            onfail();
          }, waitMs);
        };

        const tryDirect = () => {
          if (state.disposed) { return; }
          const url = wsUrlFor(info);
          lastTried = url;
          status.textContent = 'VPython: connecting ' + url + ' …';
          attempt((h) => openDirectTransport(url, h), ATTEMPT_MS, dropped);
        };

        const connect = () => {
          if (state.disposed) { return; }
          requestPortMap(info.port); // keeps the direct fallback viable
          if (canMessage && !bridgeBroken) {
            lastTried = 'extension-host bridge to kernel port ' + info.port;
            status.textContent = 'VPython: connecting via ' + lastTried + ' …';
            attempt((h) => openBridgeTransport(info, h), BRIDGE_WAIT_MS, tryDirect);
          } else {
            tryDirect();
          }
        };
        connect();
      }).catch((e) => fail((e && e.stack) || String(e)));
    },

    disposeOutputItem(outputId) {
      if (outputId === undefined) {
        // whole webview reset
        for (const id of Array.from(scenes.keys())) { disposeScene(id); }
      } else {
        disposeScene(outputId);
      }
    }
  };
}
