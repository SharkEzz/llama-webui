import type { WsMessage } from '@llama-webui/shared';

/** What the hub needs of a client socket: the adapter's WebSocket context (`server/ws/attach.ts`). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drops the connection without a closing handshake (crossws's `Peer.terminate()`). */
  terminate?(): void;
}

const PING_INTERVAL_MS = 15_000;
const MAX_MISSED_PINGS = 2;
/** How long `dispose()` waits for a client to answer its close (1001) before dropping the connection. */
const CLOSE_GRACE_MS = 500;

/** WS client registry: broadcast and heartbeat (ping every 15 s, close after 2 pings without a pong). */
export class WsHub {
  private readonly clients = new Map<WsLike, { missed: number }>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly bootId: string,
    pingIntervalMs = PING_INTERVAL_MS,
  ) {
    this.timer = setInterval(() => this.heartbeat(), pingIntervalMs);
  }

  attach(ws: WsLike): void {
    this.clients.set(ws, { missed: 0 });
    this.send(ws, { type: 'hello', payload: { serverTime: Date.now(), bootId: this.bootId } });
  }

  detach(ws: WsLike): void {
    this.clients.delete(ws);
  }

  /** Call for every text message received from a client. */
  receive(ws: WsLike, raw: string): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // `null`, a number or an array parse fine too: only an object can be a message.
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return;
    const state = this.clients.get(ws);
    if (!state) return;
    if (msg.type === 'pong') state.missed = 0;
    else if (msg.type === 'ping') this.send(ws, { type: 'pong' });
  }

  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) ws.send(data);
  }

  size(): number {
    return this.clients.size;
  }

  /**
   * Closes every client (1001), then drops those that have not answered within `CLOSE_GRACE_MS`: a peer that never
   * answers (the upstream socket of a proxied `/ws` in dev, whose browser is already gone) would otherwise hold the
   * HTTP server open until `ws`'s own close timeout (30 s). Not holding the process for that.
   */
  dispose(): void {
    clearInterval(this.timer);
    const open = [...this.clients.keys()];
    this.clients.clear();
    for (const ws of open) ws.close(1001, 'shutdown');
    if (open.length > 0)
      setTimeout(() => {
        for (const ws of open) ws.terminate?.();
      }, CLOSE_GRACE_MS).unref();
  }

  private send(ws: WsLike, msg: WsMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private heartbeat(): void {
    for (const [ws, state] of this.clients) {
      if (state.missed >= MAX_MISSED_PINGS) {
        ws.close(4000, 'heartbeat');
        this.clients.delete(ws);
        continue;
      }
      state.missed++;
      this.send(ws, { type: 'ping' });
    }
  }
}
