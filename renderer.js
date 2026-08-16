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

const scenes = new Map(); // outputId -> { ws, fe, pacer, container }

function disposeScene(outputId) {
  const s = scenes.get(outputId);
  if (!s) { return; }
  scenes.delete(outputId);
  if (s.pacer) { clearInterval(s.pacer); }
  if (s.ws) { try { s.ws.close(); } catch (e) { /* already closed */ } }
  if (s.fe) { try { s.fe.destroy(); } catch (e) { /* scene half-built */ } }
}

export function activate(_context) {
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
        // The kernel and this UI share a machine in v1; remote kernels need
        // extension-host port forwarding (asExternalUri) — future work.
        const url = 'ws://127.0.0.1:' + info.port + (info.wsuri || '/ws');
        status.textContent = 'VPython: connecting ' + url + ' …';

        const ws = new WebSocket(url);
        const state = { ws, fe: null, pacer: null, container };
        scenes.set(outputId, state);

        ws.onopen = () => {
          state.fe = self.createGlowFrontend({
            container: container,
            glow: self,
            send: (events) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(events));
              }
            }
          });
          state.pacer = setInterval(() => state.fe.tick(), TICK_MS);
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

        ws.onclose = () => {
          if (state.pacer) { clearInterval(state.pacer); state.pacer = null; }
          if (state.fe) { state.fe.pacingStopped(); }
          status.textContent = 'VPython: kernel connection closed ' +
            '(re-run the cell to start a new scene).';
        };

        ws.onerror = () => {
          if (ws.readyState !== WebSocket.OPEN) {
            fail('could not reach the kernel websocket at ' + url +
                 ' — is the kernel still running on this machine?');
          }
        };
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
