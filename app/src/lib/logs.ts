import { EMPTY_LOG_VIEW, type LogLine, type LogView, mergeLogs, onBoot } from '@llama-webui/shared';
import { create } from 'zustand';
import { call as webCall } from './api';
import { debugStore } from './debug/stores';
import { onWs, useWs, type WsStatus } from './ws';

const MAX_LINES = 10_000;

/** What the store follows of the push channel: its status (the web's `useWs`, or a store of a test). */
interface WsLike {
  getState: () => { readonly status: WsStatus };
  subscribe: (
    listener: (state: { readonly status: WsStatus }, prev: { readonly status: WsStatus }) => void,
  ) => () => void;
}

/** The calls and the channel the store uses: the web's, or in a test a fake `fetch` and a store of its own. */
export interface LogsDeps {
  readonly call: typeof webCall;
  readonly ws: WsLike;
}

/**
 * The logs' store, tied to the server's boot (bootId): a llama-webui restart starts from scratch. Only the Logs and
 * Server pages show the lines, so the first of them to be shown starts it (`follow`): the whole ring is read then
 * (at once with the channel open, else when it opens), the `hello` and `log` messages are applied from then on, and
 * the lines missed while the channel was down are read again on each reconnect. Once started it keeps running: a
 * page shown again reads nothing.
 */
export const makeLogs = ({ call, ws }: LogsDeps) => {
  const store = create<LogView>()(() => EMPTY_LOG_VIEW);
  let following = false;

  /** Reads the lines from the next one expected; a different boot starts over and rereads everything. */
  const replay = async (): Promise<void> => {
    const asked = store.getState();
    try {
      const r = await call((api) => api.logs.list({ query: { since: asked.seq } }));
      const now = store.getState();
      if (r.bootId !== asked.bootId && asked.bootId !== null) {
        // Different boot than the one of the requested lines: start over and reread everything.
        store.setState(onBoot(now, r.bootId));
        const all = await call((api) => api.logs.list({ query: { since: 0 } }));
        store.setState((s) => mergeLogs(onBoot(s, all.bootId), all.lines, MAX_LINES));
      } else store.setState(mergeLogs(onBoot(now, r.bootId), r.lines, MAX_LINES));
    } catch {
      // retried on the next reconnect
    }
  };

  /** A `hello` message (it arrives before any line on a new connection: the boot change is seen first). */
  const hello = (bootId: string): void => {
    if (following) store.setState((s) => onBoot(s, bootId));
  };

  /** A `log` message. */
  const lines = (batch: ReadonlyArray<LogLine>): void => {
    if (following) store.setState((s) => mergeLogs(s, batch, MAX_LINES));
  };

  /** Starts the store (once): reads the ring now with the channel open, then on each (re)connect. */
  const follow = (): void => {
    if (following) return;
    following = true;
    if (ws.getState().status === 'open') void replay();
    ws.subscribe((s, prev) => {
      if (s.status === 'open' && prev.status !== 'open') void replay();
    });
  };

  return { store, hello, lines, follow };
};

const logs = makeLogs({ call: webCall, ws: useWs });

export const useLogs = logs.store;

/** “Clear view”: hides the lines received so far (the server ring is left untouched). */
export const hideCurrentLogs = () => useLogs.setState((s) => ({ hiddenBefore: s.seq }));

let started = false;
/**
 * Starts the logs' store (see `makeLogs`): called by each page that shows lines, in an effect. The messages are
 * followed from the first call on, and the store keeps running once started.
 */
export function startLogsSync(): void {
  if (started) return;
  started = true;
  onWs('hello', (m) => logs.hello(m.payload.bootId));
  onWs('log', (m) => logs.lines(m.payload));
  logs.follow();
}

debugStore('logs', useLogs);
