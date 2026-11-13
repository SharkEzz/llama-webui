import { defineWebSocketHandler } from 'nitro';
import { deps, ready } from '../lib/context.ts';
import { guard } from '../lib/security.ts';
import type { WsHub, WsLike } from '../lib/ws/hub.ts';

/** Largest client message (`ws`'s `maxPayload` before Nitro: Nitro passes no option to crossws, the cap is 100 MiB). */
const MAX_CLIENT_MESSAGE_BYTES = 4096;

/**
 * The hub each connection was attached to: a business code reload builds a new runtime while the old hub closes its
 * sockets (1001), whose `close` events must reach that old hub.
 */
const hubs = new WeakMap<object, WsHub>();

/**
 * `/ws`: the hub of `lib/ws/hub.ts` (hello, broadcasts, heartbeat). The upgrade goes through the API's guard; a refusal
 * is answered on a connection the server closes. `/ws` without an upgrade is `middleware/01.guard.ts`'s 426.
 */
export default defineWebSocketHandler({
  async upgrade(request) {
    const refused = guard(request);
    if (refused) {
      refused.headers.set('Connection', 'close');
      throw refused;
    }
    await ready().catch(() => {
      throw new Response('llama-webui is starting', { status: 503, headers: { Connection: 'close' } });
    });
  },
  // crossws passes the same peer to each event of a connection: it is the hub's key.
  open(peer) {
    const { hub } = deps();
    hubs.set(peer, hub);
    hub.attach(peer as WsLike);
  },
  message(peer, message) {
    const bytes = message.uint8Array();
    // The frame is already buffered: closed as `ws` would have (1009), not refused before it is read.
    if (bytes.byteLength > MAX_CLIENT_MESSAGE_BYTES) return peer.close(1009, 'Message too big');
    // Text and binary alike: the hub ignores what is not a JSON object.
    hubs.get(peer)?.receive(peer as WsLike, message.text());
  },
  close: (peer) => hubs.get(peer)?.detach(peer as WsLike),
});
