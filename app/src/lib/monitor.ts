import { defer, type HistoryDump, type Snapshot } from '@llama-webui/shared';
import { create } from 'zustand';
import { call as webCall } from './api';
import { onWs, useWs, type WsStatus } from './ws';

/**
 * Client-side history: timestamps (s, for uPlot) and one series per key, aligned point by point (null = gap).
 * Mutable arrays shared with the charts; `version` changes on every update.
 */
export interface ClientHistory {
  intervalMs: number;
  capacity: number;
  times: number[];
  series: Map<string, (number | null)[]>;
}

interface MonitorState {
  snapshot: Snapshot | null;
  history: ClientHistory;
  version: number;
}

const emptyHistory = (): ClientHistory => ({ intervalMs: 1000, capacity: 300, times: [], series: new Map() });

/** A history of the client's own: each series is copied into a mutable array, which `append` grows. */
function fromDump(d: HistoryDump): ClientHistory {
  return {
    intervalMs: d.intervalMs,
    capacity: d.capacity,
    times: d.times.map((t) => t / 1000),
    series: new Map(Object.entries(d.series).map(([key, values]) => [key, [...values]])),
  };
}

function append(h: ClientHistory, s: Snapshot) {
  const t = s.at / 1000;
  if (h.times.length > 0 && t <= h.times.at(-1)!) return;
  h.times.push(t);
  for (const [key, values] of h.series) values.push(s.points[key] ?? null);
  for (const [key, v] of Object.entries(s.points)) {
    if (h.series.has(key)) continue;
    const values: (number | null)[] = Array.from({ length: h.times.length - 1 }, () => null);
    values.push(v);
    h.series.set(key, values);
  }
  const extra = h.times.length - h.capacity;
  if (extra > 0) {
    h.times.splice(0, extra);
    for (const values of h.series.values()) values.splice(0, extra);
  }
}

/** What the store follows of the push channel: its status (the web's `useWs`, or a store of a test). */
interface WsLike {
  getState: () => { readonly status: WsStatus };
  subscribe: (
    listener: (state: { readonly status: WsStatus }, prev: { readonly status: WsStatus }) => void,
  ) => () => void;
}

/** The calls and the channel the store uses: the web's, or in a test a fake `fetch` and a store of its own. */
export interface MonitorDeps {
  readonly call: typeof webCall;
  readonly ws: WsLike;
}

/**
 * The monitor's store. The snapshot is followed from the app's start (`snapshot`, `hello`); the history only once a
 * chart asks for it (`wantHistory`): read then (at once with the channel open, else when it opens), grown by each
 * snapshot, and read again on each reconnect and on a change of its shape (settings). Before that, a snapshot leaves
 * the history empty: a series never holds points of before the read.
 */
export const makeMonitor = ({ call, ws }: MonitorDeps) => {
  const store = create<MonitorState>(() => ({ snapshot: null, history: emptyHistory(), version: 0 }));
  let wanted = false;
  let loading = false;
  let pending: Snapshot[] = [];
  let bootId: string | null = null;

  /** Rereads the whole server history (first chart, connect, different boot, shape changed by settings). */
  const reloadHistory = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    pending = [];
    using _loading = defer(() => {
      loading = false;
      pending = [];
    });
    try {
      const d = await call((api) => api.monitor.history());
      const h = fromDump(d);
      for (const s of pending) append(h, s);
      store.setState((st) => ({ history: h, version: st.version + 1 }));
    } catch {
      // WS closed or server gone: the next connection will reread.
    }
  };

  /** A `snapshot` message. */
  const snapshot = (s: Snapshot): void => {
    store.setState({ snapshot: s });
    if (!wanted) return;
    if (loading) {
      pending.push(s);
      return;
    }
    const h = store.getState().history;
    if (s.history.intervalMs !== h.intervalMs || s.history.capacity !== h.capacity) {
      void reloadHistory();
      return;
    }
    append(h, s);
    store.setState((st) => ({ version: st.version + 1 }));
  };

  /** A `hello` message: the one of a different llama-webui boot always precedes its snapshots, the history is worthless. */
  const hello = (next: string): void => {
    if (bootId !== null && bootId !== next) store.setState({ history: emptyHistory(), snapshot: null });
    bootId = next;
  };

  /** A chart is shown: the history is read (once; its rules apply from then on). */
  const wantHistory = (): void => {
    if (wanted) return;
    wanted = true;
    if (ws.getState().status === 'open') void reloadHistory();
  };

  ws.subscribe((s, prev) => {
    if (wanted && s.status === 'open' && prev.status !== 'open') void reloadHistory();
  });

  return { store, snapshot, hello, wantHistory };
};

const monitor = makeMonitor({ call: webCall, ws: useWs });

export const useMonitor = monitor.store;

/** Reads the history for the charts (see `makeMonitor`): called by each chart, in an effect. */
export const wantHistory = monitor.wantHistory;

let started = false;
/** Follows the snapshots (at startup); the history waits for a chart (`wantHistory`). */
export function startMonitorSync(): void {
  if (started) return;
  started = true;
  onWs('snapshot', ({ payload }) => monitor.snapshot(payload));
  onWs('hello', ({ payload }) => monitor.hello(payload.bootId));
}
