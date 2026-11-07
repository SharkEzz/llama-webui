import type { WsMessage } from '@llama-webui/shared';
import type { ServerWebSocket } from 'bun';

const PING_INTERVAL_MS = 15_000;
const MAX_MISSED_PINGS = 2;

/** Registre des clients WS : diffusion et heartbeat (ping 15 s, fermeture après 2 pings sans pong). */
export class WsHub {
  private readonly clients = new Map<ServerWebSocket<unknown>, { missed: number }>();
  private readonly timer: Timer;

  constructor(
    private readonly bootId: string,
    pingIntervalMs = PING_INTERVAL_MS,
  ) {
    this.timer = setInterval(() => this.heartbeat(), pingIntervalMs);
  }

  attach(ws: ServerWebSocket<unknown>): void {
    this.clients.set(ws, { missed: 0 });
    this.send(ws, { type: 'hello', payload: { serverTime: Date.now(), bootId: this.bootId } });
  }

  detach(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
  }

  /** À appeler pour chaque message texte reçu d'un client. */
  receive(ws: ServerWebSocket<unknown>, raw: string | Buffer): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
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

  dispose(): void {
    clearInterval(this.timer);
    for (const ws of this.clients.keys()) ws.close(1001, 'arrêt');
    this.clients.clear();
  }

  private send(ws: ServerWebSocket<unknown>, msg: WsMessage): void {
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
