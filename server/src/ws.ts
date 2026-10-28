import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getUserById, verifyAccessToken } from './auth.js';
import { addConnection, allConnections, broadcastPresence, isConnected, removeConnection } from './hub.js';
import { handleVoiceFrame, leaveVoice } from './voice.js';

const HEARTBEAT_MS = 30_000;

export function attachGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/gateway' });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    const userId = token ? verifyAccessToken(token) : null;
    const user = userId ? getUserById(userId) : undefined;

    if (!user) {
      socket.close(4004, 'Unauthorized');
      return;
    }

    const conn = addConnection(randomUUID(), user.id, socket);
    socket.send(JSON.stringify({ t: 'READY', d: { userId: user.id, at: Date.now() } }));
    broadcastPresence(user.id, user.status);

    socket.on('pong', () => {
      conn.alive = true;
    });

    socket.on('message', (raw) => {
      let payload: { t?: string; d?: unknown } = {};
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (payload.t === 'PING') {
        socket.send(JSON.stringify({ t: 'PONG', d: { at: Date.now() } }));
        return;
      }
      handleVoiceFrame(user.id, payload);
    });

    socket.on('close', () => {
      removeConnection(conn);
      if (!isConnected(user.id)) {
        // Voice is tied to the gateway connection: losing the last socket ends
        // the call so other participants are not left talking to a ghost.
        leaveVoice(user.id);
        broadcastPresence(user.id, user.status);
      }
    });

    socket.on('error', () => {
      removeConnection(conn);
    });
  });

  const heartbeat = setInterval(() => {
    for (const conn of allConnections()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
