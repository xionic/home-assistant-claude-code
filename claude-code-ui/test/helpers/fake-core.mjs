/*
 * fake-core — a stand-in Home Assistant Core WebSocket API, just enough of it to
 * exercise the /diag guard: the auth handshake and `auth/current_user`.
 *
 * This is deliberately separate from fake-ha.mjs, which impersonates the
 * *Supervisor* (REST, journald) for the CLI tests. The guard in lib/ha-auth.js
 * talks to Core directly and only speaks WebSocket, so it needs its own fake —
 * and the point of the guard is that Core and the Supervisor are not
 * interchangeable, which a shared fake would quietly undermine.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * tokens — { '<token>': { isAdmin: true, name: 'Nick' } }. Anything not listed
 *          gets `auth_invalid`, exactly as Core does.
 * haVersion — reported in auth_required, purely cosmetic.
 */
export async function startFakeCore({ tokens = {}, haVersion = '2026.9.1' } = {}) {
  const connections = [];
  const http = createServer((_req, res) => { res.writeHead(404); res.end('not found'); });
  const wss = new WebSocketServer({ server: http, path: '/api/websocket' });

  wss.on('connection', (ws) => {
    let user = null;
    connections.push(ws);
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: haVersion }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth') {
        user = tokens[msg.access_token] || null;
        if (!user) {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token or password' }));
          return ws.close();
        }
        return ws.send(JSON.stringify({ type: 'auth_ok', ha_version: haVersion }));
      }

      if (msg.type === 'auth/current_user') {
        // Core refuses commands before auth; mirroring that keeps the fake honest.
        if (!user) {
          return ws.send(JSON.stringify({ id: msg.id, type: 'result', success: false,
            error: { code: 'unauthorized', message: 'not authenticated' } }));
        }
        return ws.send(JSON.stringify({
          id: msg.id, type: 'result', success: true,
          result: { id: 'user-id', name: user.name || 'Test User', is_admin: !!user.isAdmin, is_owner: false },
        }));
      }
    });
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();

  return {
    wsUrl: `ws://127.0.0.1:${port}/api/websocket`,
    httpUrl: `http://127.0.0.1:${port}`,
    async stop() {
      for (const ws of connections) { try { ws.terminate(); } catch { /* gone */ } }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
