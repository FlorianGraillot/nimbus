import { API_BASE, tokens } from './api';
import type { GatewayEvent } from './types';

export type GatewayStatus = 'connecting' | 'online' | 'offline';

interface Options {
  onEvent: (event: GatewayEvent) => void;
  onStatus: (status: GatewayStatus) => void;
  onReconnect: () => void;
}

let socket: WebSocket | null = null;
let options: Options | null = null;
let attempts = 0;
let timer: number | null = null;
let stopped = true;
let everConnected = false;

const gatewayUrl = () => {
  const base = API_BASE.replace(/^http/, 'ws');
  return `${base}/gateway?token=${encodeURIComponent(tokens.access ?? '')}`;
};

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = Math.min(1000 * 2 ** attempts, 15_000);
  attempts += 1;
  timer = window.setTimeout(connect, delay);
}

function connect(): void {
  if (stopped) return;
  options?.onStatus('connecting');

  let ws: WebSocket;
  try {
    ws = new WebSocket(gatewayUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    attempts = 0;
    options?.onStatus('online');
    if (everConnected) options?.onReconnect();
    everConnected = true;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as GatewayEvent;
      if (data && typeof data.t === 'string') options?.onEvent(data);
    } catch {
      /* ignore malformed frames */
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    options?.onStatus('offline');
    scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  };
}

export function startGateway(opts: Options): void {
  stopGateway();
  options = opts;
  stopped = false;
  attempts = 0;
  everConnected = false;
  connect();
}

export function stopGateway(): void {
  stopped = true;
  options?.onStatus('offline');
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* noop */
    }
  }
  socket = null;
}

/** Send one frame to the server (used by voice signalling). */
export function sendGateway(event: GatewayEvent): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(event));
  return true;
}

export function isGatewayOpen(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}
