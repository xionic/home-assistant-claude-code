/*
 * The connected browsers, and the two ways to talk to them.
 *
 * Events go to every client rather than to the socket that asked, because a run
 * belongs to the app, not to one tab: a second tab, or the same phone after a
 * reconnect, should see the same conversation unfold.
 */
export const connections = new Set();

export function send(ws, data) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

export function broadcast(msg) {
  for (const ws of connections) send(ws, msg);
}
