// A Chromium trace → frames drawn per second and the page main thread's time by category.
import { readFileSync } from 'node:fs';
import { arr, isRecord, num, parseJson, str } from '../json.ts';
import type { TraceSummary } from '../results.ts';

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur: number | null;
  threadName: string | null;
}

/** Trace event name → category of the main thread's time. */
const CATEGORY: Record<string, string> = {
  FunctionCall: 'script',
  EvaluateScript: 'script',
  TimerFire: 'script',
  FireAnimationFrame: 'script',
  EventDispatch: 'script',
  RunMicrotasks: 'script',
  'v8.callFunction': 'script',
  'V8.DeoptimizeCode': 'script',
  XHRReadyStateChange: 'script',
  WebSocketReceive: 'script',
  FireIdleCallback: 'script',
  'v8.compile': 'script',
  'v8.compileModule': 'script',
  'v8.evaluateModule': 'script',
  MinorGC: 'gc',
  MajorGC: 'gc',
  'V8.GC_MC_BACKGROUND_MARKING': 'gc',
  'BlinkGC.AtomicPhase': 'gc',
  'V8.GCScavenger': 'gc',
  'V8.GCIncrementalMarking': 'gc',
  UpdateLayoutTree: 'style',
  RecalculateStyles: 'style',
  ParseAuthorStyleSheet: 'style',
  ScheduleStyleRecalculation: 'style',
  Layout: 'layout',
  IntersectionObserverController: 'layout',
  'IntersectionObserverController::computeIntersections': 'layout',
  HitTest: 'layout',
  PrePaint: 'paint',
  Paint: 'paint',
  Layerize: 'paint',
  Commit: 'paint',
  UpdateLayer: 'paint',
  UpdateLayerTree: 'paint',
  CompositeLayers: 'paint',
  PaintImage: 'paint',
  'Decode Image': 'paint',
  RasterTask: 'paint',
  ImageDecodeTask: 'paint',
};

function readEvents(path: string): TraceEvent[] {
  const raw = parseJson(readFileSync(path, 'utf8'));
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.traceEvents) : [];
  const events: TraceEvent[] = [];
  for (const e of list) {
    if (!isRecord(e)) continue;
    const args = isRecord(e.args) ? e.args : {};
    events.push({
      name: str(e.name),
      ph: str(e.ph),
      pid: num(e.pid),
      tid: num(e.tid),
      ts: num(e.ts),
      dur: typeof e.dur === 'number' ? e.dur : null,
      threadName: typeof args.name === 'string' ? args.name : null,
    });
  }
  return events;
}

export function summarizeTrace(path: string): TraceSummary {
  const events = readEvents(path);
  const threadNames = new Map<string, string>();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name')
      threadNames.set(`${String(e.pid)}:${String(e.tid)}`, e.threadName ?? '');
  const complete = events.filter((e): e is TraceEvent & { dur: number } => e.ph === 'X' && e.dur !== null);
  let t0 = Infinity;
  let t1 = 0;
  for (const e of complete) {
    t0 = Math.min(t0, e.ts);
    t1 = Math.max(t1, e.ts + e.dur);
  }
  const wallMs = complete.length > 0 ? (t1 - t0) / 1000 : 0;
  // The renderer main thread that worked the most is the page's
  const busy = new Map<string, number>();
  for (const e of complete) {
    if (e.name !== 'RunTask') continue;
    const k = `${String(e.pid)}:${String(e.tid)}`;
    busy.set(k, (busy.get(k) ?? 0) + e.dur);
  }
  const main = [...busy]
    .filter(([k]) => threadNames.get(k) === 'CrRendererMain')
    .toSorted((a, b) => b[1] - a[1])[0]?.[0];
  const byCategory = new Map<string, number>();
  if (main !== undefined && wallMs > 0) {
    const mine = complete
      .filter((e) => `${String(e.pid)}:${String(e.tid)}` === main)
      .toSorted((a, b) => a.ts - b.ts || b.dur - a.dur);
    // Self time: an event's duration minus its children's, the stack rebuilt from the nesting of the timestamps
    const stack: { e: TraceEvent & { dur: number }; child: number }[] = [];
    const close = (item: { e: TraceEvent & { dur: number }; child: number }) => {
      const cat = CATEGORY[item.e.name] ?? (item.e.name === 'RunTask' ? 'other (tasks)' : 'other');
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + (item.e.dur - item.child) / 1000);
    };
    for (const e of mine) {
      for (let top = stack.at(-1); top && top.e.ts + top.e.dur <= e.ts; top = stack.at(-1)) {
        stack.pop();
        close(top);
      }
      const parent = stack.at(-1);
      if (parent) parent.child += e.dur;
      stack.push({ e, child: 0 });
    }
    for (let top = stack.pop(); top; top = stack.pop()) close(top);
  }
  const seconds = wallMs / 1000;
  const drawn = events.filter((e) => e.name === 'DrawFrame').length;
  return {
    framesPerSec: seconds > 0 ? drawn / seconds : 0,
    mainThreadPct: Object.fromEntries([...byCategory].map(([k, ms]) => [k, (ms / wallMs) * 100])),
  };
}
