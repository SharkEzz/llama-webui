import type { WebSocket } from 'ws';
import type { WsHub } from './hub';

/** Hands a `ws` socket to the hub: attached now, its messages received, detached on close. */
export function attachSocket(hub: WsHub, ws: WebSocket): void {
  hub.attach(ws);
  // Text and binary alike, as under Bun: the hub parses `String(raw)` and ignores what is not a JSON object.
  ws.on('message', (data) => hub.receive(ws, data.toString()));
  ws.on('close', () => hub.detach(ws));
  // A reset connection: `close` follows and detaches it.
  ws.on('error', () => {});
}
