type EventHandler = (data: any) => void;

const listeners = new Map<string, Set<EventHandler>>();
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = 1000;

export function connect(roomCode: string, token: string) {
  disconnect();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?room=${roomCode}&token=${encodeURIComponent(token)}`;

  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log('[WS] Connected');
    reconnectDelay = 1000;
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as { event: string; data: unknown };
      const handlers = listeners.get(msg.event);
      if (handlers) {
        for (const fn of handlers) fn(msg.data);
      }
    } catch (err) {
      console.warn('[WS] Bad message:', err);
    }
  };

  socket.onclose = () => {
    console.log(`[WS] Closed, reconnecting in ${reconnectDelay}ms`);
    reconnectTimer = window.setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      connect(roomCode, token);
    }, reconnectDelay);
  };

  socket.onerror = (err) => {
    console.warn('[WS] Error:', err);
  };
}

export function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null; // prevent auto-reconnect
    socket.close();
    socket = null;
  }
}

export function on(event: string, handler: EventHandler) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

export function off(event: string, handler: EventHandler) {
  listeners.get(event)?.delete(handler);
}
