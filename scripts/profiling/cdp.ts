// A minimal Chrome DevTools Protocol client over the global WebSocket: enough for the Node inspector of the server.
import { isRecord, parseJson, str } from './json.ts';

export class Cdp {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #handlers = new Map<string, ((params: unknown) => void)[]>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = parseJson(String(ev.data));
      if (!isRecord(msg)) return;
      if (typeof msg.id === 'number') {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (isRecord(msg.error)) p.reject(new Error(str(msg.error.message, 'CDP error')));
        else p.resolve(msg.result);
      } else if (typeof msg.method === 'string')
        for (const handler of this.#handlers.get(msg.method) ?? []) handler(msg.params);
    });
    ws.addEventListener('close', () => {
      for (const p of this.#pending.values()) p.reject(new Error('the inspector closed'));
      this.#pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** `Runtime.evaluate` by value; an exception in the expression rejects. */
  async evaluate(expression: string): Promise<unknown> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (!isRecord(r)) throw new Error('evaluate: no result');
    if (r.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.exceptionDetails)}`);
    return isRecord(r.result) ? r.result.value : undefined;
  }

  on(event: string, handler: (params: unknown) => void): void {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
  }

  close(): void {
    this.#ws.close();
  }
}
