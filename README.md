# VPython for VS Code notebooks

Renders VPython 3D scenes in VS Code's notebook UI. Companion to
vpython-jupyter's websocket-only frontend (`with_wsfrontend.py`, branch
`feat/vscode-frontend`): under VS Code the kernel skips the classic
Comm/nbextension machinery, serves the whole VPython wire protocol on a
tornado websocket inside the kernel, and announces it with an
`application/vnd.vpython.v1+json` output. This extension's renderer picks
that up, loads GlowScript (bundled jquery + glow.min), connects to the
websocket, and drives `glowcomm_host.js` — the same host-agnostic protocol
frontend the trinket worker integration uses.

## Architecture

```
kernel (python)                          VS Code output webview
─────────────────                        ──────────────────────
with_wsfrontend.py                       renderer.js
  tornado ws server  ◄──── ws ────►        glowcomm_host frontend
  WsSender (buffers)   duplex              glow.min.js (GlowScript)
  display(MIME{port})  ────────────►       (this is how the port arrives)
```

- downlink: kernel `sender(package)` → ws → `fe.handle(package)`
- uplink: 33 ms pacer → `fe.tick()` → events (or `update_canvas` trigger) →
  ws → kernel `ws_queue` → `handle_msg` → `trigger()` flushes updates
- v1 assumes kernel and UI share a machine (`127.0.0.1`); remote kernels
  need `asExternalUri` port forwarding via the extension host — future work.

## Try it

1. Kernel env: install the branch —
   `VPYTHON_PURE_PYTHON=1 pip install -e <vpython-jupyter checkout on feat/vscode-frontend>`
2. Install the extension vsix: `code --install-extension vscode-vpython-0.1.0.vsix`,
   then **Developer: Reload Window**.
3. Open `test-workspace/vpython-demo.ipynb`, pick that kernel, run the cells.

`VPYTHON_FRONTEND=ws` forces the websocket frontend outside VS Code;
`VPYTHON_FRONTEND=jupyter` forces classic behavior under VS Code.

## Known gaps (v1)

- Fonts for `text()` objects not bundled yet (glow loads them from the host)
- Widgets (button/slider/menu) and `scene.pause`/`waitfor`: same deferrals
  as the trinket worker integration — glowcomm_host warns and drops
- Remote/WSL/Codespaces kernels (port forwarding)
- One scene container per MIME output; every `canvas()` renders into the
  import cell's output

## Webview survival rules

Learned in the spike (../vscode-vpython-spike): never assign `innerHTML`
(Trusted Types rejects it and kills the render silently); build DOM with
`createElement`/`textContent`; render every failure into the output element
so nothing fails invisibly; ship a `text/plain` fallback beside the MIME.
