import type { WsMessage } from '@llama-webui/shared';
import { Predicate } from 'effect';
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
  /** The decoded reply. */
  reply?: unknown;
  stream?: {
    firstEventMs?: number;
    events: number;
    byType: Record<string, number>;
    /** Characters of text received (`content` and `reasoning` of the events). */
    chars: number;
    last: StreamEvent[];
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
  /** Rejected frames and failed calls since the window was last looked at. */
  unseenErrors: number;
}

const now = () => performance.now();

let enabled = false;
let nextId = 1;
const frames = new Ring<WsFrame>(WS_FRAMES);
const calls = new Ring<ApiCall>(API_CALLS);
const streams = new Ring<ApiCall>(SSE_STREAMS);
const wsTypes = new Map<string, { count: number; bytes: number; samples: [number, number][] }>();
const renders = new Map<string, RenderStats>();
let ws: WsConnection = { status: 'connecting', url: '', reconnects: 0, bootIds: [] };
let perf: PerfStats = { longTasks: { count: 0, totalMs: 0, worstMs: 0 }, interactions: { count: 0 }, navigations: [] };
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
  perf: { longTasks: { count: 0, totalMs: 0, worstMs: 0 }, interactions: { count: 0 }, navigations: [] },
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
    },
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
  perf = { longTasks: { count: 0, totalMs: 0, worstMs: 0 }, interactions: { count: 0 }, navigations: [] };
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

/** Starts the capture from empty, or stops it and drops what it held. */
export function setDebugEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
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

/** The record of one call, given by `debugCall` while the capture runs. */
export interface DebugCallRecorder {
  request: (method: string, path: string) => void;
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
    request(method, path) {
      call.method = method;
      call.path = path;
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
