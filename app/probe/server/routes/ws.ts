import { defineWebSocketHandler } from 'nitro';

export default defineWebSocketHandler({
  upgrade(request) {
    if (request.headers.get('origin') === 'http://evil.example') {
      throw Response.json({ error: 'Origin not allowed' }, { status: 403 });
    }
  },
  open(peer) {
    peer.send(JSON.stringify({ type: 'hello' }));
  },
  message(peer, message) {
    peer.send(JSON.stringify({ type: 'echo', bytes: message.uint8Array().byteLength }));
  },
});
