import { defer, type HistoryDump, type Snapshot } from '@llama-webui/shared';
import { create } from 'zustand';
import { call, client } from './api';
import { onWs, useWs } from './ws';

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

export const useMonitor = create<MonitorState>(() => ({ snapshot: null, history: emptyHistory(), version: 0 }));

/** History series (aligned with `history.times`); updates with `version`. */
export function useSeries(key: string): (number | null)[] | undefined {
  useMonitor((s) => s.version);
  return useMonitor.getState().history.series.get(key);
}

function fromDump(d: HistoryDump): ClientHistory {
  return {
    intervalMs: d.intervalMs,
    capacity: d.capacity,
    times: d.times.map((t) => t / 1000),
    series: new Map(Object.entries(d.series)),
  };
}

function append(h: ClientHistory, s: Snapshot) {
  const t = s.at / 1000;
  if (h.times.length > 0 && t <= h.times.at(-1)!) return;
  h.times.push(t);
  for (const [key, values] of h.series) values.push(s.points[key] ?? null);
  for (const [key, v] of Object.entries(s.points)) {
    if (h.series.has(key)) continue;
    const values: (number | null)[] = new Array(h.times.length - 1).fill(null);
    values.push(v);
    h.series.set(key, values);
  }
  const extra = h.times.length - h.capacity;
  if (extra > 0) {
    h.times.splice(0, extra);
    for (const values of h.series.values()) values.splice(0, extra);
  }
}

let loading = false;
let pending: Snapshot[] = [];

/** Rereads the whole server history (connect, different boot, shape changed by settings). */
export async function reloadHistory() {
  if (loading) return;
  loading = true;
  pending = [];
  using _loading = defer(() => {
    loading = false;
    pending = [];
  });
  try {
    const d = await call(client.monitor.history.$get());
    const h = fromDump(d);
    for (const s of pending) append(h, s);
    useMonitor.setState((st) => ({ history: h, version: st.version + 1 }));
  } catch {
    // WS closed or server gone: the next connection will reread.
  }
}

export function startMonitorSync() {
  onWs('snapshot', ({ payload: s }) => {
    useMonitor.setState({ snapshot: s });
    if (loading) {
      pending.push(s);
      return;
    }
    const h = useMonitor.getState().history;
    if (s.history.intervalMs !== h.intervalMs || s.history.capacity !== h.capacity) {
      void reloadHistory();
      return;
    }
    append(h, s);
    useMonitor.setState((st) => ({ version: st.version + 1 }));
  });
  // The hello of a different llama-webui boot always precedes its snapshots: the local history is worthless.
  let bootId: string | null = null;
  onWs('hello', ({ payload }) => {
    if (bootId !== null && bootId !== payload.bootId) useMonitor.setState({ history: emptyHistory(), snapshot: null });
    bootId = payload.bootId;
  });
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void reloadHistory();
  });
}
