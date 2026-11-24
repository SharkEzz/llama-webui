import { MessageStats, type WsMessage } from '@llama-webui/shared';
import { Option, Predicate, Schema } from 'effect';
import { create } from 'zustand';

/**
 * What the debug window shows, captured only while the debug mode is on: every tap returns at once when it is off, and
 * turning it on starts from empty. The buffers are bounded; the view the window reads is a copy, published at most
 * every `PUBLISH_MS` (the snapshot alone comes every second), and not while paused.
 */

export const WS_FRAMES = 500;
export const API_CALLS = 300;
export const SSE_STREAMS = 50;
export const STREAM_EVENTS = 200;
export const NAVIGATIONS = 20;
export const RESOURCES = 300;
/** Per store: a store that changes every second does not push out the rare changes of another. */
export const STORE_CHANGES = 200;
/** Frame rate and heap samples: one every `SAMPLE_MS`, for the last minute. */
export const SAMPLES = 120;
export const SAMPLE_MS = 500;
/** The window of the rates, in ms. */
export const RATE_WINDOW_MS = 5000;
export const PUBLISH_MS = 250;

/** A bounded buffer: the last `size` items pushed, oldest first. */
export class Ring<T> {
  #items: T[] = [];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.size) this.#items.splice(0, this.#items.length - this.size);
  }
  items(): readonly T[] {
    return this.#items;
  }
  clear(): void {
    this.#items = [];
  }
}

/** Samples `[at, bytes]` of the last `RATE_WINDOW_MS`: per second, the count and the bytes. */
export function rate(samples: [number, number][], now: number, windowMs = RATE_WINDOW_MS) {
  const from = now - windowMs;
  while (samples.length > 0 && samples[0]![0] <= from) samples.shift();
  const bytes = samples.reduce((sum, [, b]) => sum + b, 0);
  return { perSecond: (samples.length * 1000) / windowMs, bytesPerSecond: (bytes * 1000) / windowMs };
}

export interface WsFrame {
  id: number;
  at: number;
  dir: 'in' | 'out';
  /** The message type, `?` for a frame that does not decode. */
  type: string;
  size: number;
  /** The decoded message, or the raw frame when it does not decode. */
  data: unknown;
  /** Why the frame does not decode. */
  error?: string;
}

export interface WsConnection {
  status: 'connecting' | 'open' | 'closed';
  url: string;
  openedAt?: number;
  reconnects: number;
  /** The delay before the next attempt, while closed. */
  retryMs?: number;
  lastClose?: { at: number; code: number; reason: string; clean: boolean };
  bootIds: { at: number; bootId: string }[];
  /** The server's clock minus the page's, read from `hello`. */
  clockOffsetMs?: number;
}

export interface WsTypeStats {
  type: string;
  count: number;
  bytes: number;
  perSecond: number;
  bytesPerSecond: number;
}

export interface StreamEvent {
  at: number;
  type: string;
  data: unknown;
}

export interface ApiCall {
  id: number;
  at: number;
  method: string;
  path: string;
  state: 'pending' | 'ok' | 'error' | 'aborted';
  status?: number;
  /** Until the response headers. */
  headersMs?: number;
  /** Until the reply is decoded, or the stream ends. */
  ms?: number;
  bytes?: number;
  /** The `_tag` (or name) of what the call rejected with. */
  tag?: string;
  /** The body sent (decoded from JSON when it is). */
  request?: unknown;
  /** The decoded reply. */
  reply?: unknown;
  stream?: {
    firstEventMs?: number;
    events: number;
    byType: Record<string, number>;
    /** Characters of text received (`content` and `reasoning` of the events). */
    chars: number;
    last: StreamEvent[];
    /** llama-server's measures of the reply, from the stream's `done` event. */
    stats?: Pick<MessageStats, 'ttftMs' | 'promptTokens' | 'cachedTokens' | 'genTokens' | 'ppTps' | 'tgTps'>;
  };
}

export interface RenderStats {
  id: string;
  commits: number;
  mounts: number;
  sumMs: number;
  maxMs: number;
  lastMs: number;
  baseMs: number;
  /** Commits since the last navigation. */
  sinceNavigation: number;
}

export interface PerfStats {
  longTasks: { count: number; totalMs: number; worstMs: number };
  /** Interactions (event timing): the worst and the last, with the event that started them. */
  interactions: { count: number; worst?: { ms: number; name: string }; last?: { ms: number; name: string } };
  /** `ms` undefined: nothing to load, the page rendered at once. */
  navigations: { at: number; path: string; ms: number | undefined }[];
  /** Largest contentful paint of the page's load (the browser stops measuring it at the first interaction). */
  lcp?: { ms: number; element: string };
  /** Layout shifts: their sum, and the worst session window (shifts less than 1 s apart, 5 s at most: the CLS). */
  layoutShifts: { count: number; total: number; worstWindow: number };
  /** Frame rate and heap, sampled while the window is open. */
  samples: PerfSample[];
}

export interface PerfSample {
  at: number;
  fps: number;
  /** Used JS heap, in bytes (Chromium). */
  heap?: number;
}

/** A file the page loaded (Resource Timing): a script, a style sheet, a font, an image. */
export interface LoadedResource {
  id: number;
  at: number;
  /** The path for the page's origin, else the URL. */
  name: string;
  /** `script`, `link`, `css`, `img`, … (the element or API that asked for it). */
  type: string;
  /** Bytes over the network, headers included; 0 from the cache. */
  transferBytes: number;
  /** Bytes of the body, uncompressed. */
  bytes: number;
  ms: number;
  cached: boolean;
}

/**
 * A `set()` of a store that changed something: the top-level keys it changed, with their values before and after. The
 * values themselves, not copies: holding them costs only what they keep alive. A value a store changes in place (the
 * monitor's history, shared with the charts) is the same before and after: its diff shows nothing.
 */
export interface StoreChange {
  id: number;
  at: number;
  store: string;
  keys: string[];
  prev: Record<string, unknown>;
  next: Record<string, unknown>;
}

export interface StoreStats {
  store: string;
  /** `set()`s that changed a key. */
  changes: number;
  /** `set()`s that changed nothing: the subscribers ran for nothing. */
  noops: number;
  /** When the last change happened. */
  last?: number;
  /** Changes per second over the last `RATE_WINDOW_MS`. */
  perSecond: number;
}

export interface DebugView {
  /** When it was taken (the window's “now”: a render reads no clock). */
  at: number;
  ws: WsConnection;
  frames: WsFrame[];
  wsTypes: WsTypeStats[];
  calls: ApiCall[];
  streams: ApiCall[];
  renders: RenderStats[];
  perf: PerfStats;
  resources: LoadedResource[];
  storeChanges: StoreChange[];
  storeStats: StoreStats[];
  /** Rejected frames and failed calls since the window was last looked at. */
  unseenErrors: number;
}

const now = () => performance.now();

const emptyPerf = (): PerfStats => ({
  longTasks: { count: 0, totalMs: 0, worstMs: 0 },
  interactions: { count: 0 },
  navigations: [],
  layoutShifts: { count: 0, total: 0, worstWindow: 0 },
  samples: [],
});

let enabled = false;
let nextId = 1;
const frames = new Ring<WsFrame>(WS_FRAMES);
const calls = new Ring<ApiCall>(API_CALLS);
const streams = new Ring<ApiCall>(SSE_STREAMS);
const wsTypes = new Map<string, { count: number; bytes: number; samples: [number, number][] }>();
const renders = new Map<string, RenderStats>();
const resources = new Ring<LoadedResource>(RESOURCES);
const samples = new Ring<PerfSample>(SAMPLES);
const storeChanges = new Map<string, Ring<StoreChange>>();
const storeStats = new Map<string, { changes: number; noops: number; last?: number; samples: [number, number][] }>();
let ws: WsConnection = { status: 'connecting', url: '', reconnects: 0, bootIds: [] };
let perf: PerfStats = emptyPerf();
let errors = 0;
let seenErrors = 0;

const emptyView = (): DebugView => ({
  at: Date.now(),
  ws: { ...ws, bootIds: [] },
  frames: [],
  wsTypes: [],
  calls: [],
  streams: [],
  renders: [],
  perf: emptyPerf(),
  resources: [],
  storeChanges: [],
  storeStats: [],
  unseenErrors: 0,
});

/** A copy of what was captured (the records are copied: a paused view does not change under the window). */
export function snapshot(at = Date.now()): DebugView {
  const copyCall = (c: ApiCall): ApiCall => {
    const copy = Object.assign({}, c);
    if (c.stream)
      copy.stream = Object.assign({}, c.stream, { byType: { ...c.stream.byType }, last: [...c.stream.last] });
    return copy;
  };
  return {
    at,
    ws: { ...ws, bootIds: [...ws.bootIds] },
    frames: [...frames.items()],
    wsTypes: [...wsTypes].map(([type, t]) =>
      Object.assign({ type, count: t.count, bytes: t.bytes }, rate(t.samples, at)),
    ),
    calls: calls.items().map(copyCall),
    streams: streams.items().map(copyCall),
    renders: [...renders.values()].map((r) => Object.assign({}, r)),
    perf: {
      ...perf,
      longTasks: { ...perf.longTasks },
      interactions: { ...perf.interactions },
      navigations: [...perf.navigations],
      layoutShifts: { ...perf.layoutShifts },
      samples: [...samples.items()],
    },
    resources: [...resources.items()],
    storeChanges: [...storeChanges.values()].flatMap((ring) => ring.items()).toSorted((a, b) => a.id - b.id),
    storeStats: [...storeStats].map(([store, t]) => {
      const stats: StoreStats = { store, changes: t.changes, noops: t.noops, perSecond: rate(t.samples, at).perSecond };
      if (t.last !== undefined) stats.last = t.last;
      return stats;
    }),
    unseenErrors: errors - seenErrors,
  };
}

interface CaptureState {
  view: DebugView;
  paused: boolean;
}

/** The published view of the capture; the window reads `view`, nothing else. */
export const useDebugCapture = create<CaptureState>()(() => ({ view: emptyView(), paused: false }));

let publishTimer: ReturnType<typeof setTimeout> | undefined;

/** Publishes the view at most every `PUBLISH_MS`. */
function changed(): void {
  if (publishTimer !== undefined) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (enabled && !useDebugCapture.getState().paused) useDebugCapture.setState({ view: snapshot() });
  }, PUBLISH_MS);
}

/** Empties the buffers (the connection's state stays: it describes the socket, not what it received). */
export function clearCapture(): void {
  frames.clear();
  calls.clear();
  streams.clear();
  wsTypes.clear();
  renders.clear();
  resources.clear();
  samples.clear();
  storeChanges.clear();
  storeStats.clear();
  shiftWindow = undefined;
  perf = emptyPerf();
  errors = 0;
  seenErrors = 0;
  useDebugCapture.setState({ view: snapshot() });
}

export function setPaused(paused: boolean): void {
  useDebugCapture.setState(paused ? { paused } : { paused, view: snapshot() });
}

/** The errors so far are seen: the button's badge goes. */
export function markErrorsSeen(): void {
  seenErrors = errors;
  useDebugCapture.setState((s) => ({ view: { ...s.view, unseenErrors: 0 } }));
}

export const isDebugEnabled = () => enabled;

type Seed = () => void;
const seeds = new Set<Seed>();

/**
 * Runs `seed` each time the capture starts (the socket tells its current state), and once now if it runs: what
 * happened before the debug mode was turned on is not captured, the state of now is.
 */
export function onCaptureStart(seed: Seed): () => void {
  seeds.add(seed);
  if (enabled) seed();
  return () => seeds.delete(seed);
}

const stops = new Set<() => void>();

/** Runs `stop` each time the capture stops (what a start subscribed to is let go). */
export function onCaptureStop(stop: () => void): () => void {
  stops.add(stop);
  return () => stops.delete(stop);
}

/** Starts the capture from empty, or stops it and drops what it held. */
export function setDebugEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (!on) for (const stop of stops) stop();
  ws = { status: ws.status, url: ws.url, reconnects: 0, bootIds: [] };
  clearCapture();
  if (on) for (const seed of seeds) seed();
  else {
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    publishTimer = undefined;
    useDebugCapture.setState({ view: emptyView(), paused: false });
  }
}

// --- WebSocket ---

export const debugWs = {
  status(status: WsConnection['status'], url: string): void {
    if (!enabled) return;
    const next: WsConnection = { ...ws, status, url };
    if (status === 'open') {
      delete next.retryMs;
      next.openedAt = Date.now();
    }
    ws = next;
    changed();
  },
  closed(close: { code: number; reason: string; clean: boolean }, retryMs: number): void {
    if (!enabled) return;
    const next: WsConnection = { ...ws, status: 'closed', retryMs, lastClose: { at: Date.now(), ...close } };
    delete next.openedAt;
    ws = next;
    changed();
  },
  reconnecting(): void {
    if (!enabled) return;
    ws = { ...ws, reconnects: ws.reconnects + 1 };
    changed();
  },
  /** A frame received (`msg` decoded, or `error` for why not) or sent. */
  frame(dir: WsFrame['dir'], raw: string, msg: WsMessage | undefined, error?: string): void {
    if (!enabled) return;
    const at = Date.now();
    const type = msg?.type ?? '?';
    const size = raw.length;
    const frame: WsFrame = { id: nextId++, at, dir, type, size, data: msg ?? raw };
    if (error !== undefined) {
      frame.error = error;
      errors++;
    }
    frames.push(frame);
    if (dir === 'in') {
      let t = wsTypes.get(type);
      if (!t) {
        t = { count: 0, bytes: 0, samples: [] };
        wsTypes.set(type, t);
      }
      t.count++;
      t.bytes += size;
      t.samples.push([at, size]);
      rate(t.samples, at);
    }
    if (msg?.type === 'hello') {
      const last = ws.bootIds.at(-1);
      ws = {
        ...ws,
        clockOffsetMs: msg.payload.serverTime - at,
        bootIds:
          last?.bootId === msg.payload.bootId
            ? ws.bootIds
            : [...ws.bootIds, { at, bootId: msg.payload.bootId }].slice(-20),
      };
    }
    changed();
  },
};

// --- HTTP and SSE ---

/** The text of an event, as far as it carries some (`content`, `reasoning`). */
function textLength(event: unknown): number {
  let n = 0;
  for (const key of ['content', 'reasoning'])
    if (Predicate.hasProperty(event, key) && Predicate.isString(event[key])) n += event[key].length;
  return n;
}

/** The type of an event: its `type` or `event` field. */
function eventType(event: unknown): string {
  for (const key of ['type', 'event'])
    if (Predicate.hasProperty(event, key) && Predicate.isString(event[key])) return event[key];
  return 'event';
}

const DoneWithStats = Schema.Struct({ message: Schema.Struct({ stats: MessageStats }) });
const decodeDone = Schema.decodeUnknownOption(DoneWithStats);

/** llama-server's measures of a reply, when `event` is the chat's `done` and carries them. */
function streamStats(event: unknown): NonNullable<ApiCall['stream']>['stats'] {
  return Option.match(decodeDone(event), {
    onNone: () => undefined,
    onSome: ({ message: { stats: m } }) => ({
      ttftMs: m.ttftMs,
      promptTokens: m.promptTokens,
      cachedTokens: m.cachedTokens,
      genTokens: m.genTokens,
      ppTps: m.ppTps,
      tgTps: m.tgTps,
    }),
  });
}

/** The record of one call, given by `debugCall` while the capture runs. */
export interface DebugCallRecorder {
  request: (method: string, path: string, body?: unknown) => void;
  response: (status: number, bytes: number | undefined) => void;
  event: (event: unknown) => void;
  end: (state: 'ok' | 'error' | 'aborted', detail?: { tag?: string | undefined; reply?: unknown }) => void;
}

/** A recorder for a call about to run, or undefined when the capture is off. */
export function debugCall(stream = false): DebugCallRecorder | undefined {
  if (!enabled) return undefined;
  const start = now();
  const call: ApiCall = { id: nextId++, at: Date.now(), method: '?', path: '?', state: 'pending' };
  if (stream) call.stream = { events: 0, byType: {}, chars: 0, last: [] };
  calls.push(call);
  if (stream) streams.push(call);
  changed();
  return {
    request(method, path, body) {
      call.method = method;
      call.path = path;
      if (body !== undefined) call.request = body;
      changed();
    },
    response(status, bytes) {
      call.status = status;
      call.headersMs = now() - start;
      if (bytes !== undefined) call.bytes = bytes;
      changed();
    },
    event(event) {
      const s = call.stream;
      if (!s) return;
      s.firstEventMs ??= now() - start;
      s.events++;
      const type = eventType(event);
      s.byType[type] = (s.byType[type] ?? 0) + 1;
      s.chars += textLength(event);
      const stats = streamStats(event);
      if (stats) s.stats = stats;
      s.last.push({ at: Date.now(), type, data: event });
      if (s.last.length > STREAM_EVENTS) s.last.splice(0, s.last.length - STREAM_EVENTS);
      changed();
    },
    end(state, detail) {
      call.state = state;
      call.ms = now() - start;
      if (detail?.tag !== undefined) call.tag = detail.tag;
      if (detail && 'reply' in detail) call.reply = detail.reply;
      if (state === 'error') errors++;
      changed();
    },
  };
}

// --- Renders and performance ---

/** A commit of a `<Profiler>` (development builds only: React does not time renders in production). */
export function debugRender(id: string, phase: string, actualMs: number, baseMs: number): void {
  if (!enabled) return;
  let r = renders.get(id);
  if (!r) {
    r = { id, commits: 0, mounts: 0, sumMs: 0, maxMs: 0, lastMs: 0, baseMs: 0, sinceNavigation: 0 };
    renders.set(id, r);
  }
  r.commits++;
  if (phase === 'mount') r.mounts++;
  r.sumMs += actualMs;
  r.maxMs = Math.max(r.maxMs, actualMs);
  r.lastMs = actualMs;
  r.baseMs = baseMs;
  r.sinceNavigation++;
  changed();
}

/** A navigation that took `ms`, from its start to its page rendered (its chunk and its loader included). */
export function debugNavigation(path: string, ms: number | undefined): void {
  if (!enabled) return;
  perf = { ...perf, navigations: [...perf.navigations, { at: Date.now(), path, ms }].slice(-NAVIGATIONS) };
  for (const r of renders.values()) r.sinceNavigation = 0;
  changed();
}

export function debugLongTask(ms: number): void {
  if (!enabled) return;
  const t = perf.longTasks;
  perf = { ...perf, longTasks: { count: t.count + 1, totalMs: t.totalMs + ms, worstMs: Math.max(t.worstMs, ms) } };
  changed();
}

export function debugInteraction(name: string, ms: number): void {
  if (!enabled) return;
  const i = perf.interactions;
  const worst = i.worst && i.worst.ms >= ms ? i.worst : { ms, name };
  perf = { ...perf, interactions: { count: i.count + 1, worst, last: { ms, name } } };
  changed();
}

/** The largest contentful paint so far: the last entry the browser gives is the largest. */
export function debugLcp(ms: number, element: string): void {
  if (!enabled) return;
  perf = { ...perf, lcp: { ms, element } };
  changed();
}

/** The session window of the layout shifts in progress. */
let shiftWindow: { start: number; last: number; value: number } | undefined;

/**
 * Adds a shift to its session window: a shift less than 1 s after the previous one and less than 5 s after the
 * window's first joins it, else it opens a new one. The worst window is the CLS.
 */
export function addShift(
  current: { start: number; last: number; value: number } | undefined,
  at: number,
  value: number,
): { start: number; last: number; value: number } {
  if (current && at - current.last < 1000 && at - current.start < 5000)
    return { start: current.start, last: at, value: current.value + value };
  return { start: at, last: at, value };
}

/** A layout shift without a recent input, at `at` (ms of the page's clock). */
export function debugLayoutShift(at: number, value: number): void {
  if (!enabled) return;
  shiftWindow = addShift(shiftWindow, at, value);
  const s = perf.layoutShifts;
  perf = {
    ...perf,
    layoutShifts: {
      count: s.count + 1,
      total: s.total + value,
      worstWindow: Math.max(s.worstWindow, shiftWindow.value),
    },
  };
  changed();
}

export function debugFrameSample(fps: number, heap: number | undefined): void {
  if (!enabled) return;
  samples.push(heap === undefined ? { at: Date.now(), fps } : { at: Date.now(), fps, heap });
  changed();
}

export function debugResource(resource: Omit<LoadedResource, 'id'>): void {
  if (!enabled) return;
  resources.push({ id: nextId++, ...resource });
  changed();
}

// --- Stores ---

/** The top-level keys whose value is not the same in `next` as in `prev` (a store's actions are left out). */
export function changedKeys(prev: object, next: object): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => {
    const before: unknown = Reflect.get(prev, k);
    const after: unknown = Reflect.get(next, k);
    return typeof before !== 'function' && typeof after !== 'function' && !Object.is(before, after);
  });
}

/** A store's `set()`, from its subscription (`lib/debug/stores.ts`). */
export function debugStoreChange(store: string, next: unknown, prev: unknown): void {
  if (!enabled) return;
  if (typeof next !== 'object' || next === null || typeof prev !== 'object' || prev === null) return;
  let stats = storeStats.get(store);
  if (!stats) {
    stats = { changes: 0, noops: 0, samples: [] };
    storeStats.set(store, stats);
  }
  const keys = changedKeys(prev, next);
  if (keys.length === 0) {
    stats.noops++;
  } else {
    const at = Date.now();
    const pick = (state: object) => Object.fromEntries(keys.map((k): [string, unknown] => [k, Reflect.get(state, k)]));
    stats.changes++;
    stats.last = at;
    stats.samples.push([at, 0]);
    let ring = storeChanges.get(store);
    if (!ring) {
      ring = new Ring<StoreChange>(STORE_CHANGES);
      storeChanges.set(store, ring);
    }
    ring.push({ id: nextId++, at, store, keys, prev: pick(prev), next: pick(next) });
  }
  changed();
}
