/** A WebSocket client of a test (Node's global `WebSocket`, as a browser's), its messages kept in order. */
export interface WsClient {
  readonly socket: WebSocket;
  /** Every message received so far, parsed as JSON. */
  readonly messages: Array<unknown>;
  /** The next message not taken yet that `match` accepts (any by default); rejects after `ms`. */
  next(match?: (message: unknown) => boolean, ms?: number): Promise<unknown>;
  /** Calls `listener` with each message from now on, parsed as JSON. */
  onMessage(listener: (message: unknown) => void): void;
  /** Settles with the close code and reason once the connection closed. */
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Sends `data` as text: a string as it is, anything else as JSON. */
  send(data: unknown): void;
}

/** Whether `message` is an object whose `type` is `type`. */
export const ofType =
  (type: string) =>
  (message: unknown): boolean =>
    typeof message === 'object' && message !== null && 'type' in message && message.type === type;

/** Opens `url`; rejects if the connection fails before it opens. `headers` go with the upgrade request. */
export function openWs(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
  // Node's WebSocket (undici) takes headers in its second argument; the DOM typings do not know it.
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  const messages: Array<unknown> = [];
  let taken = 0;
  const waiters = new Set<() => void>();
  const listeners = new Set<(message: unknown) => void>();
  socket.addEventListener('message', (event) => {
    const message: unknown = JSON.parse(String(event.data));
    messages.push(message);
    for (const wake of waiters) wake();
    for (const listener of listeners) listener(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
  );
  const client: WsClient = {
    socket,
    messages,
    closed,
    onMessage: (listener) => listeners.add(listener),
    send: (data) => socket.send(typeof data === 'string' ? data : JSON.stringify(data)),
    next: (match = () => true, ms = 2000) =>
      new Promise((resolve, reject) => {
        const look = () => {
          while (taken < messages.length) {
            const message = messages[taken++];
            if (match(message)) {
              waiters.delete(look);
              clearTimeout(timer);
              resolve(message);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(look);
          reject(new Error(`no matching message within ${ms} ms (received ${JSON.stringify(messages)})`));
        }, ms);
        waiters.add(look);
        look();
      }),
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(client), { once: true });
    socket.addEventListener('error', () => reject(new Error(`the connection to ${url} failed`)), { once: true });
  });
}
