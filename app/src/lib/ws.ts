import { WsMessage } from '@llama-webui/shared';
import { Option, Schema } from 'effect';
import { create } from 'zustand';

export type WsStatus = 'connecting' | 'open' | 'closed';

interface WsState {
  status: WsStatus;
  lastMessage?: WsMessage;
  connect(): void;
}

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/** A frame as a message of the push channel; what does not decode (not JSON, an unknown type) is none. */
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(WsMessage));

type Listener = (msg: WsMessage) => void;
const listeners = new Map<WsMessage['type'], Set<Listener>>();

/** Subscribes to WS messages of a given type. */
export function onWs<T extends WsMessage['type']>(
  type: T,
  fn: (msg: Extract<WsMessage, { type: T }>) => void,
): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(fn as Listener);
  return () => set.delete(fn as Listener);
}

let socket: WebSocket | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = BACKOFF_START_MS;
let started = false;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Single WebSocket connection with automatic reconnect (backoff 500 ms × 2, capped at 10 s). */
export const useWs = create<WsState>()((set, get) => {
  const open = () => {
    retryTimer = undefined;
    // After the first drop we stay “closed” while retrying, to avoid flickering.
    if (get().status !== 'closed') set({ status: 'connecting' });
    const ws = new WebSocket(wsUrl());
    socket = ws;

    ws.onopen = () => {
      backoff = BACKOFF_START_MS;
      set({ status: 'open' });
    };
    ws.onmessage = (event) => {
      const decoded = decodeFrame(String(event.data));
      if (Option.isNone(decoded)) return;
      const msg = decoded.value;
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' } satisfies WsMessage));
      set({ lastMessage: msg });
      for (const fn of listeners.get(msg.type) ?? []) fn(msg);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = undefined;
      set({ status: 'closed' });
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
    // onerror is always followed by onclose: nothing to do here.
  };

  return {
    status: 'connecting',
    connect() {
      if (started) return;
      started = true;
      open();
    },
  };
});

/** Label and color of the status dot. */
export const WS_STATUS_UI: Record<WsStatus, { label: string; tone: 'ok' | 'wait' | 'down' }> = {
  open: { label: 'Connected', tone: 'ok' },
  connecting: { label: 'Connecting…', tone: 'wait' },
  closed: { label: 'Disconnected', tone: 'down' },
};

// Avoids ghost sockets on hot reload.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (retryTimer) clearTimeout(retryTimer);
    const ws = socket;
    socket = undefined;
    ws?.close();
    started = false;
  });
}
