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

const scenes = new Map(); // outputId -> { ws, fe, pacer, container, retryTimer, disposed }

function disposeScene(outputId) {
  const s = scenes.get(outputId);
  if (!s) { return; }
  scenes.delete(outputId);
  s.disposed = true;
  if (s.retryTimer) { clearTimeout(s.retryTimer); }
  if (s.pacer) { clearInterval(s.pacer); }
  if (s.ws) { try { s.ws.close(); } catch (e) { /* already closed */ } }
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
  if (canMessage && typeof context.onDidReceiveMessage === 'function') {
    context.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'portMapped' && msg.externalUri) {
        mappedPorts.set(msg.port, msg.externalUri);
      }
    });
  }
  const requestPortMap = (port) => {
    if (canMessage && !mappedPorts.has(port)) {
      context.postMessage({ type: 'mapPort', port: port });
    }
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
        // The renderer RETRIES instead of failing on the first attempt: the
        // extension host's port mapping (asExternalUri) can answer after
        // this output renders, a forward can come up late, and an
        // established tunnel can drop and return. Reconnecting is always
        // safe — the kernel replays the whole scene on every attach. The
        // ws URL is recomputed per attempt so an arriving mapping switches
        // the very next try.
        const state = { ws: null, fe: null, pacer: null, container,
                        retryTimer: null, disposed: false };
        scenes.set(outputId, state);

        const RETRY_MS = 2000;
        const GIVE_UP_MS = 5 * 60 * 1000;
        const forwardHint = 'for a remote kernel (Codespace/SSH), forward ' +
          'port ' + info.port + ' in the Ports view';
        let everConnected = false;
        let windowStart = Date.now(); // resets on every successful open
        let url = wsUrlFor(info);

        const connect = () => {
          if (state.disposed) { return; }
          requestPortMap(info.port);
          url = wsUrlFor(info);
          status.textContent = 'VPython: connecting ' + url + ' …';
          const ws = new WebSocket(url);
          state.ws = ws;

          ws.onopen = () => {
            everConnected = true;
            windowStart = Date.now();
            if (!state.fe) {
              state.fe = self.createGlowFrontend({
                container: container,
                glow: self,
                send: (events) => {
                  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify(events));
                  }
                }
              });
            }
            if (!state.pacer) {
              state.pacer = setInterval(() => state.fe.tick(), TICK_MS);
            }
            status.textContent = '';
          };

          ws.onmessage = (ev) => {
            if (!state.fe) { return; }
            try {
              state.fe.handle(ev.data === 'trigger' ? 'trigger' : JSON.parse(ev.data));
            } catch (e) {
              fail('protocol error: ' + ((e && e.stack) || e));
            }
          };

          // onerror is always followed by onclose; retry logic lives there.
          ws.onerror = () => {};

          ws.onclose = () => {
            if (state.disposed) { return; }
            if (state.pacer) { clearInterval(state.pacer); state.pacer = null; }
            if (state.fe) { state.fe.pacingStopped(); }
            if (Date.now() - windowStart > GIVE_UP_MS) {
              status.textContent = '';
              fail(everConnected
                ? 'kernel connection lost at ' + url +
                  ' (re-run the cell to start a new scene).'
                : 'could not reach the kernel websocket at ' + url +
                  ' after ' + (GIVE_UP_MS / 60000) + ' minutes — is the ' +
                  'kernel running? (' + forwardHint + ')');
              return;
            }
            status.textContent = 'VPython: waiting for ' + url +
              ' — retrying every ' + (RETRY_MS / 1000) + ' s (' +
              forwardHint + ')';
            state.retryTimer = setTimeout(() => {
              state.retryTimer = null;
              connect();
            }, RETRY_MS);
          };
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
