// A V8 CPU profile (the Node inspector's or the page's), aggregated by group, by function (self) and by app
// function on the stack (inclusive).
import { arr, num, record, str } from '../json.ts';
import type { ProfileRow, ProfileSummary } from '../results.ts';

export interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CpuProfile {
  nodes: { id: number; callFrame: CallFrame; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
  /** µs; when present, the last sample is charged the time until the end of the profile */
  startTime?: number;
  endTime?: number;
}

/** Where a frame comes from, in the terms of the sources. A group that starts with `app` is the app's own code. */
export interface Origin {
  fn: string;
  module: string;
  line: number;
  group: string;
}

const TOP = 30;

export function parseCpuProfile(json: unknown): CpuProfile {
  const p = record(json, 'CPU profile');
  if (!Array.isArray(p.nodes) || !Array.isArray(p.samples) || !Array.isArray(p.timeDeltas))
    throw new Error('CPU profile: no nodes, samples or timeDeltas');
  const nodes = p.nodes.map((n) => {
    const node = record(n, 'CPU profile node');
    const cf = record(node.callFrame, 'CPU profile call frame');
    const children = arr(node.children).filter((c) => typeof c === 'number');
    return {
      id: num(node.id),
      callFrame: {
        functionName: str(cf.functionName),
        url: str(cf.url),
        lineNumber: num(cf.lineNumber),
        columnNumber: num(cf.columnNumber),
      },
      children,
    };
  });
  return {
    nodes,
    samples: p.samples.map((s) => num(s)),
    timeDeltas: p.timeDeltas.map((d) => num(d)),
    ...(typeof p.startTime === 'number' && typeof p.endTime === 'number'
      ? { startTime: p.startTime, endTime: p.endTime }
      : {}),
  };
}

const isApp = (o: Origin) => o.group.startsWith('app');

/**
 * Each sample is charged the time until the next one (`timeDeltas[i + 1]`, in µs), as DevTools does: a long gap after
 * an idle sample stays idle. The last sample is charged the time until `endTime`, or its own delta without one. `(idle)` is left out of
 * `activeMs`; `(program)` and `(garbage collector)` are groups of their own. Inclusive time is counted for the app's
 * functions, once per stack (a recursive function is not counted twice).
 */
export function summarizeProfile(profile: CpuProfile, originOf: (frame: CallFrame) => Origin): ProfileSummary {
  const byId = new Map<number, CallFrame>();
  const parent = new Map<number, number>();
  for (const n of profile.nodes) {
    byId.set(n.id, n.callFrame);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  const origins = new Map<number, Origin>();
  const originFor = (id: number): Origin => {
    let o = origins.get(id);
    if (!o) {
      const f = byId.get(id) ?? { functionName: '(unknown)', url: '', lineNumber: 0, columnNumber: 0 };
      o = originOf(f);
      origins.set(id, o);
    }
    return o;
  };
  const self = new Map<number, number>();
  const n = profile.samples.length;
  const lastAt = profile.startTime === undefined ? 0 : profile.timeDeltas.reduce((a, d) => a + d, profile.startTime);
  let totalMs = 0;
  profile.samples.forEach((id, i) => {
    const next = profile.timeDeltas[i + 1];
    const tail = profile.endTime === undefined ? (profile.timeDeltas[i] ?? 0) : Math.max(0, profile.endTime - lastAt);
    const ms = (i < n - 1 ? (next ?? 0) : tail) / 1000;
    totalMs += ms;
    self.set(id, (self.get(id) ?? 0) + ms);
  });
  const key = (o: Origin) => `${o.fn}|${o.module}|${String(o.line)}`;
  const groups = new Map<string, number>();
  const selfRows = new Map<string, ProfileRow>();
  const inclusive = new Map<string, ProfileRow>();
  let idleMs = 0;
  let gcMs = 0;
  const add = (rows: Map<string, ProfileRow>, o: Origin, ms: number) => {
    const k = key(o);
    const row = rows.get(k) ?? { fn: o.fn, module: o.module, line: o.line, group: o.group, ms: 0 };
    row.ms += ms;
    rows.set(k, row);
  };
  for (const [id, ms] of self) {
    const o = originFor(id);
    if (o.group === '(idle)') {
      idleMs += ms;
      continue;
    }
    if (o.group === '(garbage collector)') gcMs += ms;
    groups.set(o.group, (groups.get(o.group) ?? 0) + ms);
    add(selfRows, o, ms);
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const a = originFor(cur);
      if (!isApp(a) || seen.has(key(a))) continue;
      seen.add(key(a));
      add(inclusive, a, ms);
    }
  }
  const top = <T extends { ms: number }>(xs: Iterable<T>) => [...xs].toSorted((a, b) => b.ms - a.ms).slice(0, TOP);
  return {
    totalMs,
    activeMs: totalMs - idleMs,
    gcMs,
    byGroup: top([...groups].map(([group, ms]) => ({ group, ms }))),
    topSelf: top(selfRows.values()),
    topInclusive: top(inclusive.values()),
  };
}
