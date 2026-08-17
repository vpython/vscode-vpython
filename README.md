# VPython for VS Code notebooks

Renders VPython 3D scenes in VS Code's notebook UI — local kernels and
remote ones (GitHub Codespaces in desktop **and browser** VS Code,
Remote-SSH, WSL). Companion to vpython-jupyter's websocket-only frontend
(`with_wsfrontend.py`, branch `feat/vscode-frontend`): under VS Code the
kernel skips the classic Comm/nbextension machinery, serves the whole
VPython wire protocol on a tornado websocket inside the kernel, and
announces it with an `application/vnd.vpython.v1+json` output. This
extension picks that up, loads GlowScript (bundled jquery + glow.min) in
the output webview, and drives `glowcomm_host.js` — the same host-agnostic
protocol frontend the trinket worker integration uses.

## Architecture

Two halves:

- **renderer** (`renderer.js`) — runs in the notebook output webview
  (always client-side, even for remote workspaces).
- **extension host** (`extension.js`) — runs where the kernel runs
  (a *workspace* extension: in a codespace it lives in the codespace).

The renderer's preferred transport is the **ws bridge**: it relays the wire
protocol over VS Code renderer messaging to the extension host, which dials
the kernel's tornado websocket at *its own* `127.0.0.1` — local by
construction in every setup. No port forwarding, no tunnel, no
port-visibility clicks, and it works identically for local kernels.

```
output webview (client)          extension host (kernel's machine)   kernel
────────────────────────         ─────────────────────────────────   ──────
renderer.js                      extension.js
  glowcomm_host frontend  ◄────► ws bridge relay ◄── ws 127.0.0.1 ──► tornado
  glow.min.js (GlowScript)  renderer messaging
```

Fallback (extension host absent or its Node lacks a WebSocket client): a
direct websocket from the webview, with the port mapped through
`vscode.env.asExternalUri` when possible. Connection attempts retry every
2 s (and time out — tunnels can hang a handshake), and the kernel replays
the whole scene journal on every attach, so late installs, webview
eviction, and dropped connections all self-heal.

- downlink: kernel `sender(package)` → bridge/ws → `fe.handle(package)`
- uplink: 33 ms pacer → `fe.tick()` → events (or `update_canvas` trigger) →
  bridge/ws → kernel `ws_queue` → `handle_msg` → `trigger()` flushes

## Try it — local

1. Kernel env: install the branch —
   `pip install "git+https://github.com/vpython/vpython-jupyter@feat/vscode-frontend"`
2. Install the extension: `code --install-extension vscode-vpython-<version>.vsix`,
   then **Developer: Reload Window**.
3. Open `test-workspace/vpython-demo.ipynb`, pick that kernel, run the cells.

## Try it — GitHub Codespace (zero config)

Open this repo in a codespace: the devcontainer preinstalls Python 3.12,
the vpython branch, and the Jupyter extensions. Install the extension
**into the codespace** (it's a workspace extension — a local install does
not serve remote windows):

```bash
code --install-extension /workspaces/vscode-vpython/vscode-vpython-<version>.vsix
```

(or headless: `~/.vscode-remote/bin/*/bin/code-server
--extensions-dir ~/.vscode-remote/extensions --install-extension <vsix>`),
Reload Window, then run `test-workspace/codespace-probe.ipynb`. Works in
desktop VS Code and in the browser. Once the extension is on the
Marketplace this step becomes a `customizations.vscode.extensions` line in
the devcontainer.

Env knobs (kernel side): `VPYTHON_FRONTEND=ws|jupyter` forces the frontend
choice; `VPYTHON_WS_PORT` pins the websocket port (the devcontainer pins
8765 — only the direct-transport fallback cares); `VPYTHON_CONNECT_TIMEOUT`
raises the import's frontend wait (default 30 s).

## Known gaps

- Widgets (button/slider/menu) and `scene.pause`/`waitfor`: same deferrals
  as the trinket worker integration — glowcomm_host warns and drops
- One scene container per MIME output; every `canvas()` renders into the
  import cell's output
- The bridge needs the extension host's Node to have a WebSocket client
  (VS Code with Node ≥ 22); older hosts fall back to the direct transport,
  which for a *browser* codespace additionally needs the forwarded port set
  Public (cookie auth doesn't reach cross-origin websockets from the
  sandboxed output iframe)

## Webview survival rules

Learned in the spike (../vscode-vpython-spike): never assign `innerHTML`
(Trusted Types rejects it and kills the render silently); build DOM with
`createElement`/`textContent`; render every failure into the output element
so nothing fails invisibly; ship a `text/plain` fallback beside the MIME.
