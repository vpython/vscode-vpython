// Extension-host side of the VPython renderer.
//
// The renderer runs in the notebook output webview — in remote setups
// (Codespace / Remote-SSH / WSL) its 127.0.0.1 is the WRONG machine, and
// GitHub's forwarded-port auth (cookies) doesn't reach cross-origin
// websockets from a sandboxed iframe. This extension host runs WHERE THE
// KERNEL RUNS, so it provides two services over renderer messaging:
//
// 1. WS BRIDGE (preferred): the whole VPython wire protocol relayed
//    between the renderer (postMessage) and the kernel's tornado websocket
//    (dialed at 127.0.0.1 — local to the kernel by construction). No port
//    forward, no visibility, no tunnel auth.
//      renderer -> host: {type:'ws.open', id, port, path}
//                        {type:'ws.send', id, data}
//                        {type:'ws.close', id}
//      host -> renderer: {type:'ws.opened'|'ws.message'|'ws.closed'
//                         |'ws.error'|'ws.unavailable', id, ...}
//    'ws.unavailable' means this VS Code's Node has no WebSocket client
//    (pre-Node-22 runtime): the renderer then uses the mapPort path.
//
// 2. PORT MAPPING (fallback): asExternalUri both CREATES a forward and
//    returns the client-reachable URI for a direct connection.
//      renderer -> host: {type:'mapPort', port}
//      host -> renderer: {type:'portMapped', port, externalUri|null}
//
// The renderer re-asks on every connect retry until answered, so messages
// sent before this extension activates are lost harmlessly.

const vscode = require('vscode');

function activate(_context) {
  const messaging = vscode.notebooks.createRendererMessaging('vpython-renderer');
  const sockets = new Map(); // bridge id -> WebSocket

  messaging.onDidReceiveMessage(async (e) => {
    const msg = e.message;
    if (!msg || typeof msg.type !== 'string') { return; }
    const post = (m) => { messaging.postMessage(m, e.editor); };

    if (msg.type === 'mapPort' && msg.port) {
      let externalUri = null;
      let error = null;
      try {
        const external = await vscode.env.asExternalUri(
          vscode.Uri.parse('http://127.0.0.1:' + msg.port + '/'));
        externalUri = external.toString();
      } catch (err) {
        error = String(err);
      }
      post({ type: 'portMapped', port: msg.port, externalUri: externalUri,
             error: error });

    } else if (msg.type === 'ws.open' && msg.id && msg.port) {
      if (typeof globalThis.WebSocket !== 'function') {
        post({ type: 'ws.unavailable', id: msg.id });
        return;
      }
      const stale = sockets.get(msg.id);
      if (stale) { try { stale.close(); } catch (err) { /* already dead */ } }
      let ws;
      try {
        ws = new globalThis.WebSocket(
          'ws://127.0.0.1:' + msg.port + (msg.path || '/ws'));
      } catch (err) {
        post({ type: 'ws.error', id: msg.id, error: String(err) });
        return;
      }
      sockets.set(msg.id, ws);
      ws.onopen = () => post({ type: 'ws.opened', id: msg.id });
      ws.onmessage = (ev) => post({
        type: 'ws.message', id: msg.id,
        data: typeof ev.data === 'string' ? ev.data : String(ev.data),
      });
      ws.onclose = () => {
        sockets.delete(msg.id);
        post({ type: 'ws.closed', id: msg.id });
      };
      ws.onerror = () => { /* onclose always follows */ };

    } else if (msg.type === 'ws.send' && msg.id) {
      const ws = sockets.get(msg.id);
      if (ws && ws.readyState === 1) { ws.send(msg.data); }

    } else if (msg.type === 'ws.close' && msg.id) {
      const ws = sockets.get(msg.id);
      if (ws) {
        sockets.delete(msg.id);
        try { ws.close(); } catch (err) { /* already dead */ }
      }
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
