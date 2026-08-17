// Extension-host side of the VPython renderer.
//
// The renderer runs in the notebook output webview and can only dial
// 127.0.0.1 — fine when the kernel is local, wrong when it runs in a
// Codespace / Remote-SSH / WSL remote. Only the extension host can bridge
// that gap: vscode.env.asExternalUri() both CREATES the port forward (if
// one doesn't exist) and returns the URI the client can actually reach —
// plain localhost for desktop remotes, an authenticated
// https://...app.github.dev URL for browser Codespaces.
//
// Protocol:  renderer -> host   { type: 'mapPort', port }
//            host -> renderer   { type: 'portMapped', port, externalUri }
// externalUri is null when mapping failed; the renderer then keeps its
// 127.0.0.1 fallback. The renderer re-asks on every connect retry until
// answered, so a message sent before this extension activates is lost
// harmlessly.

const vscode = require('vscode');

function activate(_context) {
  const messaging = vscode.notebooks.createRendererMessaging('vpython-renderer');
  messaging.onDidReceiveMessage(async (e) => {
    const msg = e.message;
    if (!msg || msg.type !== 'mapPort' || !msg.port) { return; }
    let externalUri = null;
    let error = null;
    try {
      const external = await vscode.env.asExternalUri(
        vscode.Uri.parse('http://127.0.0.1:' + msg.port + '/'));
      externalUri = external.toString();
    } catch (err) {
      error = String(err);
    }
    messaging.postMessage(
      { type: 'portMapped', port: msg.port, externalUri: externalUri, error: error },
      e.editor);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
