import { Predicate } from 'effect';
import {
  debugFrameSample,
  debugInteraction,
  debugLayoutShift,
  debugLcp,
  debugLongTask,
  debugResource,
  SAMPLE_MS,
} from './capture';

/** An interaction shorter than this is not reported by the browser (event timing's minimum is 16 ms). */
const INTERACTION_MIN_MS = 40;

let observers: PerformanceObserver[] = [];

/** Observes `type` if the browser supports it (long tasks: Chromium only). */
function observe(type: string, onEntry: (entry: PerformanceEntry) => void, options: PerformanceObserverInit = {}) {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes.includes(type)) return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onEntry(entry);
  });
  observer.observe({ type, buffered: false, ...options });
  observers.push(observer);
}

/** What the API calls fetch is in the HTTP tab; the rest of what the page loads is a resource. */
const API_INITIATORS = new Set(['fetch', 'xmlhttprequest', 'beacon']);

/** A URL of the page's origin as its path, another one whole. */
function shortName(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === location.origin ? u.pathname + u.search : url;
  } catch {
    return url;
  }
}

/** The element an LCP entry points at: its tag and id, the file of an image (its classes are utilities). */
function describe(element: unknown): string {
  if (!(element instanceof Element)) return 'removed element';
  const id = element.id ? `#${element.id}` : '';
  const src = element instanceof HTMLImageElement ? ` ${shortName(element.currentSrc)}` : '';
  return element.tagName.toLowerCase() + id + src;
}

/**
 * Long tasks, interactions, layout shifts, the largest paint and the files loaded, while the debug mode is on. The
 * largest paint, the shifts and the files come with those the browser kept from the page's load (`buffered`).
 */
export function startPerfObservers(): void {
  if (observers.length > 0) return;
  observe('largest-contentful-paint', (entry) => debugLcp(entry.startTime, describe(Reflect.get(entry, 'element'))), {
    buffered: true,
  });
  observe(
    'layout-shift',
    (entry) => {
      const value: unknown = Reflect.get(entry, 'value');
      // A shift right after an input (a click that opens a panel) is expected, and not counted.
      if (Reflect.get(entry, 'hadRecentInput') !== true && Predicate.isNumber(value))
        debugLayoutShift(entry.startTime, value);
    },
    { buffered: true },
  );
  observe(
    'resource',
    (entry) => {
      if (!(entry instanceof PerformanceResourceTiming) || API_INITIATORS.has(entry.initiatorType)) return;
      debugResource({
        at: performance.timeOrigin + entry.startTime,
        name: shortName(entry.name),
        type: entry.initiatorType,
        transferBytes: entry.transferSize,
        bytes: entry.decodedBodySize,
        ms: entry.duration,
        cached: entry.transferSize === 0 && entry.decodedBodySize > 0,
      });
    },
    { buffered: true },
  );
  observe('longtask', (entry) => debugLongTask(entry.duration));
  observe(
    'event',
    (entry) => {
      // An interaction (a click, a key) has an id; a hover or a scroll has none.
      if ('interactionId' in entry && typeof entry.interactionId === 'number' && entry.interactionId > 0)
        debugInteraction(entry.name, entry.duration);
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `durationThreshold` is in the spec and Chromium, not yet in TypeScript's DOM types
    { durationThreshold: INTERACTION_MIN_MS } as PerformanceObserverInit,
  );
}

export function stopPerfObservers(): void {
  for (const o of observers) o.disconnect();
  observers = [];
}

/** The JS heap in use, where the browser tells it (Chromium). */
export function heapUsed(): { used: number; limit: number } | undefined {
  const memory: unknown = Reflect.get(performance, 'memory');
  if (typeof memory !== 'object' || memory === null) return undefined;
  const used: unknown = Reflect.get(memory, 'usedJSHeapSize');
  const limit: unknown = Reflect.get(memory, 'jsHeapSizeLimit');
  return Predicate.isNumber(used) && Predicate.isNumber(limit) ? { used, limit } : undefined;
}

/** Samples the frame rate and the heap every `SAMPLE_MS` until the returned function is called. */
export function startFrameSampler(): () => void {
  let frames = 0;
  let from = performance.now();
  let id = requestAnimationFrame(function tick(t) {
    frames++;
    if (t - from >= SAMPLE_MS) {
      debugFrameSample((frames * 1000) / (t - from), heapUsed()?.used);
      frames = 0;
      from = t;
    }
    id = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(id);
}
