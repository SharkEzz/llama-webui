import type { WSEvents } from 'hono/ws';
import type { WsHub } from './hub';

const utf8 = new TextDecoder();

/**
 * A `/ws` client for the hub (`upgradeWebSocket`): attached once open, its messages received, detached on close. The
 * adapter passes the same context to each event of a connection: it is the hub's key.
 */
export function hubEvents(hub: WsHub): WSEvents {
  return {
    onOpen: (_e, ws) => hub.attach(ws),
    // Text and binary alike: the hub ignores what is not a JSON object.
    onMessage: (e, ws) =>
      hub.receive(ws, typeof e.data === 'string' ? e.data : utf8.decode(e.data as ArrayBuffer | Uint8Array)),
    onClose: (_e, ws) => hub.detach(ws),
  };
}
